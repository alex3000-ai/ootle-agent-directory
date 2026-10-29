#!/usr/bin/env node
// Publishes a template and creates its component through a local wallet daemon, recording both in
// deployments/esmeralda.json. Dry-runs by default; --live spends. Every setting is fixed forever once created.
//   PATH="$HOME/.cargo/bin:$PATH" cargo build --release --target wasm32-unknown-unknown
//   node deploy/publish.mjs directory --account A [--name-fee 1000000] [--live]
//   node deploy/publish.mjs channel   --account A [--live]                 (agents create their own channels)
//   node deploy/publish.mjs board     --account A [--fee 10000] [--max-epochs 2000] [--live]
//   --create-only skips publishing and uses the template already recorded.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountInfo, callFunction, cbor, parseArgs, publishTemplate, submitInstructions, TARI, usage, walletd } from "../client/tx.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "deployments", "esmeralda.json");
const { flags, args: [which] } = parseArgs(process.argv.slice(2));
const TEMPLATES = {
  directory: { crate: "agent_directory", name: "AgentDirectory", tx: "publish" },
  channel: { crate: "agent_channel", name: "AgentChannel", tx: "publish_channel" },
  board: { crate: "listings_board", name: "ListingsBoard", tx: "publish_board" },
};
const t = TEMPLATES[which];
if (!t || !flags.account) usage(import.meta.url, which ?? "missing");
const live = flags.live === true;

const dep = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : { network: "esmeralda", indexer: "https://ootle-indexer-a.tari.com", payment_resource: TARI };
dep.templates ??= {};
dep.components ??= {};
dep.transactions ??= {};
const save = () => writeFileSync(PATH, JSON.stringify(dep, null, 2) + "\n");
const rpc = walletd();

if (!flags["create-only"]) {
  const wasm = join(ROOT, `target/wasm32-unknown-unknown/release/${t.crate}.wasm`);
  const p = await publishTemplate(rpc, { wasm, account: flags.account, live });
  if (!live) console.log(`publish ${t.name}: dry run fee ${p.dry_run_fee} µT for a ${(readFileSync(wasm).length / 1024).toFixed(0)} KiB template`);
  else {
    dep.templates[t.name] = p.template;
    dep.transactions[t.tx] = p.transaction_id;
    save();
    console.log(`published ${p.template} in ${p.transaction_id} (fee ${p.fee} µT)`);
  }
}
if (which === "channel" || (!live && !dep.templates[t.name])) process.exit(0);

const settings = which === "directory"
  ? [cbor.resource(TARI), cbor.uint(flags["name-fee"] ?? 1_000_000)]
  : [cbor.component(dep.components.directory), cbor.resource(dep.payment_resource), cbor.uint(flags.fee ?? 10_000), cbor.uint(flags["max-epochs"] ?? 2_000)];
const acct = await accountInfo(rpc, flags.account);
const r = await submitInstructions(rpc, {
  feeAccount: acct.component, signerIndex: acct.index, live, ceiling: Number(flags["max-fee"] ?? 20_000),
  instructions: [callFunction(dep.templates[t.name], "new", settings)],
});
if (!live) {
  console.log(`create ${t.name}: dry run fee ${r.required_fee} µT`);
  process.exit(0);
}
const text = JSON.stringify(r.result);
const component = text.match(/component_[0-9a-f]{64}/g)?.find((c) => c !== dep.components.directory && c !== acct.component);
const resource = text.match(/resource_[0-9a-f]{64}/g)?.find((x) => x !== TARI);
if (which === "directory") {
  Object.assign(dep, { deployed: new Date().toISOString().slice(0, 10), cards_resource: resource, name_fee_microtari: String(flags["name-fee"] ?? 1_000_000) });
  dep.components.directory = component;
  dep.transactions.create = r.transaction_id;
} else {
  dep.components.board = component;
  dep.board = { entries_resource: resource, fee_microtari: String(flags.fee ?? 10_000), max_duration_epochs: String(flags["max-epochs"] ?? 2_000) };
  dep.transactions.create_board = r.transaction_id;
}
save();
console.log(`created ${t.name} ${component} (resource ${resource}) in ${r.transaction_id} (fee ${r.fee} µT); recorded in deployments/esmeralda.json`);
