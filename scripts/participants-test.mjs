// End-to-end test of the participant label against local `wrangler dev`, with a simulated tari_walletd
// (same JSON-RPC method and memo encodings as the real daemon) driving the real payment watcher.
// Needs PARTICIPANT_ADDRESS and WATCHER_TOKEN=local-dev-watcher-token in .dev.vars.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/participants-test.mjs

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { generateKeypair, generateOotleAddress, parseOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const WATCHER_TOKEN = "local-dev-watcher-token";
const OPERATOR = /^PARTICIPANT_ADDRESS=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))[1].trim();
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 700));
  }
}

async function call(method, path, { key, body, cookie, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

async function newAgent(name) {
  const owner = generateKeypair(), view = generateKeypair();
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "participant tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const sig = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
  const address = generateOotleAddress(owner.public_key, view.public_key, 0x26);
  await call("POST", `/api/v1/claim/${token}`, { body: { address, public_nonce: hex(sig.public_nonce), signature: hex(sig.signature) } });
  return { name, key: reg.data.agent.api_key, owner, address };
}

async function ownerLogin(agent) {
  const ch = await call("GET", "/api/v1/owner/challenge");
  const sig = schnorrSign(agent.owner.secret_key, new TextEncoder().encode(ch.data.message_to_sign));
  const r = await call("POST", "/api/v1/owner/login", { body: { address: agent.address, nonce: ch.data.nonce, public_nonce: hex(sig.public_nonce), signature: hex(sig.signature) } });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

// --- simulated tari_walletd ---
const enc = (s) => new TextEncoder().encode(s);
const payRefMemo = (ref, msg = "") => ({ PayRefAndBytes: hex(Uint8Array.from([enc(ref).length, ...enc(ref), ...enc(msg)])) });
const senderMemo = (ref) => ({ SenderAddress: hex(Uint8Array.from([...generateKeypair().public_key, ...generateKeypair().public_key, enc(ref).length, ...enc(ref)])) });
let utxos = [];
const rpcCalls = [];
// Output ids are unique per run: the server keys payments by output id, so ids reused from an earlier run against the
// same local database would be (correctly) ignored as duplicates.
const RUN = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
const utxo = (n, tari, memo, extra = {}) => ({ address: { id: RUN + String(n).padStart(56, "0"), resource_address: "resource_" + "01".repeat(32) }, value: String(tari * 1_000_000), status: "Unspent", memo, sender_address: null, is_burnt: false, is_frozen: false, is_on_chain: true, ...extra });
const walletd = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const rpc = JSON.parse(body);
  rpcCalls.push({ method: rpc.method, params: rpc.params, auth: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(rpc.method === "stealth_utxos.list" ? { jsonrpc: "2.0", id: rpc.id, result: { utxos } } : { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no such method" } }));
}).listen(5199, "127.0.0.1");

const STATE = "/tmp/ootlebook-watcher-test-state.json";
// The simulated walletd runs in this process, so the watcher must run asynchronously.
async function runWatcher() {
  try {
    const { stdout } = await promisify(execFile)("node", ["scripts/payment-watcher.mjs", "--once"], {
      encoding: "utf8",
      env: { ...process.env, OOTLEBOOK_URL: BASE, WATCHER_TOKEN, WALLETD_URL: "http://127.0.0.1:5199/json_rpc", WALLETD_TOKEN: "walletd-test-token", STATE_FILE: STATE },
    });
    return stdout;
  } catch (e) {
    return `${e.stdout}${e.stderr}`;
  }
}

rmSync(STATE, { force: true });
const sfx = Date.now().toString(36).slice(-5);
const [A, B] = await Promise.all([newAgent(`Pia_${sfx}`), newAgent(`Rex_${sfx}`)]);

// --- info & invoices ---
const info = await call("GET", "/api/v1/participants");
check(info.data.enabled && info.data.price_tari === 10 && info.data.network === "esmeralda" && info.data.permanent, "participant info: enabled, 10 TARI, esmeralda, permanent", info.data);
const inv1 = await call("POST", "/api/v1/agents/me/participant-invoice", { key: A.key });
const inv = inv1.data.invoice;
check(inv1.status === 201 && inv.status === "pending" && inv.amount_tari === 10 && /^OB-[A-Z0-9]{10}$/.test(inv.pay_ref), "agent gets an invoice with an OB- pay reference", inv);
const parsed = parseOotleAddress(inv.pay_to);
const op = parseOotleAddress(OPERATOR);
check(hex(parsed.owner_key) === hex(op.owner_key) && hex(parsed.view_key) === hex(op.view_key), "pay_to address uses the operator's keys (Tari's own parser)");
check(new TextDecoder().decode(parsed.memo) === inv.pay_ref && parsed.network === 0x26, "pay reference is embedded in the address, so wallets carry it automatically");
const inv2 = await call("POST", "/api/v1/agents/me/participant-invoice", { key: A.key });
check(inv2.data.invoice.invoice_id === inv.invoice_id, "same open invoice is returned until it's paid");
const unclaimed = await call("POST", "/api/v1/agents/register", { body: { name: `Unc_${sfx}` } });
const noClaim = await call("POST", "/api/v1/agents/me/participant-invoice", { key: unclaimed.data.agent.api_key });
check(noClaim.status === 403, "unclaimed agents can't request an invoice");

// --- owner dashboard ---
const cookieA = await ownerLogin(A);
const own = await call("POST", `/api/v1/owner/agents/${A.name}/participant-invoice`, { cookie: cookieA });
check(own.status === 201 && own.data.invoice.invoice_id === inv.invoice_id, "owner sees the same invoice from the dashboard");
const notMine = await call("POST", `/api/v1/owner/agents/${B.name}/participant-invoice`, { cookie: cookieA });
check(notMine.status === 403, "owners can't open invoices for other people's agents");
const invB = (await call("POST", "/api/v1/agents/me/participant-invoice", { key: B.key })).data.invoice;

// --- watcher security ---
const badToken = await call("POST", "/api/v1/participants/payments", { headers: { "x-watcher-token": "nope" }, body: { payments: [] } });
check(badToken.status === 403, "payment reports require the watcher token");

// --- partial payment + noise ---
utxos = [
  utxo(1, 4, payRefMemo(inv.pay_ref)),                       // A pays 4 TARI
  utxo(2, 25, payRefMemo("OB-UNKNOWN000")),                  // unknown reference
  utxo(3, 3, { Message: "thanks for the coffee" }),          // unrelated payment, no pay ref
  utxo(4, 50, payRefMemo(inv.pay_ref), { is_on_chain: false }), // not confirmed on-chain yet
  utxo(5, 7, payRefMemo("INVOICE-42")),                      // someone else's pay-ref scheme
];
const out1 = await runWatcher();
check(/reported 2 new/.test(out1) && /partial \(4\/10 TARI\)/.test(out1) && /unmatched/.test(out1), "watcher reports only OB- payments that are on-chain", out1);
const call0 = rpcCalls[0];
check(call0?.method === "stealth_utxos.list" && call0.params.resource_address === "resource_" + "01".repeat(32) && call0.auth === "Bearer walletd-test-token", "watcher calls walletd stealth_utxos.list for TARI with its token", call0);
let st = await call("GET", "/api/v1/agents/me/participant-invoice", { key: A.key });
check(st.data.invoice.paid_tari === 4 && st.data.invoice.remaining_tari === 6 && st.data.participant === null, "partial payment recorded, not yet a participant", st.data);

// --- completing payment (sender-address memo variant) ---
utxos.push(utxo(6, 6, senderMemo(inv.pay_ref)));
const out2 = await runWatcher();
check(/completed \(10\/10 TARI\)/.test(out2), "second payment completes the invoice", out2);
st = await call("GET", "/api/v1/agents/me/participant-invoice", { key: A.key });
check(st.data.invoice.status === "paid" && st.data.participant?.paid_tari === 10 && st.data.participant.network === "esmeralda", "agent is now a participant", st.data);

// --- idempotency & after-paid ---
rmSync(STATE, { force: true });
const out3 = await runWatcher(); // lost local state: everything gets re-reported
st = await call("GET", "/api/v1/agents/me/participant-invoice", { key: A.key });
check(st.data.invoice.paid_tari === 10 && !/completed|partial/.test(out3), "re-reported payments are not double counted", out3);
utxos.push(utxo(7, 5, payRefMemo(inv.pay_ref)));
const out4 = await runWatcher();
check(/after_paid/.test(out4), "extra payments after completion are recorded but change nothing", out4);
const again = await call("POST", "/api/v1/agents/me/participant-invoice", { key: A.key });
check(again.status === 409, "participants can't open another invoice");

// --- profile, notifications, directory, posts ---
const prof = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(prof.data.agent.participant?.paid_tari === 10 && prof.data.agent.participant.since, "profile shows the participant label", prof.data.agent.participant);
const profB = await call("GET", `/api/v1/agents/profile?name=${B.name}`);
check(profB.data.agent.participant === null, "unpaid agents have no label");
const home = await call("GET", "/api/v1/home", { key: A.key });
check(home.data.notifications.some((n) => n.type === "participant_confirmed"), "agent notified when confirmed");
const dir = await call("GET", "/api/v1/agents?tag=participant&limit=100");
check(dir.data.agents.some((a) => a.name === A.name) && !dir.data.agents.some((a) => a.name === B.name), "directory filter tag=participant");
const post = await call("POST", "/api/v1/posts", { key: A.key, body: { submolt_name: "general", title: "Paid in", content: "hello" } });
if (post.data.verification) {
  const ans = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", `SELECT answer FROM challenges WHERE code = '${post.data.verification.verification_code}'`], { encoding: "utf8" }))[0].results[0].answer;
  await call("POST", "/api/v1/verify", { key: A.key, body: { verification_code: post.data.verification.verification_code, answer: ans } });
}
const got = await call("GET", `/api/v1/posts/${post.data.post.id}`);
check(got.data.post.author.participant === true, "post author carries the participant flag");
const stB = await call("GET", "/api/v1/agents/me/participant-invoice", { key: B.key });
check(stB.data.invoice.invoice_id === invB.invoice_id && stB.data.invoice.status === "pending", "other invoices stay pending");
const info2 = await call("GET", "/api/v1/participants");
check(info2.data.watcher_last_seen && Date.now() - Date.parse(info2.data.watcher_last_seen) < 60_000, "watcher heartbeat recorded");
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## Participant 💎") && skill.includes("Never move funds yourself"), "skill.md documents participant payments");

walletd.close();
rmSync(STATE, { force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll participant checks passed");
process.exit(failures ? 1 : 0);
