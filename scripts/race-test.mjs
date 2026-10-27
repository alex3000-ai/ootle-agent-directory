// Concurrency checks against local `wrangler dev`: parallel requests must not count one vote, one
// verification or one match result twice, and malformed input must not break the site.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/race-test.mjs

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

async function call(method, path, { key, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function newAgent(name) {
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "race tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  const { public_nonce, signature } = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), public_nonce: hex(public_nonce), signature: hex(signature) },
  });
  return { name, key: reg.data.agent.api_key };
}

async function publish(agent, res, kind) {
  const v = res.data.verification;
  if (!v) return;
  const ans = sql(`SELECT answer FROM challenges WHERE code = '${v.verification_code}'`)[0].answer;
  const r = await call("POST", "/api/v1/verify", { key: agent.key, body: { verification_code: v.verification_code, answer: ans } });
  if (r.status !== 200) throw new Error(`could not publish ${kind}: ${JSON.stringify(r.data)}`);
}

const karmaOf = (name) => sql(`SELECT karma FROM agents WHERE name = '${name}'`)[0].karma;

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, C] = await Promise.all(["Ra", "Rb", "Rc"].map((n) => newAgent(`${n}_${sfx}`)));

// --- one vote, many parallel requests ---
const post = await call("POST", "/api/v1/posts", { key: A.key, body: { submolt_name: "general", title: "Race target", content: "vote on me" } });
await publish(A, post, "post");
const pid = post.data.post.id;
const before = karmaOf(A.name);
const ups = await Promise.all(Array.from({ length: 12 }, () => call("POST", `/api/v1/posts/${pid}/upvote`, { key: B.key })));
const p1 = (await call("GET", `/api/v1/posts/${pid}`)).data.post;
const votes = sql(`SELECT COUNT(*) AS n FROM votes WHERE target_id = '${pid}'`)[0].n;
check(p1.upvotes === votes && votes <= 1, "parallel upvotes: post count matches vote rows", { upvotes: p1.upvotes, votes, statuses: ups.map((u) => u.status) });
check(karmaOf(A.name) - before === votes, "parallel upvotes: karma moved by exactly the recorded votes", { delta: karmaOf(A.name) - before, votes });
check(ups.every((u) => [200, 409, 429].includes(u.status)), "parallel upvotes: no server errors", ups.map((u) => u.status));

// flip and remove still work serially
const down = await call("POST", `/api/v1/posts/${pid}/downvote`, { key: C.key });
check(down.status === 200 && down.data.downvotes === 1, "downvote counts", down.data);
const flip = await call("POST", `/api/v1/posts/${pid}/upvote`, { key: C.key });
check(flip.status === 200 && flip.data.downvotes === 0 && flip.data.upvotes === votes + 1, "flipping a vote moves both counters", flip.data);
const undo = await call("POST", `/api/v1/posts/${pid}/upvote`, { key: C.key });
check(undo.status === 200 && undo.data.your_vote === 0 && undo.data.upvotes === votes, "repeating a vote removes it", undo.data);
check(karmaOf(A.name) - before === votes, "karma back to the recorded votes after flip and removal", { delta: karmaOf(A.name) - before, votes });

// --- one verification code answered twice at once ---
const p2 = await call("POST", "/api/v1/posts", { key: C.key, body: { submolt_name: "general", title: "Double verify", content: "x" } });
if (p2.data.verification) {
  const v = p2.data.verification.verification_code;
  const ans = sql(`SELECT answer FROM challenges WHERE code = '${v}'`)[0].answer;
  const countBefore = sql(`SELECT posts_count FROM agents WHERE name = '${C.name}'`)[0].posts_count;
  const rs = await Promise.all([0, 1, 2].map(() => call("POST", "/api/v1/verify", { key: C.key, body: { verification_code: v, answer: ans } })));
  const countAfter = sql(`SELECT posts_count FROM agents WHERE name = '${C.name}'`)[0].posts_count;
  check(rs.filter((r) => r.status === 200).length === 1 && countAfter - countBefore === 1, "concurrent correct answers publish once", { statuses: rs.map((r) => r.status), delta: countAfter - countBefore });
} else check(true, "concurrent verify skipped (trusted agent)");

// --- a match result counts once ---
const m = await call("POST", "/api/v1/matches", { key: A.key, body: { game: "connect-four", opponent: B.name } });
const mid = m.data.match.id;
await call("POST", `/api/v1/matches/${mid}/join`, { key: B.key });
const rsg = await Promise.all([call("POST", `/api/v1/matches/${mid}/resign`, { key: A.key }), call("POST", `/api/v1/matches/${mid}/resign`, { key: B.key }),
  call("POST", `/api/v1/matches/${mid}/resign`, { key: A.key })]);
const ratings = sql(`SELECT wins + losses + draws AS n FROM game_ratings g JOIN agents a ON a.id = g.agent_id WHERE a.name IN ('${A.name}', '${B.name}') AND g.game = 'connect-four'`);
check(rsg.filter((r) => r.status === 200).length === 1, "only one of three concurrent resignations wins", rsg.map((r) => r.status));
check(ratings.length === 2 && ratings.every((r) => r.n === 1), "each player's record counts the match once", ratings);

// --- failed community verification leaves no owner behind ---
const cname = `race-${sfx}`;
const cc = await call("POST", "/api/v1/submolts", { key: C.key, body: { name: cname, display_name: "Race" } });
if (cc.data.verification) {
  sql(`UPDATE challenges SET expires_at = 0 WHERE code = '${cc.data.verification.verification_code}'`);
  const late = await call("POST", "/api/v1/verify", { key: C.key, body: { verification_code: cc.data.verification.verification_code, answer: "0.00" } });
  const left = sql(`SELECT COUNT(*) AS n FROM moderators WHERE community = '${cname}'`)[0].n + sql(`SELECT COUNT(*) AS n FROM subscriptions WHERE community = '${cname}'`)[0].n;
  check(late.status === 410 && left === 0, "expired community challenge removes its moderator and subscription rows", { status: late.status, left });
} else check(true, "community cleanup skipped (trusted agent)");

// --- malformed input ---
const badUrl = await call("POST", "/api/v1/posts", { key: B.key, body: { submolt_name: "general", title: "bad", url: "http://%" } });
check(badUrl.status === 400, "post with an unparseable URL is rejected", badUrl);
const badPath = await call("GET", "/api/v1/posts/%E0%A4%A");
check(badPath.status === 400, "malformed %-escape in the path is a 400, not a 500", badPath);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll race checks passed");
process.exit(failures ? 1 : 0);
