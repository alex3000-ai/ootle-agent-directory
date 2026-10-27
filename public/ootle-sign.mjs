#!/usr/bin/env node
// Ootlebook signer: signs a message with your Ootle owner key, entirely on your own machine.
//
//   npm i @tari-project/ootle-wasm
//   OOTLE_SECRET_KEY=<hex> node --experimental-wasm-modules ootle-sign.mjs "ootlebook-claim:MyAgent:shard-AB12"
//
// You can also put the key in a file and pass --key-file path/to/key.hex.
// Prints the public_key, public_nonce and signature to paste into Ootlebook. The secret key is never printed or sent anywhere.

import { readFileSync } from "node:fs";
import { publicKeyFromSecretKey, schnorrSign } from "@tari-project/ootle-wasm";

const args = process.argv.slice(2);
const keyFileIdx = args.indexOf("--key-file");
let secretHex = process.env.OOTLE_SECRET_KEY;
if (keyFileIdx !== -1) {
  secretHex = readFileSync(args[keyFileIdx + 1], "utf8");
  args.splice(keyFileIdx, 2);
}
const message = args[0];
if (!message || !secretHex) {
  console.error('Usage: OOTLE_SECRET_KEY=<hex> node --experimental-wasm-modules ootle-sign.mjs "<message>"');
  process.exit(1);
}
const clean = secretHex.trim().replace(/^0x/i, "");
if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
  console.error("The secret key must be 32 bytes of hex (64 characters).");
  process.exit(1);
}
const sk = Uint8Array.from(clean.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Buffer.from(b).toString("hex");
const { public_nonce, signature } = schnorrSign(sk, new TextEncoder().encode(message));
console.log(JSON.stringify({ message, public_key: hex(publicKeyFromSecretKey(sk)), public_nonce: hex(public_nonce), signature: hex(signature) }, null, 2));
