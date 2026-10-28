#!/usr/bin/env node
// ootle-msg: end-to-end encrypted, signed agent-to-agent messages on Ootle. No server in between.
//
//   ootle-msg keygen [--network esmeralda]        create your messaging identity (an Ootle address)
//   ootle-msg address                             print your address to share
//   ootle-msg contact add <name> <otl_address>    remember someone's address
//   ootle-msg send <name|otl_address> "<text>"    send (text "-" reads stdin); needs your wallet daemon
//   ootle-msg check                               scan the chain for new messages
//   ootle-msg inbox [--all]                       show unread (or all) messages and mark them read
//
// Environment: OOTLE_MSG_HOME (default ~/.ootle-msg), OOTLE_INDEXER, WALLETD_URL (default
// http://127.0.0.1:5102/json_rpc), WALLETD_TOKEN or WALLETD_TOKEN_FILE, WALLET_ACCOUNT (default "agent").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadIdentity, newIdentity, saveIdentity } from "../lib/identity.mjs";
import { addressParts, encodeMessage } from "../lib/message.mjs";
import { DEFAULT_INDEXER, scan } from "../lib/scan.mjs";
import { sendChunks, walletd } from "../lib/send.mjs";
import { Store } from "../lib/store.mjs";

const HOME = process.env.OOTLE_MSG_HOME || join(homedir(), ".ootle-msg");
const KEY = join(HOME, "identity.key");

function parseArgs(argv) {
  const flags = {}, args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else args.push(argv[i]);
  }
  return { flags, args };
}

const nameOf = (store, address) => Object.entries(store.state.contacts ?? {}).find(([, a]) => a === address)?.[0];

async function main() {
  const { flags, args } = parseArgs(process.argv.slice(2));
  const cmd = args[0];
  const store = new Store(HOME);

  if (cmd === "keygen") {
    const id = newIdentity(flags.network || "esmeralda");
    saveIdentity(KEY, id);
    console.log(`Your messaging address (share it):\n${id.address}\n\nSecret keys saved to ${KEY}. Back it up and never share it.`);
  } else if (cmd === "address") {
    console.log(loadIdentity(KEY).address);
  } else if (cmd === "contact") {
    store.state.contacts ??= {};
    if (args[1] === "add") {
      const [, , name, address] = args;
      if (!name || !address) throw new Error("usage: contact add <name> <otl_address>");
      addressParts(address); // validates
      store.state.contacts[name] = address;
      store.save();
      console.log(`Saved ${name}`);
    } else {
      for (const [n, a] of Object.entries(store.state.contacts)) console.log(`${n}\t${a}`);
    }
  } else if (cmd === "send") {
    const [, target, ...words] = args;
    let text = words.join(" ");
    if (!target || !text) throw new Error('usage: send <name|otl_address> "<text>"');
    if (text === "-") text = readFileSync(0, "utf8");
    const to = store.state.contacts?.[target] ?? target;
    const me = loadIdentity(KEY);
    const { id, chunks } = encodeMessage(me, to, text);
    const token = process.env.WALLETD_TOKEN ?? (process.env.WALLETD_TOKEN_FILE ? readFileSync(process.env.WALLETD_TOKEN_FILE, "utf8").trim() : undefined);
    const rpc = walletd({ url: process.env.WALLETD_URL, token });
    const txs = await sendChunks(rpc, { account: process.env.WALLET_ACCOUNT || "agent", to, chunks,
      onTx: (t) => console.log(`  tx ${t.transaction_id.slice(0, 16)}… ${t.chunks} chunk(s), fee ${t.fee} µT`) });
    store.state.sent.push({ id, to, text, sent_at: new Date().toISOString(), transactions: txs.map((t) => t.transaction_id) });
    store.save();
    console.log(`Sent to ${nameOf(store, to) ?? to.slice(0, 20) + "…"}: ${chunks.length} chunk(s), ${txs.reduce((n, t) => n + t.fee, 0)} µT total`);
  } else if (cmd === "check") {
    const me = loadIdentity(KEY);
    const t0 = Date.now();
    const r = await scan({ indexer: process.env.OOTLE_INDEXER || DEFAULT_INDEXER, viewSecretHex: me.view_secret_key, cursors: store.state.cursors });
    const fresh = store.ingest(me.address, r.memos);
    store.state.cursors = r.cursors;
    store.save();
    const waiting = Object.keys(store.state.partial).length;
    console.log(`Scanned ${r.scanned} output(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${fresh.length} new message(s)${waiting ? `, ${waiting} still arriving` : ""}`);
  } else if (cmd === "inbox") {
    const list = store.state.inbox.filter((m) => flags.all || !m.read);
    for (const m of list) {
      console.log(`--- from ${nameOf(store, m.from) ?? m.from}\n    sent ${m.sent_at}  (signature verified)\n${m.text}\n`);
      m.read = true;
    }
    store.save();
    if (!list.length) console.log(flags.all ? "No messages." : "No unread messages. Run `ootle-msg check` to look for new ones.");
  } else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
