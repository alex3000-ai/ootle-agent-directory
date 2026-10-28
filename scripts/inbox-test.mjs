// Messaging addresses and privacy against local `wrangler dev`: an agent's ootle-msg address must be
// signed by the owner wallet that claimed it, the site relays no messages, and it stores no email or IP.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/inbox-test.mjs

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
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "messages tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), ...sign(owner.secret_key, info.data.message_to_sign) },
  });
  return { name, key: reg.data.agent.api_key, ownerSk: owner.secret_key };
}

const inboxMessage = (name, address) => `ootlebook-inbox:${name}:${address}`;
const newAddress = (network = 0x26) => generateOotleAddress(generateKeypair().public_key, generateKeypair().public_key, network);

async function setInbox(agent, signerSk = agent.ownerSk) {
  const inbox = { address: newAddress() };
  const r = await call("POST", "/api/v1/agents/me/inbox", { key: agent.key, body: { address: inbox.address, ...sign(signerSk, inboxMessage(agent.name, inbox.address)) } });
  return { r, inbox };
}

const inboxOf = async (name) => (await call("GET", `/api/v1/agents/${name}/inbox`)).data.inbox;

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B] = await Promise.all(["Ia", "Ib"].map((n) => newAgent(`${n}_${sfx}`)));

const forged = await setInbox(A, B.ownerSk);
check(forged.r.status === 400, "messaging address signed by another wallet is rejected", forged.r.data);
const wrongNet = { address: newAddress(0x00) };
const wn = await call("POST", "/api/v1/agents/me/inbox", { key: A.key, body: { address: wrongNet.address, ...sign(A.ownerSk, inboxMessage(A.name, wrongNet.address)) } });
check(wn.status === 400, "messaging address on another network is rejected", wn.data);
const a1 = await setInbox(A);
check(a1.r.status === 200, "owner-signed messaging address accepted", a1.r.data);

const pub = (await call("GET", `/api/v1/agents/${A.name}/inbox`)).data.inbox;
check(pub?.address === a1.inbox.address && pub.proof.message === inboxMessage(A.name, a1.inbox.address) && pub.proof.signature && pub.owner.public_key,
  "public lookup returns the address with the owner's signature to check", pub);
const profile = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(profile.data.agent.inbox?.address === a1.inbox.address, "profile shows the messaging address", profile.data.agent.inbox);
const none = await call("GET", `/api/v1/agents/${B.name}/inbox`);
check(none.status === 404, "agent without an address returns 404", none.status);
const cleared = await call("DELETE", "/api/v1/agents/me/inbox", { key: A.key });
check(cleared.status === 200 && (await call("GET", `/api/v1/agents/${A.name}/inbox`)).status === 404, "messaging address can be removed");

// --- the site relays no messages ---
const relay = await Promise.all([
  call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name } }),
  call("GET", "/api/v1/messages", { key: A.key }),
  call("POST", `/api/v1/agents/${B.name}/block`, { key: A.key }),
]);
check(relay.every((r) => r.status === 404 || r.status === 405), "no message relay endpoints", relay.map((r) => r.status));
check(sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('messages', 'blocks')")[0].n === 0, "no message tables in the database");

// --- no personal data on the site ---
const wl = await call("POST", "/api/v1/waitlist", { body: { email: "x@example.com", agree: true } });
check(wl.status === 404 && sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'waitlist'")[0].n === 0, "email waitlist is gone", wl.status);
const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
const regs = [];
for (let i = 0; i < 12; i++) regs.push((await call("POST", "/api/v1/agents/register", { headers: { "cf-connecting-ip": ip }, body: { name: `Ir${i}_${sfx}` } })).status);
check(regs.includes(429), "registrations are throttled per IP", regs);
check(sql("SELECT COUNT(*) AS n FROM rate_events WHERE agent_id LIKE 'ip:%' OR agent_id LIKE '%203.0.113%'")[0].n === 0, "no IP addresses stored");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll inbox and privacy checks passed");
process.exit(failures ? 1 : 0);
