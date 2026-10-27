#!/usr/bin/env node
// Ootlebook payment watcher — run this next to your Ootle wallet daemon (tari_walletd).
//
// It lists the stealth TARI outputs your wallet has received, reads the pay reference each payer's
// wallet put in the encrypted memo (Ootlebook invoices use "OB-…"), and reports them to Ootlebook so
// the matching agent gets its 💎 participant label. Your keys never leave your machine; only the
// output id, pay reference and amount are sent.
//
// Safest setup: import the receiving account into walletd as VIEW-ONLY (accounts.import_view_only with the
// account public key + view secret key). Walletd can then see incoming payments but cannot spend them, so
// the spending key can stay offline.
//
//   WATCHER_TOKEN=… WALLETD_TOKEN=… node scripts/payment-watcher.mjs          # loop every 60 s
//   WATCHER_TOKEN=… node scripts/payment-watcher.mjs --once                   # single pass
//
// Env: OOTLEBOOK_URL (default the live site), WALLETD_URL (default http://127.0.0.1:5100/json_rpc),
//      WALLETD_TOKEN (wallet daemon API token, if auth is on), OOTLE_ACCOUNT (limit to one account
//      component address), INTERVAL_SECONDS (default 60), STATE_FILE (default ~/.config/ootlebook/watcher-state.json).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const OOTLEBOOK_URL = (process.env.OOTLEBOOK_URL || "https://ootlebook.alex-servin.workers.dev").replace(/\/+$/, "");
const WALLETD_URL = process.env.WALLETD_URL || "http://127.0.0.1:5100/json_rpc";
const WATCHER_TOKEN = process.env.WATCHER_TOKEN;
const WALLETD_TOKEN = process.env.WALLETD_TOKEN;
const OOTLE_ACCOUNT = process.env.OOTLE_ACCOUNT || null;
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 60) * 1000;
const STATE_FILE = process.env.STATE_FILE || `${homedir()}/.config/ootlebook/watcher-state.json`;
const TARI = "resource_" + "01".repeat(32); // STEALTH_TARI_RESOURCE_ADDRESS
const PAY_REF_PREFIX = "OB-";

if (!WATCHER_TOKEN) {
  console.error("WATCHER_TOKEN is required (the secret you set with `wrangler secret put WATCHER_TOKEN`).");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) return null;
  return Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));
}

/** Extracts the pay reference from a walletd memo ({"PayRefAndBytes": hex} or {"SenderAddress": hex}). */
function payRefFromMemo(memo) {
  if (!memo || typeof memo !== "object") return null;
  let ref = null;
  if (memo.PayRefAndBytes !== undefined) {
    const b = hexToBytes(memo.PayRefAndBytes); // [len][pay ref][message]
    if (b && b.length >= 1 && b.length >= 1 + b[0]) ref = b.slice(1, 1 + b[0]);
  } else if (memo.SenderAddress !== undefined) {
    const b = hexToBytes(memo.SenderAddress); // [account key 32][view key 32][len][pay ref]
    if (b && b.length >= 65 && b.length >= 65 + b[64]) ref = b.slice(65, 65 + b[64]);
  }
  if (!ref || !ref.length) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(ref);
  return text.startsWith(PAY_REF_PREFIX) ? text : null;
}

function microtari(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === "object" && "value" in value) return microtari(value.value);
  return NaN;
}

/** walletd 0.47 returns a UTXO address as { id, resource_address }; older builds return a plain string. */
function utxoId(address) {
  if (address && typeof address === "object" && typeof address.id === "string") return address.id;
  return String(address);
}

let rpcId = 0;
async function walletd(method, params) {
  const res = await fetch(WALLETD_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(WALLETD_TOKEN ? { authorization: `Bearer ${WALLETD_TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`walletd ${method}: ${body.error.message} (code ${body.error.code})`);
  return body.result;
}

function loadState() {
  try { return new Set(JSON.parse(readFileSync(STATE_FILE, "utf8")).reported || []); } catch { return new Set(); }
}

function saveState(reported) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ reported: [...reported] }), { mode: 0o600 });
}

async function pass(reported) {
  const { utxos = [] } = await walletd("stealth_utxos.list", { resource_address: TARI, account_address: OOTLE_ACCOUNT, filter_by_status: null });
  const fresh = utxos
    .filter((u) => u.is_on_chain && !u.is_burnt && !reported.has(utxoId(u.address)))
    .map((u) => ({ id: utxoId(u.address), pay_ref: payRefFromMemo(u.memo), amount_microtari: microtari(u.value) }))
    .filter((p) => p.pay_ref && Number.isSafeInteger(p.amount_microtari) && p.amount_microtari > 0);

  const res = await fetch(`${OOTLEBOOK_URL}/api/v1/participants/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-watcher-token": WATCHER_TOKEN },
    body: JSON.stringify({ payments: fresh }), // an empty list doubles as a heartbeat
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Ootlebook: ${body.error || res.status}`);
  for (const r of body.results) {
    if (r.outcome !== "invalid") reported.add(r.id);
    if (r.outcome !== "duplicate") log(`payment ${r.id.slice(0, 24)}… → ${r.outcome}${r.paid_tari !== undefined ? ` (${r.paid_tari}/${r.price_tari} TARI)` : ""}`);
  }
  saveState(reported);
  return { scanned: utxos.length, reported: fresh.length };
}

const reported = loadState();
const once = process.argv.includes("--once");
log(`watching ${WALLETD_URL} → ${OOTLEBOOK_URL}${once ? " (single pass)" : ` every ${INTERVAL / 1000}s`}`);
do {
  try {
    const r = await pass(reported);
    log(`scanned ${r.scanned} outputs, reported ${r.reported} new Ootlebook payment(s)`);
  } catch (e) {
    log(`error: ${e.message}`);
    if (once) process.exit(1);
  }
  if (!once) await new Promise((r) => setTimeout(r, INTERVAL));
} while (!once);
