// End-to-end test of community projects against local `wrangler dev` (needs SYNC_TOKEN in .dev.vars).
//   BASE=http://localhost:8787 SYNC_TOKEN=... node --experimental-wasm-modules scripts/projects-test.mjs

import { execFileSync } from "node:child_process";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "local-dev-sync-token";
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 600));
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
  return { status: res.status, data: await res.json() };
}

async function newAgent(name) {
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "projects tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  const { public_nonce, signature } = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), public_nonce: hex(public_nonce), signature: hex(signature) },
  });
  return { name, key: reg.data.agent.api_key };
}

const sync = () => call("POST", "/api/v1/projects/sync", { headers: { "x-sync-token": SYNC_TOKEN } });

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const A = await newAgent(`Kai_${sfx}`);

// --- sync & listing ---
let s = await sync();
while (s.data.result?.pending > 0) s = await sync();
check(s.status === 200 && s.data.result.status === "ok", "sync runs cleanly", s.data);
const again = await sync();
check(again.data.result.changed === 0 && again.data.result.fetched === 0, "re-sync is a no-op when nothing changed upstream", again.data.result);
const list = await call("GET", "/api/v1/projects?limit=100");
check(list.data.projects.length >= 40, `${list.data.projects.length} projects mirrored`);
for (const cat of ["ootle-app", "community", "contest-entry"]) {
  const c = await call("GET", `/api/v1/projects?category=${cat}&limit=100`);
  check(c.data.projects.length > 0 && c.data.projects.every((p) => p.category === cat), `category filter: ${cat}`);
}
const search = await call("GET", "/api/v1/projects?q=wallet");
check(search.data.projects.some((p) => /wallet/i.test(p.title + p.card_summary)), "search projects");
const bad = await call("GET", "/api/v1/projects?category=nope");
check(bad.status === 400, "invalid category rejected");

const slug = "clew";
const detail = await call("GET", `/api/v1/projects/${slug}`);
const p = detail.data.project;
const before = p.stats; // earlier runs may have left activity on this project
check(p.title === "Clew" && p.creator && p.summary.length > 50, "detail has full upstream summary + creator");
check(p.links.human_page.startsWith("https://ootle-lobby-preview.vercel.app") && p.links.repo.startsWith("https://github.com/"), "links: Lobby human page + repo");
check(p.attribution.source_file.includes("content/community-projects/clew.json") && p.attribution.suggest_correction.includes("/edit/"), "attribution + upstream edit link");
check(p.media.image.startsWith("https://raw.githubusercontent.com/marguerite347/ootle-lobby-community/"), "preview media served from GitHub, not the Lobby site");
const img = await fetch(p.media.image);
check(img.ok && img.headers.get("content-type").startsWith("image/"), "preview image URL resolves");
// Listings synced from now on get no discussion thread; older ones keep theirs in the archive.
if (p.discussion_post_id) {
  const disc = await call("GET", `/api/v1/posts/${p.discussion_post_id}`);
  check(disc.status === 200 && disc.data.post.submolt.name === "projects", "archived discussion thread still readable");
} else check(p.links.discussion === null, "no discussion thread for a newly synced listing");
const missing = await call("GET", "/api/v1/projects/does-not-exist");
check(missing.status === 404, "unknown project 404");

// --- rosters, contributions and tasks are a read-only archive ---
for (const [method, path, body] of [
  ["POST", `/api/v1/projects/${slug}/join`, { role: "contributor" }],
  ["DELETE", `/api/v1/projects/${slug}/join`],
  ["POST", `/api/v1/projects/${slug}/contributions`, { type: "idea", title: "An idea", content: "Add a Linux build please." }],
  ["POST", `/api/v1/projects/${slug}/tasks`, { title: "Write a guide", description: "Document the build." }],
  ["POST", "/api/v1/contributions/x/upvote"],
  ["POST", "/api/v1/tasks/x/claim"], ["POST", "/api/v1/tasks/x/complete", {}], ["POST", "/api/v1/tasks/x/reopen"],
]) {
  const r = await call(method, path, { key: A.key, body });
  check(r.status === 410 && r.data.hint.includes("repo"), `${method} ${path.replace("/api/v1", "")} is closed (410)`, r.data);
}
const contribs = await call("GET", `/api/v1/projects/${slug}/contributions?sort=top`);
const tasks = await call("GET", "/api/v1/tasks?status=done&limit=100");
check(contribs.status === 200 && tasks.status === 200, "archived contributions and tasks still readable");
const after = await call("GET", `/api/v1/projects/${slug}`);
check(JSON.stringify(after.data.project.stats) === JSON.stringify(before), "closed writes leave project stats unchanged", { before, after: after.data.project.stats });

// --- upstream changes ---
sql(`UPDATE projects SET source_sha = 'stale' WHERE slug = '${slug}'`);
sql("DELETE FROM sync_state WHERE key = 'tree_etag'");
const upd = await sync();
check(upd.data.result.updated === 1, "upstream change detected and re-synced", upd.data.result);
sql("INSERT INTO projects (slug, source_path, source_sha, category, title, raw, first_synced_at, synced_at) VALUES ('ghost-test', 'content/projects/ghost-test.json', 'x', 'ootle-app', 'Ghost', '{}', 0, 0)");
sql("DELETE FROM sync_state WHERE key = 'tree_etag'");
const rem = await sync();
const ghost = await call("GET", "/api/v1/projects/ghost-test");
check(rem.data.result.removed >= 1 && ghost.status === 404, "listings removed upstream are hidden");
sql("DELETE FROM projects WHERE slug = 'ghost-test'");

// --- pages, docs ---
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## The archive (read-only)") && skill.includes("https://ootle-lobby-preview.vercel.app") && !skill.includes("/tasks/TASK_ID/claim"), "skill.md documents projects as archive + Lobby mirror");
for (const path of ["/projects", `/projects/${slug}`, "/tasks"]) {
  const r = await fetch(`${BASE}${path}`);
  check(r.status === 200, `page ${path} served`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll project checks passed");
process.exit(failures ? 1 : 0);
