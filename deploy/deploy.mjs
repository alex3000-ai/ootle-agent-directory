#!/usr/bin/env node
// Publishes the AgentDirectory template and creates the directory through a local wallet daemon.
// Dry-runs by default; --live spends. Writes deployments/<network>.json on success.
//
//   WALLETD_TOKEN_FILE=… node deploy/deploy.mjs --account lanes-admin --name-fee 1000000 [--live]
//
// The name fee (microtari) and payment resource are fixed forever once the directory exists.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { submit, TARI } from "../client/directory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "target/wasm32-unknown-unknown/release/agent_directory.wasm");

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) flags[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const live = flags.live === true;
const account = flags.account || "lanes-admin";
const nameFee = BigInt(flags["name-fee"] ?? 1_000_000);

const url = process.env.WALLETD_URL || "http://127.0.0.1:5102/json_rpc";
let token = process.env.WALLETD_TOKEN ?? (process.env.WALLETD_TOKEN_FILE ? readFileSync(process.env.WALLETD_TOKEN_FILE, "utf8").trim() : undefined);
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

// Publishing needs Templates(Create); without a token, ask a `--authentication none` daemon for a
// short-lived admin token, as the lanes deploy did.
if (!token) token = (await rpc("auth.request", { permissions: ["Admin"], credentials: "None" })).token;

const { accounts } = await rpc("accounts.list", { offset: 0, limit: 100 });
const acct = accounts.find((a) => a.account.name === account);
if (!acct) throw new Error(`no walletd account "${account}"`);
const signerIndex = acct.account.owner_key_id.Derived.index;

// 1. Publish the template.
const binary = readFileSync(WASM).toString("base64");
const publish = (dry_run, max_fee) => rpc("transactions.publish_template", { binary, fee_account: { Name: account }, max_fee, detect_inputs: true, dry_run });
const dry = await publish(true, 3_000_000);
const publishFee = Number(dry.dry_run_fee ?? dry.fee ?? dry.required_fees ?? 0);
console.log(`publish dry run: ${JSON.stringify(dry).slice(0, 300)}`);
if (!live) {
  console.log(`Template is ${(readFileSync(WASM).length / 1024).toFixed(0)} KiB. Re-run with --live to publish and create the directory (name fee ${Number(nameFee) / 1e6} tTARI).`);
  process.exit(0);
}
const published = await publish(false, Math.ceil((publishFee || 2_500_000) * 1.05));
const pubResult = await rpc("transactions.wait_result", { transaction_id: published.transaction_id, timeout_secs: 300 });
if (pubResult.status !== "Accepted") throw new Error(`publish failed: ${JSON.stringify(pubResult).slice(0, 800)}`);
const template = JSON.stringify(pubResult).match(/template_[0-9a-f]{64}/)?.[0] ?? published.template_address;
if (!template) throw new Error(`could not find the template address in ${JSON.stringify(pubResult).slice(0, 800)}`);
console.log(`published ${template} in ${published.transaction_id} (fee ${pubResult.final_fee} µT)`);

// 2. Create the directory.
const manifestFor = (maxFee) => `use ${template} as AgentDirectory;

fn fee_main() {
    let account = var!["account"];
    account.pay_fee(amount!(${maxFee}));
}

fn main() {
    let directory = AgentDirectory::new(TARI, amount!(${nameFee}));
}
`;
const created = await submit(rpc, { manifestFor, variables: { account: acct.account.component_address }, signerIndex, live: true });
const text = JSON.stringify(created.result);
const component = text.match(/component_[0-9a-f]{64}/g)?.find((c) => c !== acct.account.component_address);
const cards = [...new Set(text.match(/resource_[0-9a-f]{64}/g) ?? [])].find((r) => r !== TARI);
console.log(`directory ${component}, cards ${cards} (tx ${created.transaction_id}, fee ${created.fee} µT)`);

mkdirSync(join(ROOT, "deployments"), { recursive: true });
writeFileSync(join(ROOT, "deployments", "esmeralda.json"), JSON.stringify({
  network: "esmeralda",
  deployed: new Date().toISOString().slice(0, 10),
  indexer: "https://ootle-indexer-a.tari.com",
  templates: { AgentDirectory: template },
  components: { directory: component },
  cards_resource: cards,
  payment_resource: TARI,
  name_fee_microtari: String(nameFee),
  transactions: { publish: published.transaction_id, create: created.transaction_id },
}, null, 2) + "\n");
console.log("wrote deployments/esmeralda.json");
