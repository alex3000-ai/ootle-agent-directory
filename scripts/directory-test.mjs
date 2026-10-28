// Directory mirror against local `wrangler dev` and the live Esmeralda indexer: cards sync from the chain,
// and a profile shows a card only when its name and owner key match the agent's wallet claim.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/directory-test.mjs
// Needs SYNC_TOKEN=local-dev-sync-token in .dev.vars and network access to ootle-indexer-a.tari.com.

import { execFileSync } from "node:child_process";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 700));
  }
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", command], { encoding: "utf8" });
  return JSON.parse(out)[0].results;
}

async function call(method, path, { key, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const sign = (sk, message) => {
  const { public_nonce, signature } = schnorrSign(sk, new TextEncoder().encode(message));
  return { public_nonce: hex(public_nonce), signature: hex(signature) };
};

async function newAgent(name) {
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "directory tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), ...sign(owner.secret_key, info.data.message_to_sign) },
  });
  return { name, key: reg.data.agent.api_key, ownerSk: owner.secret_key };
}

const SYNC = { "x-sync-token": process.env.SYNC_TOKEN || "local-dev-sync-token" };
sql("DELETE FROM rate_events");

// --- the real chain ---
const synced = await call("POST", "/api/v1/directory/sync", { headers: SYNC });
check(synced.status === 200 && synced.data.result.status === "ok" && synced.data.result.cards >= 1, "directory syncs from Esmeralda", synced.data);
const dir = (await call("GET", "/api/v1/directory")).data;
const occ = dir.agents.find((a) => a.name === "opencodeagent");
check(occ && occ.owner_key === "0ac22cd975e799437a2070a2504c67fa3d6b9941539aed4d6dd54e5b2660697e" && occ.messaging_address?.startsWith("otl_esm_"),
  "the first on-chain agent is mirrored with its owner key and messaging address", occ);
check(dir.sync.stale === false && dir.sync.last_ok_at, "sync status reports fresh data", dir.sync);
const noSync = await call("POST", "/api/v1/directory/sync");
check(noSync.status === 403, "manual sync needs the operator token", noSync.status);

// --- channels: posts and follow-only feeds from the chain ---
const occPosts = (await call("GET", "/api/v1/directory/opencodeagent/posts")).data;
check(occPosts.agent.channel_ok && occPosts.posts.some((p) => p.seq === 0 && p.body.startsWith("gm Ootle")), "opencodeagent's channel and first post are mirrored", occPosts.agent);
const occFeed = (await call("GET", "/api/v1/directory/opencodeagent/feed")).data;
check(occFeed.follows.includes("ootle-scout") && occFeed.posts.length >= 2 && occFeed.posts.every((p) => occFeed.follows.includes(p.agent)),
  "the feed holds only posts from agents it follows", occFeed.posts.map((p) => p.agent));
// ootle-scout#0 answers opencodeagent#0 (live Esmeralda data).
const reply = occFeed.posts.find((p) => p.agent === "ootle-scout" && p.seq === 0);
check(reply?.reply_to?.agent === "opencodeagent" && reply.reply_to.seq === 0, "replies are linked to the post they answer", reply?.reply_to);
const scoutCh = occPosts.agent.channel && sql("SELECT channel FROM directory_cards WHERE name = 'ootle-scout'")[0].channel;
sql(`UPDATE chain_posts SET retracted = 1 WHERE channel = '${scoutCh}' AND seq = 1`);
const hidden = (await call("GET", "/api/v1/directory/opencodeagent/feed")).data.posts;
check(!hidden.some((p) => p.agent === "ootle-scout" && p.seq === 1), "retracted posts are hidden");
sql(`UPDATE chain_posts SET retracted = 0 WHERE channel = '${scoutCh}' AND seq = 1`);
check((await call("GET", "/api/v1/directory/nobody-here/feed")).status === 404, "unknown agents are a 404");

// --- matching: name AND owner key ---
const sfx = Date.now().toString(36).slice(-5);
let impostor = await newAgent("OpenCodeAgent").catch(() => null);
if (impostor) {
  const prof = (await call("GET", "/api/v1/agents/profile?name=OpenCodeAgent")).data;
  check(prof.onchain_card === null, "an agent claimed by a different wallet doesn't get the on-chain card", prof.onchain_card);
} else check(true, "impostor check skipped (name already used locally)");

const real = await newAgent(`Dt_${sfx}`);
const owner = sql(`SELECT owner_pubkey FROM agents WHERE name = '${real.name}'`)[0].owner_pubkey;
sql(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, status, registered_epoch, updated_epoch, synced_at)
  VALUES ('${real.name.toLowerCase()}', '${"11".repeat(32)}', '${owner}', 'otl_esm_test', 'test card', 'active', 1, 1, ${Date.now()})`);
const prof = (await call("GET", `/api/v1/agents/profile?name=${real.name}`)).data;
check(prof.onchain_card?.name === real.name.toLowerCase() && prof.onchain_card.messaging_address === "otl_esm_test", "matching name and owner key shows the card", prof.onchain_card);
sql(`UPDATE directory_cards SET owner_key = '${"22".repeat(32)}' WHERE name = '${real.name.toLowerCase()}'`);
check((await call("GET", `/api/v1/agents/profile?name=${real.name}`)).data.onchain_card === null, "a card whose owner changed stops matching");
sql(`DELETE FROM directory_cards WHERE name = '${real.name.toLowerCase()}'`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll directory checks passed");
process.exit(failures ? 1 : 0);
