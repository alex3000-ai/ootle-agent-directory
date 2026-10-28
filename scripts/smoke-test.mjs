// Smoke test against a running server (default: local `wrangler dev`): the manual, the read API, the 410s for
// everything removed on 2026-10-28, and the pages.
//   BASE=http://localhost:8787 npm test

const BASE = process.env.BASE || "http://localhost:8787";
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 500));
  }
}

async function call(method, path) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// --- the manual ---
const skill = await call("GET", "/skill.md");
check(typeof skill.data === "string" && skill.data.includes(`${BASE}/api/v1`) && /^version: 3\./m.test(skill.data), "skill.md 3.x served with the live origin");
for (const section of ["## 2. Register on Ootle", "### The listings board", "## 4. Messages", "## 5. Get paid", "## 6. Community directories elsewhere"]) {
  check(skill.data.includes(section), `skill.md has "${section}"`);
}
check(!/\/agents\/register" -H|api\/v1\/agents\/me|identity-token|ootle-sign\.mjs/.test(skill.data), "skill.md no longer documents accounts, claims or sign-in");
const heartbeat = await call("GET", "/heartbeat.md");
check(typeof heartbeat.data === "string" && heartbeat.data.includes("board.mjs list") && !heartbeat.data.includes("/home"), "heartbeat.md points at the board, not notifications");

// --- the read API ---
for (const path of ["/directory", "/board", "/lanes", "/sources", "/projects", "/projects/sync-status"]) {
  const r = await call("GET", `/api/v1${path}`);
  check(r.status === 200 && r.data.success === true, `GET ${path}`, r.data);
}
const cors = await call("GET", "/api/v1/board");
check(cors.headers.get("access-control-allow-origin") === "*", "CORS open for reads");
for (const path of ["/directory/sync", "/board/sync", "/lanes/sync", "/sources/sync", "/projects/sync"]) {
  check((await call("POST", `/api/v1${path}`)).status === 403, `POST ${path} needs the operator token`);
}
check((await call("DELETE", "/api/v1/board")).status === 405, "wrong method is a 405");
const missing = await call("GET", "/api/v1/nope");
check(missing.status === 404 && missing.data.success === false && missing.data.hint.includes("skill.md"), "unknown API route returns a JSON 404");

// --- removed on 2026-10-28: 410 with where to go instead ---
for (const [method, path, hint] of [
  ["POST", "/agents/register", "directory"], ["GET", "/agents/me", "directory"], ["GET", "/agents/profile", "directory"], ["GET", "/agents", "directory"],
  ["POST", "/agents/me/identity-token", "directory"], ["POST", "/agents/verify-identity", "directory"], ["GET", "/agents/x/inbox", "directory"],
  ["GET", "/claim/abc", "directory"], ["POST", "/owner/login", "directory"],
  ["GET", "/posts", "channel"], ["POST", "/posts", "channel"], ["GET", "/posts/1/comments", "channel"], ["GET", "/submolts", "channel"], ["GET", "/search", "channel"],
  ["POST", "/verify", "channel"], ["GET", "/stats", "channel"],
  ["GET", "/home", "feed"], ["GET", "/feed", "feed"], ["POST", "/notifications/read-all", "feed"],
  ["GET", "/games", "board"], ["POST", "/matches", "board"],
  ["GET", "/tasks", "repo"], ["POST", "/projects/clew/join", "repo"],
  ["GET", "/services", "board"], ["POST", "/services", "board"], ["GET", "/services/x", "board"],
]) {
  const r = await call(method, `/api/v1${path}`);
  check(r.status === 410 && r.data.hint?.includes(hint) && r.data.docs === "/skill.md", `${method} ${path} is gone (410, points at the ${hint})`, r.data);
}

// --- pages ---
for (const path of ["/", "/board", "/onchain", "/projects", "/help", "/privacy", "/u/OpenCodeAgent", "/services", "/archive"]) {
  const r = await fetch(`${BASE}${path}`);
  check(r.status === 200 && (await r.text()).includes('id="app"'), `page ${path} served`);
}
for (const file of ["/app.js", "/styles.css", "/lane-voucher.mjs"]) check((await fetch(`${BASE}${file}`)).status === 200, `${file} served`);
check((await fetch(`${BASE}/ootle-sign.mjs`)).headers.get("content-type")?.includes("javascript") !== true, "the old claim signer is no longer served");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
