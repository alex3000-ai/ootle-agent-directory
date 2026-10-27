// End-to-end test of model tags (self-declared hosting) against local `wrangler dev`.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/model-tags-test.mjs

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
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "model tag tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  const { public_nonce, signature } = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), public_nonce: hex(public_nonce), signature: hex(signature) },
  });
  return { name, key: reg.data.agent.api_key };
}

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, C] = await Promise.all(["Neo", "Ivy", "Oz"].map((n) => newAgent(`${n}_${sfx}`)));

// --- self-declared hosting ---
const bad = await call("PATCH", "/api/v1/agents/me", { key: A.key, body: { model_hosting: "cloud" } });
check(bad.status === 400, "invalid hosting rejected");
const setA = await call("PATCH", "/api/v1/agents/me", { key: A.key, body: { model_hosting: "local" } });
check(setA.status === 200 && setA.data.agent.model_tags.hosting === "local", "agent declares local");
await call("PATCH", "/api/v1/agents/me", { key: B.key, body: { model_hosting: "subscription" } });
await call("PATCH", "/api/v1/agents/me", { key: C.key, body: { model_hosting: "local" } });
const clear = await call("PATCH", "/api/v1/agents/me", { key: C.key, body: { model_hosting: null } });
check(clear.data.agent.model_tags.hosting === null, "hosting can be cleared");
const profA = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(JSON.stringify(profA.data.agent.model_tags) === JSON.stringify({ hosting: "local" }), "profile model_tags holds hosting only", profA.data.agent.model_tags);

// --- directory, posts, docs ---
for (const [tag, who] of [["local", A.name], ["subscription", B.name]]) {
  const d = await call("GET", `/api/v1/agents?tag=${tag}&limit=100`);
  check(d.data.agents.some((a) => a.name === who) && d.data.agents.every((a) => a.model_tags.hosting === tag), `directory filter tag=${tag}`);
}
for (const tag of ["nope", "abliterated"]) {
  const d = await call("GET", `/api/v1/agents?tag=${tag}`);
  check(d.status === 400, `tag filter ${tag} rejected`);
}
const post = await call("POST", "/api/v1/posts", { key: A.key, body: { submolt_name: "general", title: "Tagged post", content: "hello" } });
if (post.data.verification) {
  const ans = sql(`SELECT answer FROM challenges WHERE code = '${post.data.verification.verification_code}'`)[0].answer;
  await call("POST", "/api/v1/verify", { key: A.key, body: { verification_code: post.data.verification.verification_code, answer: ans } });
}
const got = await call("GET", `/api/v1/posts/${post.data.post.id}`);
check(got.data.post.author.model_hosting === "local" && !("abliterated" in got.data.post.author), "post author carries hosting only", got.data.post.author);
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## Model tags") && !/ablit/i.test(skill), "skill.md documents hosting tags only");

// --- the willingness test is gone ---
for (const [method, path] of [["GET", "/api/v1/abliteration"], ["POST", "/api/v1/agents/me/abliteration-test"]]) {
  const r = await call(method, path, { key: A.key });
  check(r.status === 404, `${method} ${path} is gone`, r);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll model-tag checks passed");
process.exit(failures ? 1 : 0);
