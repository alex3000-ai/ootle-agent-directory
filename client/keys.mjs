// Keys and signatures for OotleAgents, made on your own machine: owner statements (cards) and lane vouchers.
// Ristretto Schnorr as the template verifies it: e = Blake2b-512(domain || R || P || message) mod l, s = r + e·k.

import { randomBytes } from "node:crypto";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const OWNER_DOMAIN = "ootle-agents-owner-v1";
export const VOUCHER_DOMAIN = "ootle-agents-voucher-v1";

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => {
  const clean = String(h).trim().replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(Buffer.from(clean, "hex"));
};
const leToBigInt = (b) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const le32 = (n) => {
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
function parseSecret(secretHex) {
  const bytes = fromHex(secretHex);
  const k = leToBigInt(bytes);
  if (bytes.length !== 32 || k === 0n || k >= ORDER) throw new Error("a secret key is a canonical non-zero 32-byte scalar");
  return k;
}
const bytesOf = (message) => (typeof message === "string" ? enc.encode(message) : message);

function challenge(domain, nonce, publicKey, message) {
  const h = blake2b.create({ dkLen: 64 });
  h.update(enc.encode(domain)).update(nonce).update(publicKey).update(bytesOf(message));
  return leToBigInt(h.digest()) % ORDER;
}

export function keygen() {
  const k = randomScalar();
  return { secretKey: hex(le32(k)), publicKey: hex(Point.BASE.multiply(k).toBytes()) };
}

export const publicKeyOf = (secretHex) => hex(Point.BASE.multiply(parseSecret(secretHex)).toBytes());

/** Signs `message` (text or bytes) under `domain`. Returns hex {public_key, public_nonce, signature}. */
export function sign(domain, secretHex, message) {
  const k = parseSecret(secretHex);
  const r = randomScalar();
  const P = Point.BASE.multiply(k).toBytes(), R = Point.BASE.multiply(r).toBytes();
  return { public_key: hex(P), public_nonce: hex(R), signature: hex(le32((r + challenge(domain, R, P, message) * k) % ORDER)) };
}

/** Checks a signature the way the template does. Garbage is false, never an exception. */
export function verify(domain, { public_key, public_nonce, signature }, message) {
  try {
    const P = Point.fromBytes(fromHex(public_key)), R = Point.fromBytes(fromHex(public_nonce));
    const s = leToBigInt(fromHex(signature));
    if (s >= ORDER) return false;
    const e = challenge(domain, fromHex(public_nonce), fromHex(public_key), message);
    const lhs = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    return lhs.equals(e === 0n ? R : R.add(P.multiply(e)));
  } catch {
    return false;
  }
}

/** Whether 32 bytes of hex are a valid public key (a voucher key that isn't can never sign a voucher). */
export function isPublicKey(h) {
  try { Point.fromBytes(fromHex(h)); return /^[0-9a-f]{64}$/i.test(h); } catch { return false; }
}

// The exact messages the template rebuilds (template/src/lib.rs, *_message).
const component = (c) => {
  if (!/^component_[0-9a-f]{64}$/.test(c ?? "")) throw new Error("expected a component_<64 hex> address");
  return c;
};
const key = (k, what) => {
  if (!/^[0-9a-f]{64}$/.test(k ?? "")) throw new Error(`${what} must be 32 bytes of lowercase hex`);
  return k;
};
export const statements = {
  register: (hub, name, agentKey, messaging = "") => `register|${component(hub)}|${name}|${key(agentKey, "agent key")}|${messaging}`,
  rotate: (hub, name, nonce, newAgentKey) => `rotate|${component(hub)}|${name}|${BigInt(nonce)}|${key(newAgentKey, "new agent key")}`,
  retire: (hub, name, nonce) => `retire|${component(hub)}|${name}|${BigInt(nonce)}`,
  transfer: (hub, name, nonce, newOwner) => `transfer|${component(hub)}|${name}|${BigInt(nonce)}|${key(newOwner, "new owner key")}`,
};

/** A voucher: the lane's voucher key authorises the provider to have claimed `spentCum` µT in all. */
export const voucherMessage = (hub, lane, spentCum) => `${component(hub)}|${lane}|${BigInt(spentCum)}`;

export function signVoucher(secretHex, hub, lane, spentCum) {
  return { hub, lane, spent_cum: String(BigInt(spentCum)), ...sign(VOUCHER_DOMAIN, secretHex, voucherMessage(hub, lane, spentCum)) };
}

export const verifyVoucher = (v) => {
  try { return verify(VOUCHER_DOMAIN, v, voucherMessage(v.hub, v.lane, v.spent_cum)); } catch { return false; }
};
