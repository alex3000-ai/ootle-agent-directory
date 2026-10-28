#!/usr/bin/env node
// Publishes the ListingsBoard template and creates the board over the official directory. Dry-runs by default;
// --live spends and records both in deployments/esmeralda.json. The fee and the longest listing are fixed forever.
//   node deploy/publish-board.mjs --account lanes-admin [--fee 10000] [--max-epochs 2000] [--live]
//   node deploy/publish-board.mjs --account lanes-admin --create-only [--live]   (template already published)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountInfo } from "../client/directory.mjs";
import { callFunction, cbor, submitInstructions } from "../client/tx.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "target/wasm32-unknown-unknown/release/listings_board.wasm");
const PATH = join(ROOT, "deployments", "esmeralda.json");
const argv = process.argv.slice(2);
const flag = (name, def) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const live = argv.includes("--live");
const account = flag("account", "lanes-admin");
const fee = BigInt(flag("fee", "10000"));
const maxEpochs = BigInt(flag("max-epochs", "2000"));
const url = process.env.WALLETD_URL || "http://127.0.0.1:5100/json_rpc";
let token = process.env.WALLETD_TOKEN;
let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
// Publishing needs Templates(Create): ask a `--authentication none` daemon for a short-lived admin token.
if (!token) token = (await rpc("auth.request", { permissions: ["Admin"], credentials: "None" })).token;

const dep = JSON.parse(readFileSync(PATH, "utf8"));
const save = () => writeFileSync(PATH, JSON.stringify(dep, null, 2) + "\n");

if (!argv.includes("--create-only")) {
  const binary = readFileSync(WASM).toString("base64");
  const publish = (dry_run, max_fee) => rpc("transactions.publish_template", { binary, fee_account: { Name: account }, max_fee, detect_inputs: true, dry_run });
  // A dry run reports the full fee even above its max_fee, so a low ceiling keeps the revealed funds it needs small.
  const dry = await publish(true, 1_000_000);
  console.log(`publish: dry run fee ${dry.dry_run_fee} µT for a ${(readFileSync(WASM).length / 1024).toFixed(0)} KiB template`);
  if (!live) process.exit(0);
  // walletd charges the full max_fee, but dry runs have come in up to ~12% low: leave 15%.
  const sent = await publish(false, Math.ceil(dry.dry_run_fee * 1.15));
  const result = await rpc("transactions.wait_result", { transaction_id: sent.transaction_id, timeout_secs: 300 });
  if (result.status !== "Accepted") throw new Error(`publish failed: ${JSON.stringify(result).slice(0, 800)}`);
  dep.templates.ListingsBoard = JSON.stringify(result).match(/template_[0-9a-f]{64}/)?.[0];
  dep.transactions.publish_board = sent.transaction_id;
  save();
  console.log(`published ${dep.templates.ListingsBoard} in ${sent.transaction_id} (fee ${result.final_fee} µT)`);
}

// new(directory, payment_resource, fee, max_duration_epochs)
const resource = (addr) => cbor.tag(131, cbor.bytes(Buffer.from(addr.replace("resource_", ""), "hex")));
const acct = await accountInfo(rpc, account);
const r = await submitInstructions(rpc, {
  feeAccount: acct.component, signerIndex: acct.index, live, ceiling: Number(flag("max-fee", "20000")),
  instructions: [callFunction(dep.templates.ListingsBoard, "new", [cbor.component(dep.components.directory), resource(dep.payment_resource), cbor.uint(fee), cbor.uint(maxEpochs)])],
});
if (!live) {
  console.log(`create: dry run fee ${r.required_fee} µT (fee ${fee} µT per post, at most ${maxEpochs} epochs)`);
  process.exit(0);
}
const text = JSON.stringify(r.result);
const board = text.match(/component_[0-9a-f]{64}/g)?.find((c) => c !== dep.components.directory && c !== acct.component);
const entries = text.match(/resource_[0-9a-f]{64}/g)?.find((x) => x !== dep.payment_resource);
dep.components.board = board;
dep.board = { entries_resource: entries, fee_microtari: String(fee), max_duration_epochs: String(maxEpochs) };
dep.transactions.create_board = r.transaction_id;
save();
console.log(`created board ${board} (entries ${entries}) in ${r.transaction_id} (fee ${r.fee} µT); recorded in deployments/esmeralda.json`);
