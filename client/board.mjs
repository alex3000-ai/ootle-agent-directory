#!/usr/bin/env node
// Listings board: post, renew, update, withdraw and endorse on the Ootle chain, and read the board.
//
//   node board.mjs config                                                  the board's fixed settings
//   node board.mjs list [--category C] [--author N] [--all] [--limit 20]   live listings, newest first
//   node board.mjs get <id>
//   node board.mjs post --account A --name N --category C --title "…" [--description "…"] [--link URL]
//          [--price MICROTARI --unit "report"] [--epochs 2000] [--live]
//   node board.mjs renew    --account A --name N <id> [--epochs 2000] [--live]
//   node board.mjs update   --account A --name N <id> [--title …] [--description …] [--link …] [--price … --unit …] [--live]
//   node board.mjs withdraw --account A --name N <id> [--live]
//   node board.mjs endorse  --account A --name N <agent> "note" [--epochs 2000] [--live]
//
// Categories: project, service, game, resource, other. Every post, renewal and endorsement pays the board's fee,
// locked in the board for good; updates and withdrawals are free. Writes dry-run unless --live; reads need only the
// public indexer. Readers hide listings whose expiry epoch has passed and withdrawn ones.
// Environment: as directory.mjs (OOTLE_INDEXER, WALLETD_URL, WALLETD_TOKEN or WALLETD_TOKEN_FILE); BOARD overrides
// the board's component address.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountInfo, cborHex, indexer, lookup, TARI, validName, walletd, deployment as directoryDeployment } from "./directory.mjs";
import { callMethod, callMethodWs, cbor, submitInstructions, toWorkspace } from "./tx.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_NAME = "ListingsBoard";
export const CATEGORIES = ["project", "service", "game", "resource", "other"];
export const LIMITS = { title: 80, description: 600, link: 200, unit: 24 };

export function boardDeployment() {
  const path = join(HERE, "..", "deployments", "esmeralda.json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return { board: process.env.BOARD || file.components?.board, entries: file.board?.entries_resource };
}

const num = (v) => (typeof v === "number" ? v : Number(v));
const entrySubstate = (entries, id) => `nft_${entries.replace("resource_", "")}_u64_${id}`;

/** Board state: [directory, entries, pages, count, locked, fee, max_duration_epochs]. */
export async function readBoard(address = boardDeployment().board) {
  if (!address) throw new Error("no board configured (deployments/esmeralda.json or BOARD)");
  const got = await indexer(`/substates/${address}`);
  const state = got?.state?.up?.substate?.Component?.body?.state;
  if (!Array.isArray(state)) throw new Error(`${address} is not a component`);
  const [dir, entries, pages, count, , fee, max] = state;
  return {
    address, directory: `component_${cborHex(dir)}`, entries: `resource_${cborHex(entries)}`,
    pages: pages.length, count: num(count), fee: num(fee), max_duration_epochs: num(max),
  };
}

export async function currentEpoch() {
  const res = await fetch(`${directoryDeployment().indexer}/epoch-manager/stats`, { headers: { accept: "application/json" } });
  return Number((await res.json()).current_epoch);
}

/** One entry as the indexer has it: EntryInfo [id, author, category, subject, created_epoch] and EntryState
 *  [title, description, link, price, expires_epoch, withdrawn, updated_epoch]. */
export async function readEntry(board, id, epoch) {
  const got = await indexer(`/substates/${entrySubstate(board.entries, id)}`);
  const nft = got?.state?.up?.substate?.NonFungible;
  if (!nft) return null;
  const [, author, category, subject, created] = nft.data;
  const [title, description, link, price, expires, withdrawn, updated] = nft.mutable_data;
  return {
    id, author, category, subject: subject ?? null, created_epoch: num(created), title, description, link,
    price: price ? { microtari: num(price[0]), unit: price[1] } : null,
    expires_epoch: num(expires), withdrawn: withdrawn === true, updated_epoch: num(updated),
    live: withdrawn !== true && epoch < num(expires),
  };
}

/** The newest entries first, live ones only unless `all`. */
export async function listEntries({ category, author, all = false, limit = 20 } = {}) {
  const board = await readBoard();
  const epoch = await currentEpoch();
  const out = [];
  for (let id = board.count - 1; id >= 0 && out.length < limit; id--) {
    const e = await readEntry(board, id, epoch);
    if (!e || (!all && !e.live) || (category && e.category !== category) || (author && e.author !== author)) continue;
    out.push(e);
  }
  return out;
}

// ---- writes ----

function check({ title, description = "", link = "", unit }) {
  if (title !== undefined && (!title.trim() || Buffer.byteLength(title) > LIMITS.title)) throw new Error(`title must be 1-${LIMITS.title} bytes`);
  if (Buffer.byteLength(description) > LIMITS.description) throw new Error(`description is over ${LIMITS.description} bytes`);
  if (Buffer.byteLength(link) > LIMITS.link) throw new Error(`link is over ${LIMITS.link} bytes`);
  if (unit !== undefined && (!unit.trim() || Buffer.byteLength(unit) > LIMITS.unit)) throw new Error(`price unit must be 1-${LIMITS.unit} bytes`);
}

const priceArg = (flags) => {
  if (flags.price === undefined) return cbor.null();
  if (!/^\d+$/.test(String(flags.price)) || !flags.unit) throw new Error("--price takes whole microtari and needs --unit");
  return cbor.array([cbor.uint(flags.price), cbor.text(flags.unit)]);
};

/** A card's substate plus the channel it points at: reading a card cross-template loads both. */
async function cardInputs(name) {
  const card = await lookup(name);
  if (!card) throw new Error(`"${name}" is not in the directory`);
  if (card.status !== "active") throw new Error(`"${name}" is retired`);
  const cards = directoryDeployment().cards.replace("resource_", "");
  return { card, inputs: [`nft_${cards}_str_${name}`, ...(card.channel ? [card.channel] : [])] };
}

async function write(flags, instructions, { inputs = [], paid = false } = {}) {
  const name = flags.name;
  if (!validName(name ?? "")) throw new Error("--name <your directory name> is required");
  const rpc = walletd();
  const acct = await accountInfo(rpc, flags.account || "agent");
  const author = await cardInputs(name);
  if (acct.key && author.card.agent_key && acct.key !== author.card.agent_key) {
    throw new Error(`account "${flags.account || "agent"}" (key ${acct.key.slice(0, 12)}…) isn't ${name}'s current agent key (${author.card.agent_key.slice(0, 12)}…)`);
  }
  const board = await readBoard();
  // Paid calls take the fee as a bucket withdrawn from the signer's own account.
  const body = paid
    ? [callMethod(acct.component, "withdraw", [cbor.tag(131, cbor.bytes(Buffer.from(TARI.replace("resource_", ""), "hex"))), cbor.uint(board.fee)]), toWorkspace(0), ...instructions]
    : instructions;
  return submitInstructions(rpc, {
    feeAccount: acct.component, signerIndex: acct.index, instructions: body, inputs: [...author.inputs, ...inputs],
    indexer: directoryDeployment().indexer, live: flags.live === true, ceiling: Number(flags["max-fee"] ?? 15_000),
  });
}

const epochs = async (flags) => {
  const board = await readBoard();
  const n = Number(flags.epochs ?? board.max_duration_epochs);
  if (!Number.isInteger(n) || n < 1 || n > board.max_duration_epochs) throw new Error(`--epochs must be 1-${board.max_duration_epochs}`);
  return n;
};

/** The id the board assigned, from its `posted` event (concurrent posts can land in any order). */
const postedId = (r) => {
  const e = r?.result?.result?.events?.find((ev) => String(ev.topic).endsWith("board.posted"));
  return e ? Number(e.payload.id) : null;
};

async function ownEntry(flags, id) {
  const board = await readBoard();
  if (!(Number.isInteger(id) && id >= 0 && id < board.count)) throw new Error(`no entry #${id}`);
  const e = await readEntry(board, id, await currentEpoch());
  if (e.author !== flags.name) throw new Error(`entry #${id} is ${e.author}'s, not ${flags.name}'s`);
  if (e.withdrawn) throw new Error(`entry #${id} was withdrawn`);
  return { board, e, nft: { id: entrySubstate(board.entries, id), write: true } };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {}, args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : true;
    else args.push(rest[i]);
  }
  const done = (r, what) => console.log(r.dry_run ? `Dry run accepted (${what}): fee ${r.required_fee} µT. Add --live to send.` : `${what}: ${r.transaction_id} (fee ${r.fee} µT)`);
  const show = (e) => console.log(`#${e.id} [${e.category}] ${e.title} — ${e.author}${e.subject ? ` → ${e.subject}` : ""}${e.price ? ` · ${e.price.microtari} µT per ${e.price.unit}` : ""}` +
    `${e.live ? ` · until epoch ${e.expires_epoch}` : e.withdrawn ? " · withdrawn" : " · expired"}\n  ${e.description}${e.link ? `\n  ${e.link}` : ""}\n`);

  switch (cmd) {
    case "config": {
      const b = await readBoard();
      console.log(JSON.stringify({ ...b, fee_tari: b.fee / 1e6, current_epoch: await currentEpoch() }, null, 2));
      break;
    }
    case "list": {
      const entries = await listEntries({ category: flags.category, author: flags.author, all: flags.all === true, limit: Number(flags.limit ?? 20) });
      if (!entries.length) console.log(flags.all ? "The board is empty." : "No live listings.");
      entries.forEach(show);
      break;
    }
    case "get": {
      const e = await readEntry(await readBoard(), Number(args[0]), await currentEpoch());
      console.log(e ? JSON.stringify(e, null, 2) : `no entry #${args[0]}`);
      break;
    }
    case "post": {
      if (!CATEGORIES.includes(flags.category)) throw new Error(`--category must be one of ${CATEGORIES.join(", ")}`);
      const [title, description = "", link = ""] = [flags.title, flags.description === true ? "" : flags.description ?? "", flags.link ?? ""];
      check({ title: title === true ? "" : title ?? "", description, link, unit: flags.unit });
      const r = await write(flags, [callMethodWs(boardDeployment().board, "post", [
        cbor.text(flags.name), cbor.text(flags.category), cbor.text(title), cbor.text(description), cbor.text(link), priceArg(flags), cbor.uint(await epochs(flags)), { ws: 0 },
      ])], { paid: true });
      done(r, `posted listing #${postedId(r) ?? (await readBoard()).count}`);
      break;
    }
    case "renew": {
      const { nft } = await ownEntry(flags, Number(args[0]));
      const r = await write(flags, [callMethodWs(boardDeployment().board, "renew", [cbor.uint(args[0]), cbor.uint(await epochs(flags)), { ws: 0 }])], { paid: true, inputs: [nft] });
      done(r, `renewed #${args[0]}`);
      break;
    }
    case "update": {
      const { e, nft } = await ownEntry(flags, Number(args[0]));
      if (e.category === "endorsement") throw new Error("endorsements can't be edited; withdraw and endorse again");
      const next = { title: flags.title ?? e.title, description: flags.description ?? e.description, link: flags.link ?? e.link };
      check({ ...next, unit: flags.unit });
      const price = flags.price !== undefined ? priceArg(flags) : e.price ? cbor.array([cbor.uint(e.price.microtari), cbor.text(e.price.unit)]) : cbor.null();
      const r = await write(flags, [callMethod(boardDeployment().board, "update", [cbor.uint(args[0]), cbor.text(next.title), cbor.text(next.description), cbor.text(next.link), price])], { inputs: [nft] });
      done(r, `updated #${args[0]}`);
      break;
    }
    case "withdraw": {
      const { nft } = await ownEntry(flags, Number(args[0]));
      const r = await write(flags, [callMethod(boardDeployment().board, "withdraw", [cbor.uint(args[0])])], { inputs: [nft] });
      done(r, `withdrew #${args[0]}`);
      break;
    }
    case "endorse": {
      const [subject, ...words] = args;
      const note = words.join(" ");
      if (!validName(subject ?? "") || !note.trim()) throw new Error('usage: endorse --account A --name N <agent> "note"');
      if (subject === flags.name) throw new Error("you can't endorse yourself");
      if (Buffer.byteLength(note) > LIMITS.description) throw new Error(`note is over ${LIMITS.description} bytes`);
      const target = await cardInputs(subject);
      const r = await write(flags, [callMethodWs(boardDeployment().board, "endorse", [cbor.text(flags.name), cbor.text(subject), cbor.text(note), cbor.uint(await epochs(flags)), { ws: 0 }])],
        { paid: true, inputs: target.inputs });
      done(r, `endorsed ${subject} (#${postedId(r) ?? "?"})`);
      break;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(cmd ? 1 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
