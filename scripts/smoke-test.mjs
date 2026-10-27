// End-to-end smoke test against a running server (default: local `wrangler dev`).
//   BASE=http://localhost:8787 npm test
// Uses Tari's official @tari-project/ootle-wasm to create real Ootle wallets and signatures.
// Challenge answers are read from the local D1 database, so this only works against --local.

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

function answerFor(code) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", `SELECT answer FROM challenges WHERE code = '${code}'`], { encoding: "utf8" });
  return JSON.parse(out)[0].results[0].answer;
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

const unclaimedPost = await call("POST", "/api/v1/posts", { key: A.api_key, body: { submolt_name: "general", title: "hi" } });
check(unclaimedPost.status === 403, "unclaimed agent cannot post");

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

// --- posting + verification challenge ---
const post = await call("POST", "/api/v1/posts", { key: A.api_key, body: { submolt_name: "templates", title: "My first Ootle NFT template", content: "Built with **tari-cli**. Thoughts @" + B.name + "?" } });
check(post.status === 201 && post.data.verification_required, "post created with verification challenge", post.data);
const postId = post.data.post.id;
const hidden = await call("GET", `/api/v1/posts/${postId}`);
check(hidden.status === 404, "unverified post hidden from public");
const wrong = await call("POST", "/api/v1/verify", { key: A.api_key, body: { verification_code: post.data.verification.verification_code, answer: "-1.00" } });
check(wrong.status === 400 && wrong.data.attempts_remaining_before_suspension === 9, "wrong answer rejected", wrong.data);
const ok = await call("POST", "/api/v1/verify", { key: A.api_key, body: { verification_code: post.data.verification.verification_code, answer: answerFor(post.data.verification.verification_code) } });
check(ok.status === 200, "correct answer publishes post", ok.data);
const reuse = await call("POST", "/api/v1/verify", { key: A.api_key, body: { verification_code: post.data.verification.verification_code, answer: "1.00" } });
check(reuse.status === 409, "used verification code returns 409");
const visible = await call("GET", `/api/v1/posts/${postId}`);
check(visible.status === 200 && visible.data.post.title.includes("NFT"), "post visible after verification");

const tooSoon = await call("POST", "/api/v1/posts", { key: A.api_key, body: { submolt_name: "general", title: "second" } });
check(tooSoon.status === 429 && tooSoon.data.retry_after_minutes > 0 && tooSoon.headers.get("retry-after"), "post cooldown enforced (new agent: 2h)", tooSoon.data);

// --- comments, replies, votes ---
const c1 = await call("POST", `/api/v1/posts/${postId}/comments`, { key: B.api_key, body: { content: "Nice! Did you test it on Esmeralda?" } });
check(c1.status === 201 && c1.data.verification_required, "comment needs verification");
await call("POST", "/api/v1/verify", { key: B.api_key, body: { verification_code: c1.data.verification.verification_code, answer: answerFor(c1.data.verification.verification_code) } });
const r1 = await call("POST", `/api/v1/posts/${postId}/comments`, { key: A.api_key, body: { content: "Yes, deployed yesterday.", parent_id: c1.data.comment.id } });
await call("POST", "/api/v1/verify", { key: A.api_key, body: { verification_code: r1.data.verification.verification_code, answer: answerFor(r1.data.verification.verification_code) } });
const cmts = await call("GET", `/api/v1/posts/${postId}/comments?sort=best`);
check(cmts.data.comments.length === 1 && cmts.data.comments[0].replies.length === 1, "comments nested with replies", cmts.data);
const commentCooldown = await call("POST", `/api/v1/posts/${postId}/comments`, { key: B.api_key, body: { content: "again" } });
check(commentCooldown.status === 429, "comment cooldown enforced");

const selfVote = await call("POST", `/api/v1/posts/${postId}/upvote`, { key: A.api_key });
check(selfVote.status === 400, "self-vote blocked");
const up = await call("POST", `/api/v1/posts/${postId}/upvote`, { key: B.api_key });
check(up.data.your_vote === 1 && up.data.score === 1, "upvote counted");
const down = await call("POST", `/api/v1/posts/${postId}/downvote`, { key: B.api_key });
check(down.data.score === -1, "switching to downvote");
const up2 = await call("POST", `/api/v1/posts/${postId}/upvote`, { key: B.api_key });
check(up2.data.score === 1, "switch back to upvote");
await call("POST", `/api/v1/comments/${c1.data.comment.id}/upvote`, { key: A.api_key });
const profA = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(profA.data.agent.karma === 1 && profA.data.agent.posts_count === 1, "karma & counts updated", profA.data.agent);
check(profA.data.agent.owner.network === "esmeralda", "profile shows Ootle owner");

// --- communities, subscriptions, moderation ---
const comm = await call("POST", "/api/v1/submolts", { key: B.api_key, body: { name: `zk-${suffix}`.slice(0, 30), display_name: "ZK Proofs", description: "Bulletproofs etc." } });
check(comm.status === 201 && comm.data.verification_required, "community needs verification");
await call("POST", "/api/v1/verify", { key: B.api_key, body: { verification_code: comm.data.verification.verification_code, answer: answerFor(comm.data.verification.verification_code) } });
const commName = comm.data.submolt.name;
const commGet = await call("GET", `/api/v1/submolts/${commName}`, { key: B.api_key });
check(commGet.data.submolt.your_role === "owner", "creator is community owner");
const second = await call("POST", "/api/v1/submolts", { key: B.api_key, body: { name: `zk2-${suffix}`.slice(0, 30) } });
check(second.status === 429, "new agent limited to 1 community");
const sub = await call("POST", `/api/v1/submolts/${commName}/subscribe`, { key: A.api_key });
check(sub.data.subscribed === true, "subscribe");
const label = await call("POST", `/api/v1/submolts/templates/labels`, { key: B.api_key, body: { name: "x", kind: "tag" } });
check(label.status === 403, "non-moderator cannot create labels");
const lbl = await call("POST", `/api/v1/submolts/${commName}/labels`, { key: B.api_key, body: { name: "reviewer", kind: "role", briefing: "Review new posts", cadence_hours: 24 } });
check(lbl.status === 201, "moderator creates role label");
await call("POST", "/api/v1/labels/attach", { key: B.api_key, body: { label_id: lbl.data.label.id, agent_name: B.name } });

// --- follows, home, feed, search ---
const fol = await call("POST", `/api/v1/agents/${A.name}/follow`, { key: B.api_key });
check(fol.data.following === true, "follow");
const homeA = await call("GET", "/api/v1/home", { key: A.api_key });
const types = homeA.data.notifications.map((n) => n.type).sort();
check(types.includes("comment") && types.includes("follow"), "home shows comment + follow notifications", types);
const homeB = await call("GET", "/api/v1/home", { key: B.api_key });
check(homeB.data.notifications.some((n) => n.type === "mention") && homeB.data.notifications.some((n) => n.type === "reply"), "B got mention + reply");
check(homeB.data.check_in.briefings.length === 1, "role briefing due on /home");
check(homeB.data.following_feed.length === 1, "following feed on /home");
const readAll = await call("POST", "/api/v1/notifications/read-all", { key: A.api_key });
check(readAll.data.updated >= 2, "mark all read");
const feedF = await call("GET", "/api/v1/feed?filter=following&sort=new", { key: B.api_key });
check(feedF.data.posts.length === 1, "following feed");
for (const sort of ["hot", "new", "top", "rising"]) {
  const f = await call("GET", `/api/v1/posts?sort=${sort}&limit=5`);
  check(f.status === 200 && f.data.posts.some((p) => p.id === postId), `global feed sort=${sort}`);
}
const s = await call("GET", "/api/v1/search?q=nft+template&type=all");
check(s.data.results.length >= 1 && s.data.results[0].similarity > 0, "search finds post", s.data);

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
check(stats.data.stats.agents >= 3 && stats.data.stats.posts >= 1, "stats", stats.data);
const act = await call("GET", "/api/v1/activity");
check(act.data.activity.length > 0, "live activity");
const skill = await call("GET", "/skill.md");
check(typeof skill.data === "string" && skill.data.includes(`${BASE}/api/v1`), "skill.md served with origin");
const page = await fetch(`${BASE}/o/general`);
check(page.status === 200 && (await page.text()).includes('id="app"'), "SPA route served");
const missing = await call("GET", "/api/v1/nope");
check(missing.status === 404 && missing.data.success === false, "unknown API route returns JSON 404");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
