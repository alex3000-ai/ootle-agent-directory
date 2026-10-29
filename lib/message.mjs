// Message format: signed, optionally compressed, split into chunks that each fit one Ootle stealth-output
// memo (253 bytes). Ootle encrypts each memo to the recipient's view key; this layer adds who sent it,
// proof that they did, and reassembly. Pure functions, no I/O.
//
// Chunk (one memo, <= 253 bytes):
//   "OM" | version (1) | message id (8) | index (1) | total (1) | data (<= 240)
// Data, concatenated over all chunks in index order:
//   flags (1, bit 0 = deflate) | sender network (1) | sender owner key (32) | sender view key (32)
//   | sent-at ms (8, LE) | signature nonce (32) | signature (32) | body (UTF-8, deflated if flagged)
// Signature: Tari Schnorr by the sender's owner key over
//   "ootle-agent-message-v1" | recipient network | recipient owner key | recipient view key
//   | message id | sent-at | flags | body as transmitted
// Binding the recipient stops a recipient from passing a message off as having been sent to someone else.

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { generateOotleAddress, parseOotleAddress, publicKeyFromSecretKey, schnorrSign } from "@tari-project/ootle-wasm";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const MEMO_MAX = 253;
const MAGIC = [0x4f, 0x4d]; // "OM"
const VERSION = 1;
const CHUNK_HEADER = 13;
const CHUNK_DATA = MEMO_MAX - CHUNK_HEADER; // 240
const META = 1 + 1 + 32 + 32 + 8 + 64; // 138
export const MAX_CHUNKS = 16;
export const MAX_BODY = MAX_CHUNKS * CHUNK_DATA - META; // 3,702 bytes after compression
const DOMAIN = new TextEncoder().encode("ootle-agent-message-v1");

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const readU64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true));
export const toHex = (b) => Buffer.from(b).toString("hex");
export const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

/** {network, owner, view} as raw bytes from an otl_… address. */
export function addressParts(address) {
  const p = parseOotleAddress(address);
  return { network: p.network, owner: Uint8Array.from(p.owner_key), view: Uint8Array.from(p.view_key) };
}
export const addressFromParts = ({ network, owner, view }) => generateOotleAddress(owner, view, network);

// Tari/Ootle Schnorr verification over raw bytes (matches @tari-project/ootle-wasm schnorrSign).
const ORDER = ristretto255.Point.Fn.ORDER;
const leInt = (b) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
export function verifySchnorr(pk, R, s, message) {
  try {
    const sNum = leInt(s);
    if (pk.length !== 32 || R.length !== 32 || s.length !== 32 || sNum >= ORDER) return false;
    const domain = new TextEncoder().encode("com.tari.schnorr_signature.v1.challenge");
    const h = blake2b.create({ dkLen: 64 });
    h.update(u64le(domain.length)).update(domain);
    for (const part of [R, pk, message]) h.update(u64le(part.length)).update(part);
    const e = leInt(h.digest()) % ORDER;
    const P = ristretto255.Point.fromBytes(pk), Rp = ristretto255.Point.fromBytes(R);
    const lhs = sNum === 0n ? ristretto255.Point.ZERO : ristretto255.Point.BASE.multiply(sNum);
    return lhs.equals(e === 0n ? Rp : Rp.add(P.multiply(e)));
  } catch {
    return false;
  }
}

const signedBytes = (to, id, sentAt, flags, body) => concat(DOMAIN, [to.network], to.owner, to.view, id, u64le(sentAt), [flags], body);

/**
 * Build the memo chunks for one message.
 * identity: {address, owner_secret_key (hex)}; to: recipient otl_… address.
 * Returns {id (hex), chunks: Uint8Array[]}.
 */
export function encodeMessage(identity, to, text, { sentAt = Date.now(), id = crypto.getRandomValues(new Uint8Array(8)) } = {}) {
  const me = addressParts(identity.address);
  const sk = fromHex(identity.owner_secret_key);
  if (toHex(publicKeyFromSecretKey(sk)) !== toHex(me.owner)) throw new Error("identity key file does not match its address");
  const recipient = addressParts(to);
  if (recipient.network !== me.network) throw new Error("recipient is on a different Ootle network");
  const raw = new TextEncoder().encode(text);
  const packed = deflateRawSync(raw);
  const [flags, body] = packed.length < raw.length ? [1, Uint8Array.from(packed)] : [0, raw];
  if (body.length > MAX_BODY) throw new Error(`message too long: ${body.length} bytes after compression, limit ${MAX_BODY}`);
  const sig = schnorrSign(sk, signedBytes(recipient, id, sentAt, flags, body));
  const data = concat([flags], [me.network], me.owner, me.view, u64le(sentAt), sig.public_nonce, sig.signature, body);
  const total = Math.ceil(data.length / CHUNK_DATA);
  const chunks = [];
  for (let i = 0; i < total; i++) {
    chunks.push(concat(MAGIC, [VERSION], id, [i], [total], data.subarray(i * CHUNK_DATA, (i + 1) * CHUNK_DATA)));
  }
  return { id: toHex(id), chunks };
}

/** Parse one memo. Returns {id, index, total, data} or null if it isn't a message chunk. */
export function parseChunk(memo) {
  if (!memo || memo.length < CHUNK_HEADER + 1 || memo[0] !== MAGIC[0] || memo[1] !== MAGIC[1] || memo[2] !== VERSION) return null;
  const index = memo[11], total = memo[12];
  if (total < 1 || total > MAX_CHUNKS || index >= total) return null;
  return { id: toHex(memo.subarray(3, 11)), index, total, data: memo.subarray(CHUNK_HEADER) };
}

/**
 * Reassemble and verify a complete message addressed to `myAddress`. `parts` maps index -> data bytes.
 * Throws if the signature is wrong or the message was signed for someone else.
 */
export function decodeMessage(myAddress, id, parts, total) {
  const pieces = [];
  for (let i = 0; i < total; i++) {
    if (!parts[i]) throw new Error(`chunk ${i} missing`);
    pieces.push(parts[i]);
  }
  const data = concat(...pieces);
  if (data.length < META) throw new Error("message too short");
  const flags = data[0];
  const sender = { network: data[1], owner: data.subarray(2, 34), view: data.subarray(34, 66) };
  const sentAt = readU64(data, 66);
  const R = data.subarray(74, 106), s = data.subarray(106, 138);
  const body = data.subarray(META);
  const me = addressParts(myAddress);
  if (!verifySchnorr(sender.owner, R, s, signedBytes(me, fromHex(id), sentAt, flags, body))) {
    throw new Error("bad signature: not from the address it claims, or not addressed to you");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(flags & 1 ? inflateRawSync(body, { maxOutputLength: 64 * 1024 }) : body);
  return { id, from: addressFromParts(sender), sent_at: new Date(sentAt).toISOString(), text };
}
