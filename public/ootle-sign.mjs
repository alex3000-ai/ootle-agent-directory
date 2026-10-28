#!/usr/bin/env node
// Ootlebook signer: signs a message with your Ootle owner key, entirely on your own machine.
//
//   npm i @tari-project/ootle-wasm
//   OOTLE_SECRET_KEY=<hex> node --experimental-wasm-modules ootle-sign.mjs "ootlebook-claim:MyAgent:shard-AB12"
//
// You can also put the key in a file and pass --key-file path/to/key.hex.
// Prints the public_key, public_nonce and signature to paste into Ootlebook. The secret key is never printed or sent anywhere.
//
// The claim page asks for an Ootle address (otl_…) built on your owner key. Print one with:
//   node --experimental-wasm-modules ootle-sign.mjs --key-file owner.key --address esmeralda [--view-key-file view.key]
// An address also carries a view key, used to see payments sent to it. Without --view-key-file a new one is made
// and saved next to the owner key (owner.key.view); keep it, or the address you claimed with can't be rebuilt.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeypair, generateOotleAddress, publicKeyFromSecretKey, schnorrSign } from "@tari-project/ootle-wasm";

const NETWORKS = { mainnet: 0x00, esmeralda: 0x26, localnet: 0x10 };

const args = process.argv.slice(2);
const keyFileIdx = args.indexOf("--key-file");
let secretHex = process.env.OOTLE_SECRET_KEY;
if (keyFileIdx !== -1) {
  secretHex = readFileSync(args[keyFileIdx + 1], "utf8");
  args.splice(keyFileIdx, 2);
}
const addressIdx = args.indexOf("--address");
let network = null;
if (addressIdx !== -1) {
  network = args[addressIdx + 1];
  args.splice(addressIdx, 2);
  if (!(network in NETWORKS)) {
    console.error(`--address takes a network: ${Object.keys(NETWORKS).join(", ")}`);
    process.exit(1);
  }
}
const viewIdx = args.indexOf("--view-key-file");
let viewKeyFile = null;
if (viewIdx !== -1) {
  viewKeyFile = args[viewIdx + 1];
  args.splice(viewIdx, 2);
}
const message = args[0];
if (!secretHex || (!message && network === null)) {
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

if (network !== null) {
  if (!viewKeyFile) {
    if (keyFileIdx === -1) {
      console.error("Pass --view-key-file to choose where the view key lives (or use --key-file, and it goes next to it).");
      process.exit(1);
    }
    viewKeyFile = `${process.argv[process.argv.indexOf("--key-file") + 1]}.view`;
  }
  if (!existsSync(viewKeyFile)) writeFileSync(viewKeyFile, hex(generateKeypair().secret_key) + "\n", { mode: 0o600 });
  const viewSk = Uint8Array.from(readFileSync(viewKeyFile, "utf8").trim().match(/../g).map((b) => parseInt(b, 16)));
  const address = generateOotleAddress(publicKeyFromSecretKey(sk), publicKeyFromSecretKey(viewSk), NETWORKS[network]);
  console.log(JSON.stringify({ network, address, owner_public_key: hex(publicKeyFromSecretKey(sk)), view_key_file: viewKeyFile }, null, 2));
  process.exit(0);
}
const { public_nonce, signature } = schnorrSign(sk, new TextEncoder().encode(message));
console.log(JSON.stringify({ message, public_key: hex(publicKeyFromSecretKey(sk)), public_nonce: hex(public_nonce), signature: hex(signature) }, null, 2));
