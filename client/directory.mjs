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
//   node directory.mjs lookup <name>
//   node directory.mjs list
//
// Owner statements are Ristretto Schnorr signatures, e = Blake2b-512(domain || R || P || message) mod l,
// domain "ootle-agent-directory-v1", over the messages built by the template (see directory/src/lib.rs).
// Environment: DIRECTORY (component address; default from ../deployments/esmeralda.json), OOTLE_INDEXER,
// WALLETD_URL (default http://127.0.0.1:5102/json_rpc), WALLETD_TOKEN or WALLETD_TOKEN_FILE.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const enc = new TextEncoder();
export const DOMAIN = "ootle-agent-directory-v1";
export const TARI = "resource_" + "01".repeat(32);
export const TEMPLATE_NAME = "AgentDirectory";
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

/** The `SignaturePayload` argument for a manifest. */
export const manifestSig = ({ public_nonce, signature }) => `cbor!([0, [[public_key!("${checkKey(public_nonce, "nonce")}"), hex_bytes!("${checkKey(signature, "signature")}")]]])`;

// Manifest string literals: only plain printable text, so nothing can break out of the quotes.
const literal = (s, what) => {
  if (!/^[\x20-\x7e]*$/.test(s) || /["\\]/.test(s)) throw new Error(`${what} may only contain printable ASCII without quotes or backslashes`);
  return `"${s}"`;
};

export function registerManifest({ name, ownerKey, messaging = "", description = "", sig, fee }) {
  return `fn fee_main() {
    let agent = var!["agent"];
    agent.pay_fee(amount!(${Number(fee.max_fee)}));
}

fn main() {
    let agent = var!["agent"];
    let directory = var!["directory"];
    let fee = agent.withdraw(TARI, amount!(${BigInt(fee.name_fee)}));
    let card = directory.register(${literal(name, "name")}, public_key!("${checkKey(ownerKey, "owner key")}"), ${literal(messaging, "messaging address")}, ${literal(description, "description")}, ${manifestSig(sig)}, fee);
    agent.deposit(card);
}
`;
}

// ---- reading the chain ----

export function deployment() {
  const path = join(HERE, "..", "deployments", "esmeralda.json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    directory: process.env.DIRECTORY || file.components?.directory,
    cards: process.env.DIRECTORY_CARDS || file.cards_resource,
    indexer: (process.env.OOTLE_INDEXER || file.indexer || "https://ootle-indexer-a.tari.com").replace(/\/+$/, ""),
  };
}

async function indexer(path) {
  const { indexer: base } = deployment();
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status} on ${path}`);
  return res.json();
}

const cborHex = (v) => (v && typeof v === "object" && v["@cbor"] === "bytes" ? v.hex : v && v["@cbor"] === "tag" ? cborHex(v.value) : null);

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

let checkedDeployment = null;
/** Confirms the configured cards resource is the one the configured directory component created. */
export async function checkDeployment() {
  const { directory, cards } = deployment();
  if (checkedDeployment === `${directory}|${cards}`) return;
  const got = await indexer(`/substates/${directory}`);
  const state = got?.state?.up?.substate?.Component?.body?.state;
  if (!state || `resource_${cborHex(state[0])}` !== cards) throw new Error(`${cards} is not the cards resource of directory ${directory}`);
  checkedDeployment = `${directory}|${cards}`;
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
  const got = await indexer(`/transactions/events?topic=${TEMPLATE_NAME}.directory.registered&substate_id=${directory}&limit=${limit}`);
  return (got?.events ?? [])
    .filter(([, e]) => e.substate_id === directory)
    .map(([tx, e]) => ({ name: e.payload?.name, agent_key: e.payload?.agent_key, owner_key: e.payload?.owner_key, transaction: tx }));
}

// ---- wallet daemon ----

function walletd() {
  const url = process.env.WALLETD_URL || "http://127.0.0.1:5102/json_rpc";
  const token = process.env.WALLETD_TOKEN ?? (process.env.WALLETD_TOKEN_FILE ? readFileSync(process.env.WALLETD_TOKEN_FILE, "utf8").trim() : undefined);
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

async function accountInfo(rpc, name) {
  const { accounts } = await rpc("accounts.list", { offset: 0, limit: 100 });
  const a = accounts.find((x) => x.account.name === name);
  if (!a) throw new Error(`no walletd account named "${name}"`);
  const index = a.account.owner_key_id?.Derived?.index;
  if (index === undefined) throw new Error(`account "${name}" has no derived key index`);
  return { component: a.account.component_address, key: a.account.owner_public_key, index };
}

/** Dry-runs, then (with live) submits with max_fee set to the dry run's fee. Returns the result. */
export async function submit(rpc, { manifestFor, variables, signerIndex, live, ceiling = 200_000 }) {
  const base = { variables, seal_signer_key_id: { Derived: { index: signerIndex, key_branch: "account" } } };
  const dry = await rpc("transactions.submit_manifest", { ...base, manifest: manifestFor(ceiling), max_fee: ceiling, dry_run: true });
  const fee = Number(dry.required_fees ?? dry.fee ?? ceiling);
  const maxFee = Math.min(ceiling, Math.ceil(fee * 1.05));
  if (!live) return { dry_run: true, required_fee: fee };
  const sent = await rpc("transactions.submit_manifest", { ...base, manifest: manifestFor(maxFee), max_fee: maxFee, dry_run: false });
  const result = await rpc("transactions.wait_result", { transaction_id: sent.transaction_id, timeout_secs: 240 });
  if (result.status !== "Accepted") throw new Error(`transaction ${sent.transaction_id}: ${result.status} ${JSON.stringify(result).slice(0, 600)}`);
  return { transaction_id: sent.transaction_id, fee: result.final_fee, result };
}

// ---- command line ----

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {}, args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
    else args.push(rest[i]);
  }
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
    if (await lookup(name).catch(() => null)) throw new Error(`"${name}" is already registered`);
    const nameFee = BigInt(flags["name-fee"] ?? 1_000_000);
    const r = await submit(rpc, {
      manifestFor: (max_fee) => registerManifest({ name, ownerKey: flags["owner-key"], messaging, description, sig, fee: { name_fee: nameFee, max_fee } }),
      variables: { agent: acct.component, directory },
      signerIndex: acct.index,
      live: flags.live === true,
      // The fee is reserved before the name fee is withdrawn, so keep the ceiling near a call's real cost.
      ceiling: Number(flags["max-fee"] ?? 50_000),
    });
    console.log(r.dry_run ? `Dry run accepted: transaction fee ${r.required_fee} µT plus the ${Number(nameFee) / 1e6} tTARI name fee. Add --live to register.`
      : `Registered "${name}" in ${r.transaction_id} (transaction fee ${r.fee} µT, name fee ${Number(nameFee) / 1e6} tTARI locked)`);
  } else if (cmd === "lookup") {
    const card = await lookup(args[0]);
    console.log(card ? JSON.stringify(card, null, 2) : `"${args[0]}" is not registered`);
  } else if (cmd === "list") {
    for (const a of await list()) console.log(`${a.name}\tagent ${a.agent_key?.slice(0, 12)}…\towner ${a.owner_key?.slice(0, 12)}…`);
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 19).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 1 : 0);
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
