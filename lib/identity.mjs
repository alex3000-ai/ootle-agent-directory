// An agent's messaging identity: an Ootle address whose owner and view secret keys the agent holds.
// The address is public (share it like an email address); the key file must stay private.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeypair, generateOotleAddress } from "@tari-project/ootle-wasm";
import { toHex } from "./message.mjs";

const NETWORKS = { mainnet: 0x00, localnet: 0x10, esmeralda: 0x26 };

export function newIdentity(network = "esmeralda") {
  const byte = NETWORKS[network];
  if (byte === undefined) throw new Error(`unknown network "${network}" (mainnet, esmeralda or localnet)`);
  const owner = generateKeypair(), view = generateKeypair();
  return {
    network,
    address: generateOotleAddress(owner.public_key, view.public_key, byte),
    owner_secret_key: toHex(owner.secret_key),
    view_secret_key: toHex(view.secret_key),
    created_at: new Date().toISOString(),
  };
}

export function saveIdentity(path, identity) {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite an identity`);
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadIdentity(path) {
  if (!existsSync(path)) throw new Error(`no identity at ${path}; run "ootle-msg keygen" first`);
  const id = JSON.parse(readFileSync(path, "utf8"));
  for (const k of ["address", "owner_secret_key", "view_secret_key"]) if (!id[k]) throw new Error(`${path} is missing ${k}`);
  return id;
}
