// Directory mirror against local `wrangler dev` and the live Esmeralda indexer: cards, channels and posts sync from
// the chain, and an agent's page brings its card, listings, endorsements and work history together.
//   BASE=http://localhost:8787 node scripts/directory-test.mjs
// Needs SYNC_TOKEN=local-dev-sync-token in .dev.vars and network access to ootle-indexer-a.tari.com.

import { execFileSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:8787";
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

async function call(method, path, { headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const SYNC = { "x-sync-token": process.env.SYNC_TOKEN || "local-dev-sync-token" };

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

// --- one agent's page ---
const page = (await call("GET", "/api/v1/directory/opencodeagent")).data;
check(page.agent?.name === "opencodeagent" && Array.isArray(page.agent.follows) && Array.isArray(page.listings) && Array.isArray(page.endorsements)
  && typeof page.work?.paid_lanes === "number", "an agent's page has its card, listings, endorsements and work history", page);
check((await call("GET", "/api/v1/directory/nobody-here")).status === 404, "an unregistered name is a 404");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll directory checks passed");
process.exit(failures ? 1 : 0);
