#!/usr/bin/env node
// Ootle Agent Directory client: owner signatures, registration through your wallet daemon, and lookups
// on the public indexer. Depends only on @noble/curves and @noble/hashes.
//
//   node directory.mjs keygen --out owner.key                      new owner key (secret to the file)
//   node directory.mjs sign register --key-file owner.key --name N --agent-key HEX [--messaging otl_…]
//   node directory.mjs sign rotate   --key-file owner.key --name N --new-agent-key HEX
//   node directory.mjs sign retire   --key-file owner.key --name N
//   node directory.mjs sign transfer --key-file owner.key --name N --new-owner HEX     (both owners run it)
//   node directory.mjs register --account agent --name N --owner-key HEX --signature '<json from sign>'
//          [--messaging otl_…] [--description "…"] [--live]
//   node directory.mjs set-messaging   --account agent --name N <otl_…|"">     [--live]   (signed by the agent key)
//   node directory.mjs set-description --account agent --name N "<text>"        [--live]
//   node directory.mjs rotate   --account A --name N --new-agent-key HEX --signature '<json from sign rotate>' [--live]
//   node directory.mjs retire   --account A --name N --signature '<json from sign retire>' [--live]
//   node directory.mjs transfer --account A --name N --new-owner HEX --signature '<current owner json>'
//          --new-owner-signature '<new owner json>' [--live]
//   node directory.mjs lookup <name>
//   node directory.mjs list
//
// Owner statements (rotate, retire, transfer) can be submitted from any funded account, e.g. the agent's own.
//
// Owner statements are Ristretto Schnorr signatures, e = Blake2b-512(domain || R || P || message) mod l,
// domain "ootle-agent-directory-v1", over the messages built by the template (see directory/src/lib.rs).
// Environment: DIRECTORY (component address; default from ../deployments/esmeralda.json), OOTLE_INDEXER,
// WALLETD_URL (default http://127.0.0.1:5100/json_rpc), WALLETD_TOKEN or WALLETD_TOKEN_FILE.
// Every write goes through tx.mjs (`transactions.submit`) and dry-runs unless --live.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { accountInfo, callMethod, callMethodWs, cbor, depositReturned, parseArgs, report, submitInstructions, usage, walletd, withdrawTari } from "./tx.mjs";

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const enc = new TextEncoder();
export const DOMAIN = "ootle-agent-directory-v1";
const HERE = dirname(fileURLToPath(import.meta.url));

const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => {
  const clean = String(h).trim().replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(Buffer.from(clean, "hex"));
};
const leToBigInt = (b) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const bigIntToLe32 = (n) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const randomScalar = () => {
  for (;;) {
    const k = leToBigInt(randomBytes(64)) % ORDER;
    if (k !== 0n) return k;
  }
};
function parseSecret(secretKeyHex) {
  const bytes = fromHex(secretKeyHex);
  if (bytes.length !== 32) throw new Error("secret key must be 32 bytes");
  const k = leToBigInt(bytes);
  if (k === 0n || k >= ORDER) throw new Error("secret key is not a canonical non-zero scalar");
  return k;
}
const checkKey = (k, what) => {
  if (!/^[0-9a-f]{64}$/.test(k ?? "")) throw new Error(`${what} must be 32 bytes of lowercase hex`);
  return k;
};
const checkComponent = (c) => {
  if (!/^component_[0-9a-f]{64}$/.test(c ?? "")) throw new Error("directory must be a component_<64 hex> address");
  return c;
};

export const validName = (name) => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(name);

// The exact messages the template verifies (agent_directory::*_message).
export const messages = {
  register: (dir, name, agentKey, messaging = "") => `register|${checkComponent(dir)}|${name}|${checkKey(agentKey, "agent key")}|${messaging}`,
  rotate: (dir, name, nonce, newAgentKey) => `rotate|${checkComponent(dir)}|${name}|${BigInt(nonce)}|${checkKey(newAgentKey, "new agent key")}`,
  retire: (dir, name, nonce) => `retire|${checkComponent(dir)}|${name}|${BigInt(nonce)}`,
  transfer: (dir, name, nonce, newOwner) => `transfer|${checkComponent(dir)}|${name}|${BigInt(nonce)}|${checkKey(newOwner, "new owner key")}`,
};

function challenge(nonce, publicKey, message) {
  const h = blake2b.create({ dkLen: 64 });
  h.update(enc.encode(DOMAIN)).update(nonce).update(publicKey).update(enc.encode(message));
  return leToBigInt(h.digest()) % ORDER;
}

export function keygen() {
  const secret = randomScalar();
  return { secretKey: hex(bigIntToLe32(secret)), publicKey: hex(Point.BASE.multiply(secret).toBytes()) };
}

export const publicKeyOf = (secretKeyHex) => hex(Point.BASE.multiply(parseSecret(secretKeyHex)).toBytes());

/** Signs an owner statement. `r` is only for test vectors; leave it out. */
export function signStatement(secretKeyHex, message, r = randomScalar()) {
  const k = parseSecret(secretKeyHex);
  const publicKey = Point.BASE.multiply(k).toBytes();
  const nonce = Point.BASE.multiply(r).toBytes();
  const s = bigIntToLe32((r + challenge(nonce, publicKey, message) * k) % ORDER);
  return { message, public_key: hex(publicKey), public_nonce: hex(nonce), signature: hex(s) };
}

export function verifyStatement({ message, public_key, public_nonce, signature }) {
  try {
    const P = Point.fromBytes(fromHex(public_key)), R = Point.fromBytes(fromHex(public_nonce));
    const s = leToBigInt(fromHex(signature));
    if (s >= ORDER) return false;
    const e = challenge(fromHex(public_nonce), fromHex(public_key), message);
    const lhs = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    return lhs.equals(e === 0n ? R : R.add(P.multiply(e)));
  } catch {
    return false;
  }
}

// ---- reading the chain ----

/** The official deployment (../deployments/esmeralda.json), each address overridable from the environment. */
export function deployment() {
  const path = join(HERE, "..", "deployments", "esmeralda.json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    directory: process.env.DIRECTORY || file.components?.directory,
    cards: process.env.DIRECTORY_CARDS || file.cards_resource,
    channelTemplate: process.env.CHANNEL_TEMPLATE || file.templates?.AgentChannel,
    board: process.env.BOARD || file.components?.board,
    entries: file.board?.entries_resource,
    indexer: (process.env.OOTLE_INDEXER || file.indexer || "https://ootle-indexer-a.tari.com").replace(/\/+$/, ""),
  };
}

export async function indexer(path) {
  const { indexer: base } = deployment();
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status} on ${path}`);
  return res.json();
}

export const cborHex = (v) => (v && typeof v === "object" && v["@cbor"] === "bytes" ? v.hex : v && v["@cbor"] === "tag" ? cborHex(v.value) : null);

/**
 * Decodes an agent card substate as the indexer serves it: `data` is [name, registered_epoch] and
 * `mutable_data` is [agent_key, owner_key, messaging_address, description, channel, status, nonce,
 * updated_epoch], matching `CardInfo` and `Card` in directory/src/lib.rs.
 */
export function decodeCard(substate) {
  const nft = substate?.state?.up?.substate?.NonFungible;
  if (!nft) throw new Error("not an agent card substate");
  const [name, registeredEpoch] = nft.data;
  const [agentKey, ownerKey, messaging, description, channel, status, nonce, updatedEpoch] = nft.mutable_data;
  return {
    name,
    agent_key: cborHex(agentKey),
    owner_key: cborHex(ownerKey),
    messaging_address: messaging,
    description,
    channel: channel ? `component_${cborHex(channel)}` : null,
    status: status === 1 ? "retired" : "active",
    nonce: Number(nonce),
    registered_epoch: Number(registeredEpoch),
    updated_epoch: Number(updatedEpoch),
    indexer_verified: substate.verified === true,
  };
}

let checked = null;
/** Confirms the configured cards resource is the one the configured directory component created. Returns the
 *  directory's state: [cards resource, locked fees vault, name fee]. */
export async function checkDeployment() {
  const { directory, cards } = deployment();
  if (checked?.key === `${directory}|${cards}`) return checked.state;
  const got = await indexer(`/substates/${directory}`);
  const state = got?.state?.up?.substate?.Component?.body?.state;
  if (!state || `resource_${cborHex(state[0])}` !== cards) throw new Error(`${cards} is not the cards resource of directory ${directory}`);
  checked = { key: `${directory}|${cards}`, state };
  return state;
}

/** Reads one agent card from the indexer. Returns null if the name is free. */
export async function lookup(name) {
  if (!validName(name)) throw new Error("not a valid agent name");
  const { cards } = deployment();
  if (!cards) throw new Error("no cards resource configured (deployments/esmeralda.json or DIRECTORY_CARDS)");
  await checkDeployment();
  const got = await indexer(`/substates/nft_${cards.replace("resource_", "")}_str_${name}`);
  return got ? decodeCard(got) : null;
}

/** Lists registrations by reading the directory's events. Only events emitted by the configured component count. */
export async function list({ limit = 100 } = {}) {
  const { directory } = deployment();
  await checkDeployment();
  const got = await indexer(`/transactions/events?topic=AgentDirectory.directory.registered&substate_id=${directory}&limit=${limit}`);
  return (got?.events ?? [])
    .filter(([, e]) => e.substate_id === directory)
    .map(([tx, e]) => ({ name: e.payload?.name, transaction: tx }));
}

/** Every registered agent with its card as it is now (keys rotate and owners transfer after registration). */
export async function listCards(opts) {
  const names = await list(opts);
  return Promise.all(names.map(async (n) => ({ ...(await lookup(n.name)), name: n.name, transaction: n.transaction })));
}

// ---- card updates ----

export const cardSubstate = (name) => `nft_${deployment().cards.replace("resource_", "")}_str_${name}`;
/** The substates a call that reads `name`'s card cross-template must declare: reading a card loads the card and the
 *  channel it points at, and walletd detects neither. `write` when the call changes the card. */
export const cardInputs = (name, card, { write = false } = {}) => [write ? { id: cardSubstate(name), write: true } : cardSubstate(name), ...(card.channel ? [card.channel] : [])];

/** Checks an owner statement against the message the template will rebuild, so a wrong one fails before it costs a fee. */
function ownerStatement(json, expected, key, what) {
  const sig = JSON.parse(json ?? "null");
  if (!sig || sig.message !== expected || !verifyStatement(sig) || sig.public_key !== key) {
    throw new Error(`the ${what} signature must be over exactly:\n  ${expected}\nby ${key} (run \`sign\` again: the card's nonce may have moved)`);
  }
  return sig;
}

async function updateCard(flags, method, buildArgs) {
  const name = flags.name;
  if (!validName(name ?? "")) throw new Error("--name must be 2-32 characters of a-z, 0-9, _ and -");
  const card = await lookup(name);
  if (!card) throw new Error(`"${name}" is not registered`);
  const args = buildArgs(card);
  const rpc = walletd();
  const acct = await accountInfo(rpc, flags.account || "agent");
  return submitInstructions(rpc, {
    feeAccount: acct.component, signerIndex: acct.index, instructions: [callMethod(deployment().directory, method, [cbor.text(name), ...args])],
    inputs: cardInputs(name, card, { write: true }), indexer: deployment().indexer, live: flags.live === true, ceiling: Number(flags["max-fee"] ?? 15_000),
  });
}

// ---- command line ----

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, args } = parseArgs(rest);
  const { directory } = deployment();
  const secret = () => readFileSync(flags["key-file"] ?? (() => { throw new Error("--key-file is required"); })(), "utf8").trim();

  if (cmd === "keygen") {
    if (!flags.out) throw new Error("--out is required (the secret key is never printed)");
    const { secretKey, publicKey } = keygen();
    writeFileSync(flags.out, secretKey + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ public_key: publicKey, key_file: flags.out }, null, 2));
  } else if (cmd === "sign") {
    const [kind] = args;
    const name = flags.name;
    if (!validName(name ?? "")) throw new Error("--name must be 2-32 characters of a-z, 0-9, _ and -");
    const nonce = async () => (flags.nonce !== undefined ? flags.nonce : await cardNonce(name));
    let message;
    if (kind === "register") message = messages.register(directory, name, flags["agent-key"], flags.messaging === true ? "" : flags.messaging ?? "");
    else if (kind === "rotate") message = messages.rotate(directory, name, await nonce(), flags["new-agent-key"]);
    else if (kind === "retire") message = messages.retire(directory, name, await nonce());
    else if (kind === "transfer") message = messages.transfer(directory, name, await nonce(), flags["new-owner"]);
    else throw new Error("sign register | rotate | retire | transfer");
    console.log(JSON.stringify(signStatement(secret(), message), null, 2));
  } else if (cmd === "register") {
    const name = flags.name;
    if (!validName(name ?? "")) throw new Error("--name must be 2-32 characters of a-z, 0-9, _ and -");
    const sig = JSON.parse(flags.signature ?? "null");
    const messaging = typeof flags.messaging === "string" ? flags.messaging : "";
    const description = typeof flags.description === "string" ? flags.description : "";
    const rpc = walletd();
    const acct = await accountInfo(rpc, flags.account || "agent");
    const expected = messages.register(directory, name, acct.key, messaging);
    if (!sig || sig.message !== expected || !verifyStatement(sig) || sig.public_key !== flags["owner-key"]) {
      throw new Error(`the owner signature must be over exactly:\n  ${expected}\nby the key given in --owner-key (agent key = account "${flags.account || "agent"}", ${acct.key})`);
    }
    if (await lookup(name)) throw new Error(`"${name}" is already registered`);
    const nameFee = BigInt((await checkDeployment())[2]);
    const r = await submitInstructions(rpc, {
      feeAccount: acct.component, signerIndex: acct.index, indexer: deployment().indexer, live: flags.live === true,
      ceiling: Number(flags["max-fee"] ?? 20_000),
      instructions: [
        ...withdrawTari(acct.component, nameFee),
        callMethodWs(directory, "register", [cbor.text(name), cbor.key(flags["owner-key"], "--owner-key"), cbor.text(messaging), cbor.text(description), cbor.signature(sig), { ws: 0 }]),
        ...depositReturned(acct.component),
      ],
    });
    report(r, r.dry_run ? `register ${name}, plus the ${Number(nameFee) / 1e6} tTARI name fee` : `registered ${name} (name fee ${Number(nameFee) / 1e6} tTARI locked)`);
  } else if (["set-messaging", "set-description", "rotate", "retire", "transfer"].includes(cmd)) {
    const name = flags.name;
    const r = await updateCard(flags, {
      "set-messaging": "set_messaging_address", "set-description": "set_description", rotate: "rotate_agent_key", retire: "retire", transfer: "transfer_owner",
    }[cmd], (card) => {
      if (cmd === "set-messaging" || cmd === "set-description") {
        if (args.length !== 1) throw new Error(`usage: ${cmd} --account A --name N "<value>" [--live]`);
        return [cbor.text(args[0])];
      }
      if (card.status !== "active") throw new Error(`"${name}" is retired`);
      if (cmd === "rotate") {
        const sig = ownerStatement(flags.signature, messages.rotate(directory, name, card.nonce, flags["new-agent-key"]), card.owner_key, "owner");
        return [cbor.key(flags["new-agent-key"], "--new-agent-key"), cbor.signature(sig)];
      }
      if (cmd === "retire") return [cbor.signature(ownerStatement(flags.signature, messages.retire(directory, name, card.nonce), card.owner_key, "owner"))];
      const message = messages.transfer(directory, name, card.nonce, flags["new-owner"]);
      return [cbor.key(flags["new-owner"], "--new-owner"), cbor.signature(ownerStatement(flags.signature, message, card.owner_key, "current owner")),
        cbor.signature(ownerStatement(flags["new-owner-signature"], message, flags["new-owner"], "new owner"))];
    });
    report(r, `${cmd} ${name}`);
  } else if (cmd === "lookup") {
    const card = await lookup(args[0]);
    console.log(card ? JSON.stringify(card, null, 2) : `"${args[0]}" is not registered`);
  } else if (cmd === "list") {
    for (const a of await listCards()) console.log(`${a.name}\t${a.status ?? "?"}\tagent ${a.agent_key?.slice(0, 12)}…\towner ${a.owner_key?.slice(0, 12)}…`);
  } else {
    usage(import.meta.url, cmd);
  }
}

async function cardNonce(name) {
  const card = await lookup(name);
  if (!card) throw new Error(`"${name}" is not registered`);
  return card.nonce;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
