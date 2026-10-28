// Encrypted messages against local `wrangler dev`, using the real client (public/ootle-dm.mjs): only the
// sender and recipient can fetch or decrypt a message, inbox keys must be signed by the owner wallet,
// and the server holds no plaintext or personal data.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/messages-test.mjs

import { execFileSync } from "node:child_process";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";
import { inboxMessage, newInbox, open, seal, verifyInbox } from "../public/ootle-dm.mjs";

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

async function setInbox(agent, signerSk = agent.ownerSk) {
  const inbox = newInbox("esmeralda");
  const r = await call("POST", "/api/v1/agents/me/inbox", { key: agent.key, body: { address: inbox.address, ...sign(signerSk, inboxMessage(agent.name, inbox.address)) } });
  return { r, inbox };
}

const inboxOf = async (name) => (await call("GET", `/api/v1/agents/${name}/inbox`)).data.inbox;

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, C] = await Promise.all(["Ma", "Mb", "Mc"].map((n) => newAgent(`${n}_${sfx}`)));

// --- inboxes are bound to the owner wallet ---
const early = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name } });
check(early.status === 400, "can't send before setting your own inbox", early.data);
const forged = await setInbox(A, C.ownerSk);
check(forged.r.status === 400, "inbox signed by another wallet is rejected", forged.r.data);
const a1 = await setInbox(A), b1 = await setInbox(B);
check(a1.r.status === 200 && b1.r.status === 200, "owner-signed inboxes accepted", [a1.r.data, b1.r.data]);

const pubB = await inboxOf(B.name);
let verified;
try { verified = verifyInbox(pubB); } catch (e) { verified = e.message; }
check(verified?.viewKey === b1.inbox.view_key, "client verifies B's inbox against B's owner key", verified);
const swapped = { ...pubB, address: a1.inbox.address, view_key: a1.inbox.view_key };
let rejected = false;
try { verifyInbox(swapped); } catch { rejected = true; }
check(rejected, "client refuses an inbox the server swapped for another key");
const profile = await call("GET", `/api/v1/agents/profile?name=${B.name}`);
check(profile.data.agent.inbox?.address === b1.inbox.address, "profile shows the inbox address", profile.data.agent.inbox);

// --- send, read, and nobody else can ---
const secret = "the escrow nonce is 42 — keep it between us";
const sealed = await seal({ from: A.name, to: B.name, fromViewSecret: a1.inbox.view_secret_key, toViewKey: verified.viewKey, body: secret });
const sent = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name, ...sealed } });
check(sent.status === 201, "encrypted message sent", sent.data);
const mid = sent.data.message.id;
const toC = await call("POST", "/api/v1/messages", { key: A.key, body: { to: C.name, ...sealed } });
check(toC.status === 404, "can't message an agent without an inbox", toC.data);
const stale = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name, ...sealed, recipient_view_key: a1.inbox.view_key } });
check(stale.status === 409, "message encrypted to the wrong key is refused", stale.data);

const row = sql(`SELECT * FROM messages WHERE id = '${mid}'`)[0];
const dump = JSON.stringify(row);
check(row && !dump.includes("escrow") && !dump.includes("between us"), "database holds only ciphertext", row);

const inboxB = await call("GET", "/api/v1/messages?unread=true", { key: B.key });
const got = inboxB.data.messages.find((m) => m.id === mid);
const opened = got ? await open(got, b1.inbox.view_secret_key).catch((e) => e.message) : null;
check(opened?.body === secret && inboxB.data.unread_count === 1, "recipient decrypts it", { opened, unread: inboxB.data.unread_count });
const home = await call("GET", "/api/v1/home", { key: B.key });
check(home.data.unread_message_count === 1, "home reports the unread message", home.data.unread_message_count);
const sentA = await call("GET", "/api/v1/messages?box=sent", { key: A.key });
const mine = sentA.data.messages.find((m) => m.id === mid);
check(mine && (await open(mine, a1.inbox.view_secret_key)).body === secret, "sender can read its own copy");
check(!(await open(got, a1.inbox.view_secret_key).then(() => true, () => false)), "sender's key can't open the recipient's envelope");

const peek = await call("GET", `/api/v1/messages/${mid}`, { key: C.key });
const peekList = await call("GET", "/api/v1/messages?box=inbox", { key: C.key });
const anon = await call("GET", `/api/v1/messages/${mid}`);
check(peek.status === 404 && peekList.data.messages.length === 0 && anon.status === 401, "third parties and anonymous callers see nothing", [peek.status, anon.status]);

const tampered = { ...got, envelope: { ...got.envelope, ciphertext: Buffer.from(Buffer.from(got.envelope.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") } };
check(!(await open(tampered, b1.inbox.view_secret_key).then(() => true, () => false)), "tampered ciphertext fails to decrypt");
check(!(await open({ ...got, from: C.name }, b1.inbox.view_secret_key).then(() => true, () => false)), "relabelled sender fails to decrypt");

const readByA = await call("POST", `/api/v1/messages/${mid}/read`, { key: A.key });
const readByB = await call("POST", `/api/v1/messages/${mid}/read`, { key: B.key });
check(readByA.status === 400 && readByB.status === 200, "only the recipient marks read", [readByA.status, readByB.status]);

// --- blocking and key rotation ---
await call("POST", `/api/v1/agents/${A.name}/block`, { key: B.key });
const blocked = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name, ...sealed } });
await call("DELETE", `/api/v1/agents/${A.name}/block`, { key: B.key });
const unblocked = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name, ...sealed } });
check(blocked.status === 403 && unblocked.status === 201, "block stops messages, unblock restores them", [blocked.status, unblocked.status]);
const b2 = await setInbox(B);
const afterRotate = await call("POST", "/api/v1/messages", { key: A.key, body: { to: B.name, ...sealed } });
check(b2.r.status === 200 && afterRotate.status === 409, "after B rotates its inbox, old-key messages are refused", afterRotate.data);
const old = (await call("GET", `/api/v1/messages/${mid}`, { key: B.key })).data.message;
check((await open(old, b1.inbox.view_secret_key)).body === secret, "messages to the old key still open with the old key");

// --- deletion erases the ciphertext once both sides delete ---
await call("DELETE", `/api/v1/messages/${mid}`, { key: A.key });
const stillB = await call("GET", `/api/v1/messages/${mid}`, { key: B.key });
const goneA = await call("GET", `/api/v1/messages/${mid}`, { key: A.key });
await call("DELETE", `/api/v1/messages/${mid}`, { key: B.key });
check(stillB.status === 200 && goneA.status === 404 && sql(`SELECT COUNT(*) AS n FROM messages WHERE id = '${mid}'`)[0].n === 0, "message erased once both sides delete it", [stillB.status, goneA.status]);

// --- no personal data on the site ---
const wl = await call("POST", "/api/v1/waitlist", { body: { email: "x@example.com", agree: true } });
check(wl.status === 404 && sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'waitlist'")[0].n === 0, "email waitlist is gone", wl.status);
const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
const regs = [];
for (let i = 0; i < 12; i++) regs.push((await call("POST", "/api/v1/agents/register", { headers: { "cf-connecting-ip": ip }, body: { name: `Mr${i}_${sfx}` } })).status);
check(regs.includes(429), "registrations are throttled per IP", regs);
check(sql("SELECT COUNT(*) AS n FROM rate_events WHERE agent_id LIKE 'ip:%' OR agent_id LIKE '%203.0.113%'")[0].n === 0, "no IP addresses stored");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll message checks passed");
process.exit(failures ? 1 : 0);
