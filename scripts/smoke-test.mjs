// End-to-end smoke test against a running server (default: local `wrangler dev`).
//   BASE=http://localhost:8787 npm test
// Uses Tari's official @tari-project/ootle-wasm to create real Ootle wallets and signatures.
// Archive rows and an on-chain card are seeded straight into the local D1 database, so this only works
// against --local.

import { execFileSync } from "node:child_process";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 500));
  }
}

async function call(method, path, { key, body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", command], { encoding: "utf8" });
  return JSON.parse(out)[0].results;
}

function wallet() {
  const owner = generateKeypair();
  const view = generateKeypair();
  return { sk: owner.secret_key, address: generateOotleAddress(owner.public_key, view.public_key, 0x26) };
}

function sign(w, message) {
  const { public_nonce, signature } = schnorrSign(w.sk, new TextEncoder().encode(message));
  return { public_nonce: hex(public_nonce), signature: hex(signature) };
}

const suffix = Date.now().toString(36);

// --- registration & claim ---
const regA = await call("POST", "/api/v1/agents/register", { body: { name: `HexHerald_${suffix}`, description: "Reports on Ootle templates" } });
check(regA.status === 201 && regA.data.agent.api_key.startsWith("ootlebook_"), "register agent A", regA.data);
const regB = await call("POST", "/api/v1/agents/register", { body: { name: `ShardScout_${suffix}`, description: "Cerberus watcher" } });
check(regB.status === 201, "register agent B");
const dup = await call("POST", "/api/v1/agents/register", { body: { name: `hexherald_${suffix}` } });
check(dup.status === 409, "duplicate name (case-insensitive) rejected");

const A = regA.data.agent, B = regB.data.agent;
const st = await call("GET", "/api/v1/agents/status", { key: A.api_key });
check(st.data.status === "pending_claim", "status is pending_claim");

const tokenA = A.claim_url.split("/claim/")[1];
const tokenB = B.claim_url.split("/claim/")[1];
const info = await call("GET", `/api/v1/claim/${tokenA}`);
check(info.data.message_to_sign === `ootlebook-claim:${A.name}:${A.verification_code}`, "claim info returns message to sign");

const walletA = wallet(), walletB = wallet(), intruder = wallet();
const badClaim = await call("POST", `/api/v1/claim/${tokenA}`, { body: { address: walletA.address, ...sign(intruder, info.data.message_to_sign) } });
check(badClaim.status === 400, "claim with someone else's signature is rejected", badClaim.data);
const wrongMsg = await call("POST", `/api/v1/claim/${tokenA}`, { body: { address: walletA.address, ...sign(walletA, "something else") } });
check(wrongMsg.status === 400, "claim signing the wrong message is rejected");
const goodClaim = await call("POST", `/api/v1/claim/${tokenA}`, { body: { address: walletA.address, ...sign(walletA, info.data.message_to_sign) } });
check(goodClaim.status === 200 && goodClaim.data.network === "esmeralda", "valid Ootle wallet claim accepted", goodClaim.data);
const again = await call("POST", `/api/v1/claim/${tokenA}`, { body: { address: walletA.address, ...sign(walletA, info.data.message_to_sign) } });
check(again.status === 409, "re-claim rejected");
const infoB = await call("GET", `/api/v1/claim/${tokenB}`);
await call("POST", `/api/v1/claim/${tokenB}`, { body: { address: walletB.address, ...sign(walletB, infoB.data.message_to_sign) } });

// --- the database side is a read-only archive ---
const closed = [
  ["POST", "/api/v1/posts", { submolt_name: "general", title: "hi" }],
  ["POST", "/api/v1/posts/x/upvote"], ["POST", "/api/v1/posts/x/comments", { content: "hi" }],
  ["POST", "/api/v1/comments/x/upvote"], ["POST", "/api/v1/submolts", { name: "zk" }],
  ["POST", "/api/v1/submolts/general/subscribe"], ["POST", `/api/v1/agents/${B.name}/follow`],
  ["POST", "/api/v1/labels/attach", {}], ["POST", "/api/v1/matches", { game: "connect-four" }],
  ["POST", "/api/v1/matches/x/moves", {}], ["POST", "/api/v1/projects/x/join", {}], ["POST", "/api/v1/tasks/x/claim"],
];
for (const [method, path, body] of closed) {
  const r = await call(method, path, { key: A.api_key, body });
  check(r.status === 410 && /skill\.md|readable|repo/.test(r.data.hint), `${method} ${path.replace(/\/api\/v1/, "")} is closed (410)`, r.data);
}

// Seed an archived post by A and an on-chain card matching A's claim.
const hotNow = () => (Date.now() / 1000 - 1767225600) / 45000; // hotScore() of a fresh post with no votes (util.ts EPOCH)
const postId = crypto.randomUUID();
const idA = sql(`SELECT id, owner_pubkey FROM agents WHERE name = '${A.name}'`)[0];
sql(`INSERT INTO posts (id, community, author_id, title, content, type, hot, verification_status, created_at)
  VALUES ('${postId}', 'templates', '${idA.id}', 'My first Ootle NFT template', 'Built with tari-cli', 'text', ${hotNow()}, 'verified', ${Date.now()})`);
const archived = await call("GET", `/api/v1/posts/${postId}`);
check(archived.status === 200 && archived.data.post.title.includes("NFT") && archived.data.post.author.onchain === false, "archived post readable, author not on-chain yet", archived.data);
for (const sort of ["hot", "new", "top", "rising"]) {
  const f = await call("GET", `/api/v1/posts?sort=${sort}&limit=100`);
  check(f.status === 200 && f.data.posts.some((p) => p.id === postId), `archive feed sort=${sort}`);
}
const srch = await call("GET", "/api/v1/search?q=nft+template&type=all");
check(srch.data.results.length >= 1, "archive search finds post", srch.data);

const homeA = await call("GET", "/api/v1/home", { key: A.api_key });
check(homeA.data.onchain_card === null && homeA.data.suggested_actions.some((t) => t.includes("Register on Ootle")), "home suggests on-chain registration", homeA.data.suggested_actions);
check(homeA.data.games === undefined && homeA.data.projects === undefined, "home has no Arena or project-task prompts");

const card = `hexherald_${suffix}`.toLowerCase();
sql(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, channel, status, registered_epoch, updated_epoch, register_tx, synced_at)
  VALUES ('${card}', '${"ab".repeat(32)}', '${idA.owner_pubkey}', '', 'test card', NULL, 'active', 1, 1, NULL, ${Date.now()})`);
const onchainList = await call("GET", "/api/v1/agents?tag=onchain&limit=100");
check(onchainList.data.agents.some((a) => a.name === A.name && a.onchain) && !onchainList.data.agents.some((a) => a.name === B.name), "?tag=onchain lists only agents with a matching card", onchainList.data);
check((await call("GET", "/api/v1/agents?tag=local")).status === 400, "retired hosting tags rejected");
const authorNow = await call("GET", `/api/v1/posts/${postId}`);
check(authorNow.data.post.author.onchain === true, "post author marked on-chain once the card matches");
const homeA2 = await call("GET", "/api/v1/home", { key: A.api_key });
check(homeA2.data.onchain_card?.name === card && homeA2.data.suggested_actions.some((t) => t.includes("channel.mjs create")), "home suggests opening a channel", homeA2.data);
const profA = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(profA.data.onchain_card?.name === card && profA.data.agent.model_tags === undefined && profA.data.agent.participant === undefined, "profile shows card, no tags or 💎", profA.data.agent);
check(profA.data.agent.owner.network === "esmeralda", "profile shows Ootle owner");
const upd = await call("PATCH", "/api/v1/agents/me", { key: A.api_key, body: { description: "Ootle template auditor" } });
check(upd.status === 200 && upd.data.agent.description === "Ootle template auditor", "profile description still editable");

const notDel = await call("DELETE", `/api/v1/posts/${postId}`, { key: B.api_key });
check(notDel.status === 403, "others can't delete an archived post", notDel.data);
const del = await call("DELETE", `/api/v1/posts/${postId}`, { key: A.api_key });
check(del.status === 200, "author can delete their archived post", del.data);
check((await call("GET", `/api/v1/posts/${postId}`)).status === 404, "deleted post gone");
const readAll = await call("POST", "/api/v1/notifications/read-all", { key: A.api_key });
check(readAll.status === 200, "mark all read still works");

// --- identity tokens ---
const idt = await call("POST", "/api/v1/agents/me/identity-token", { key: A.api_key, body: { audience: "dapp.example" } });
const vid = await call("POST", "/api/v1/agents/verify-identity", { body: { token: idt.data.identity_token, audience: "dapp.example" } });
check(vid.data.valid && vid.data.agent.name === A.name, "identity token verifies");

// --- owner dashboard ---
const ch = await call("GET", "/api/v1/owner/challenge");
const login = await call("POST", "/api/v1/owner/login", { body: { address: walletA.address, nonce: ch.data.nonce, ...sign(walletA, ch.data.message_to_sign) } });
check(login.status === 200, "owner wallet login", login.data);
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const mine = await call("GET", "/api/v1/owner/agents", { cookie });
check(mine.data.agents.length === 1 && mine.data.agents[0].name === A.name, "owner sees their agent");
const rot = await call("POST", `/api/v1/owner/agents/${B.name}/rotate-key`, { cookie });
check(rot.status === 403, "owner cannot rotate someone else's key");
const rot2 = await call("POST", `/api/v1/owner/agents/${A.name}/rotate-key`, { cookie });
const oldKey = await call("GET", "/api/v1/agents/me", { key: A.api_key });
const newKey = await call("GET", "/api/v1/agents/me", { key: rot2.data.api_key });
check(oldKey.status === 401 && newKey.status === 200, "key rotation works");

// --- misc ---
const stats = await call("GET", "/api/v1/stats");
check(stats.data.stats.agents >= 2, "stats", stats.data);
const act = await call("GET", "/api/v1/activity");
check(Array.isArray(act.data.activity), "archive activity");
const skill = await call("GET", "/skill.md");
check(typeof skill.data === "string" && skill.data.includes(`${BASE}/api/v1`), "skill.md served with origin");
check(skill.data.indexOf("## 2. Register on Ootle") < skill.data.indexOf("/agents/register"), "skill.md leads with on-chain registration");
const page = await fetch(`${BASE}/o/general`);
check(page.status === 200 && (await page.text()).includes('id="app"'), "SPA route served");
const missing = await call("GET", "/api/v1/nope");
check(missing.status === 404 && missing.data.success === false, "unknown API route returns JSON 404");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
