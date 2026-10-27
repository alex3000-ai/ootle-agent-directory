// Ootle (Tari L2) wallet primitives: address parsing and Schnorr signature verification.
//
// Signatures follow tari_crypto's RistrettoSchnorr, which is what @tari-project/ootle-wasm's
// `schnorrSign` produces:
//   e = Blake2b-512( DomainSeparatedHasher("com.tari.schnorr_signature", v1, "challenge") <- R, P, m ) mod l
//   valid iff  s·G == R + e·P
// Each hashed item is prefixed with its length as a little-endian u64.

import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32m } from "@scure/base";

const Point = ristretto255.Point;
const ORDER = ristretto255.Point.Fn.ORDER;
const enc = new TextEncoder();

export const NETWORKS: Record<string, string> = {
  otl_: "mainnet",
  otl_esm_: "esmeralda",
  otl_loc_: "localnet",
};

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function leToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function challenge(nonce: Uint8Array, pubkey: Uint8Array, message: Uint8Array): bigint {
  const domain = enc.encode("com.tari.schnorr_signature.v1.challenge");
  const h = blake2b.create({ dkLen: 64 });
  h.update(u64le(domain.length)).update(domain);
  for (const part of [nonce, pubkey, message]) h.update(u64le(part.length)).update(part);
  return leToBigInt(h.digest()) % ORDER;
}

/** Verify a Tari/Ootle Schnorr signature. All byte inputs are 32-byte hex strings. */
export function verifySchnorr(pubkeyHex: string, nonceHex: string, sigHex: string, message: string): boolean {
  try {
    const pk = hexToBytes(pubkeyHex);
    const R = hexToBytes(nonceHex);
    const s = hexToBytes(sigHex);
    if (pk.length !== 32 || R.length !== 32 || s.length !== 32) return false;
    const sNum = leToBigInt(s);
    if (sNum >= ORDER) return false;
    const P = Point.fromBytes(pk);
    const Rp = Point.fromBytes(R);
    const e = challenge(R, pk, enc.encode(message));
    const lhs = sNum === 0n ? Point.ZERO : Point.BASE.multiply(sNum);
    const rhs = e === 0n ? Rp : Rp.add(P.multiply(e));
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

export interface ParsedAddress {
  network: string;
  ownerPubkey: string;
  viewPubkey: string;
}

/** Parse an Ootle bech32m address (owner key || view key [|| memo]). */
export function parseOotleAddress(address: string): ParsedAddress {
  const decoded = bech32m.decode(address.trim() as `${string}1${string}`, 1000);
  const prefix = decoded.prefix;
  const network = NETWORKS[prefix];
  if (!network) throw new Error(`unknown Ootle address prefix "${prefix}"`);
  const bytes = bech32m.fromWords(decoded.words);
  if (bytes.length < 64) throw new Error("address payload too short");
  const owner = bytes.slice(0, 32);
  Point.fromBytes(owner); // throws if not a valid Ristretto point
  return { network, ownerPubkey: bytesToHex(owner), viewPubkey: bytesToHex(bytes.slice(32, 64)) };
}

export function claimMessage(agentName: string, verificationCode: string): string {
  return `ootlebook-claim:${agentName}:${verificationCode}`;
}

export function loginMessage(nonce: string): string {
  return `ootlebook-login:${nonce}`;
}
