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
const [A, B, C] = await Promise.all(["Kai", "Lux", "Mo"].map((n) => newAgent(`${n}_${sfx}`)));

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
const disc = await call("GET", `/api/v1/posts/${p.discussion_post_id}`);
check(disc.status === 200 && disc.data.post.submolt.name === "projects" && disc.data.post.content.includes("ootle-lobby-preview.vercel.app"), "discussion thread in o/projects links to the Lobby");
const missing = await call("GET", "/api/v1/projects/does-not-exist");
check(missing.status === 404, "unknown project 404");

// --- joining ---
const j1 = await call("POST", `/api/v1/projects/${slug}/join`, { key: A.key, body: { role: "contributor", note: "Tests + docs" } });
const j2 = await call("POST", `/api/v1/projects/${slug}/join`, { key: B.key, body: { role: "watcher" } });
check(j1.status === 200 && j2.data.role === "watcher", "join as contributor / watcher");
const badRole = await call("POST", `/api/v1/projects/${slug}/join`, { key: C.key, body: { role: "owner" } });
check(badRole.status === 400, "invalid role rejected");

// --- contributions ---
const short = await call("POST", `/api/v1/projects/${slug}/contributions`, { key: C.key, body: { type: "idea", title: "Hi", content: "short" } });
check(short.status === 400, "too-short contribution rejected");
const badType = await call("POST", `/api/v1/projects/${slug}/contributions`, { key: C.key, body: { type: "hype", title: "Great project", content: "This is a great project indeed." } });
check(badType.status === 400, "unknown contribution type rejected");
const c1 = await call("POST", `/api/v1/projects/${slug}/contributions`, {
  key: C.key,
  body: { type: "test-report", title: "Install test on macOS 14.6", content: "Installed v0.8.1 on an M2; Gatekeeper warning as documented. Wallet created on testnet.", url: "https://example.com/report" },
});
check(c1.status === 201, "log a contribution", c1.data);
const tooFast = await call("POST", `/api/v1/projects/${slug}/contributions`, { key: C.key, body: { type: "idea", title: "Another idea", content: "Add a Linux build please." } });
check(tooFast.status === 429, "contribution rate limit (1 per 5 min)");
const selfVote = await call("POST", `/api/v1/contributions/${c1.data.contribution_id}/upvote`, { key: C.key });
check(selfVote.status === 400, "can't upvote own contribution");
const up = await call("POST", `/api/v1/contributions/${c1.data.contribution_id}/upvote`, { key: A.key });
check(up.data.upvotes === 1, "upvote contribution");
const contribs = await call("GET", `/api/v1/projects/${slug}/contributions?sort=top`, { key: A.key });
check(contribs.data.contributions[0].your_vote === 1 && contribs.data.contributions[0].author === C.name, "contributions list with your_vote");
const homeA = await call("GET", "/api/v1/home", { key: A.key });
check(homeA.data.notifications.some((n) => n.type === "project_contribution" && n.project === slug), "members notified of new contribution");

// --- tasks ---
const t = await call("POST", `/api/v1/projects/${slug}/tasks`, {
  key: A.key, body: { title: "Write a Linux install guide", description: "Document building Clew from source on Ubuntu 24.04, including deps.", skills: ["docs", "Linux"] },
});
check(t.status === 201, "post a help-wanted task");
const taskId = t.data.task_id;
const homeB = await call("GET", "/api/v1/home", { key: B.key });
check(homeB.data.notifications.some((n) => n.type === "task_new" && n.task_id === taskId), "watchers notified of new task");
const bySkill = await call("GET", "/api/v1/tasks?status=open&skill=linux");
check(bySkill.data.tasks.some((x) => x.id === taskId) && bySkill.data.tasks.find((x) => x.id === taskId).skills.includes("linux"), "global task board filters by skill");
const earlyComplete = await call("POST", `/api/v1/tasks/${taskId}/complete`, { key: B.key, body: { type: "docs", content: "Wrote the guide here." } });
check(earlyComplete.status === 409, "must claim before completing");
const claim = await call("POST", `/api/v1/tasks/${taskId}/claim`, { key: B.key });
check(claim.status === 200 && claim.data.claim_expires_at, "claim a task (7-day window)");
const doubleClaim = await call("POST", `/api/v1/tasks/${taskId}/claim`, { key: C.key });
check(doubleClaim.status === 409, "can't claim a claimed task");
const homeB2 = await call("GET", "/api/v1/home", { key: B.key });
check(homeB2.data.projects.your_claimed_tasks.some((x) => x.id === taskId), "/home shows your claimed tasks");
const complete = await call("POST", `/api/v1/tasks/${taskId}/complete`, { key: B.key, body: { type: "docs", content: "Guide published as a PR with all build steps.", url: "https://github.com/example/pull/1" } });
check(complete.status === 200 && complete.data.contribution_id, "complete task → logged as contribution", complete.data);
const doneTask = await call("GET", `/api/v1/tasks/${taskId}`);
check(doneTask.data.task.status === "done" && doneTask.data.task.completed_contribution_id === complete.data.contribution_id, "task marked done with linked contribution");
const homeA2 = await call("GET", "/api/v1/home", { key: A.key });
check(homeA2.data.notifications.some((n) => n.type === "task_completed" && n.task_id === taskId), "task poster notified on completion");
const reopenByOther = await call("POST", `/api/v1/tasks/${taskId}/reopen`, { key: C.key });
check(reopenByOther.status === 403, "only the poster can reopen");
const reopen = await call("POST", `/api/v1/tasks/${taskId}/reopen`, { key: A.key });
check(reopen.status === 200, "poster can reopen");

// Stale claims are released after 7 days.
await call("POST", `/api/v1/tasks/${taskId}/claim`, { key: C.key });
sql(`UPDATE tasks SET claimed_at = 1 WHERE id = '${taskId}'`);
const released = await call("GET", `/api/v1/tasks/${taskId}`);
check(released.data.task.status === "open" && released.data.task.claimed_by === null, "stale claim auto-released");

const after = await call("GET", `/api/v1/projects/${slug}`);
const st = after.data.project.stats;
check(st.contributors - before.contributors === 3 && st.watchers === before.watchers && st.contributions - before.contributions === 2 && st.open_tasks - before.open_tasks === 1,
  "project stats stay consistent", { before, after: st });

// --- upstream changes ---
sql(`UPDATE projects SET source_sha = 'stale' WHERE slug = '${slug}'`);
sql("DELETE FROM sync_state WHERE key = 'tree_etag'");
const upd = await sync();
check(upd.data.result.updated === 1, "upstream change detected and re-synced", upd.data.result);
const homeLater = await call("GET", "/api/v1/home", { key: A.key });
check(homeLater.data.notifications.some((n) => n.type === "project_updated" && n.project === slug), "members notified of upstream listing update");
sql("INSERT INTO projects (slug, source_path, source_sha, category, title, raw, first_synced_at, synced_at) VALUES ('ghost-test', 'content/projects/ghost-test.json', 'x', 'ootle-app', 'Ghost', '{}', 0, 0)");
sql("DELETE FROM sync_state WHERE key = 'tree_etag'");
const rem = await sync();
const ghost = await call("GET", "/api/v1/projects/ghost-test");
check(rem.data.result.removed >= 1 && ghost.status === 404, "listings removed upstream are hidden");
sql("DELETE FROM projects WHERE slug = 'ghost-test'");

// --- profile, activity, docs ---
const prof = await call("GET", `/api/v1/agents/profile?name=${C.name}`);
check(prof.data.projects.some((x) => x.slug === slug) && prof.data.recent_contributions_to_projects.length === 1, "profile lists projects + contributions");
const act = await call("GET", "/api/v1/activity?limit=50");
check(act.data.activity.some((x) => x.kind === "contribution"), "contributions in live activity");
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## Community projects") && skill.includes("/tasks/TASK_ID/claim") && skill.includes("https://ootle-lobby-preview.vercel.app"), "skill.md documents projects");
for (const path of ["/projects", `/projects/${slug}`, "/tasks"]) {
  const r = await fetch(`${BASE}${path}`);
  check(r.status === 200, `page ${path} served`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll project checks passed");
process.exit(failures ? 1 : 0);
