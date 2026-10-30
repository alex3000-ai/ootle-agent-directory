// Receiving: stream every new unspent stealth TARI output from the public Ootle indexer and try to decrypt each
// with our view key, exactly like an Ootle wallet finds incoming payments. Nothing about us is sent to the
// indexer: it serves the same outputs to everyone.

import { encryptedDataDhKdfAead, unblindOutput } from "@tari-project/ootle-wasm";
import { plainUtxo } from "../../client/encoded.mjs";
import { fromHex, toHex } from "./message.mjs";

export const DEFAULT_INDEXER = "https://ootle-indexer-a.tari.com";
export const TARI = "resource_" + "01".repeat(32);
const PAGE = 1000;
const SHARDS = 256; // Ootle's shards are 1 to 256; shard 0 holds global substates, never outputs

async function post(url, body, accept = "application/json") {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`indexer ${res.status} ${res.statusText} on ${new URL(url).pathname}`);
  return res;
}

/** Decrypt one indexer UTXO entry with our view secret. Returns memo bytes, or null if it isn't ours. */
export function openOutput(viewSecret, id, entry) {
  const out = entry?.output?.output ?? entry?.output; // {output: {output: {public_nonce, encrypted_data, …}, auth, tag}}
  if (!out?.public_nonce || !out?.encrypted_data) return null;
  let r;
  try {
    const key = encryptedDataDhKdfAead(viewSecret, fromHex(out.public_nonce));
    r = unblindOutput(fromHex(id), fromHex(out.encrypted_data), key, false);
  } catch {
    return null; // addressed to someone else
  }
  const memo = r.memo_json ? JSON.parse(r.memo_json) : null;
  const bytes = memo?.Bytes ?? memo?.PayRefAndBytes;
  if (bytes === undefined) return null;
  return Array.isArray(bytes) ? Uint8Array.from(bytes) : fromHex(bytes);
}

/**
 * Scan for outputs added since the saved per-shard state versions (`shards`, {shard: version}). The indexer streams each
 * new unspent output's tag and nonce shard by shard; we fetch those outputs and try each, since only our view key can
 * tell which are ours. Returns {memos: [{id, bytes}], shards, scanned}.
 */
export async function scan({ indexer = DEFAULT_INDEXER, viewSecretHex, shards = {} } = {}) {
  const root = indexer.replace(/\/+$/, "");
  const viewSecret = fromHex(viewSecretHex);
  const reached = { ...shards };
  const memos = [];
  let scanned = 0;
  let todo = Array.from({ length: SHARDS }, (_, i) => [i + 1, reached[i + 1] ?? 0]);
  while (todo.length) {
    const stream = await post(`${root}/utxos/stream`, { shard_state_versions: todo, resource_address: TARI, unspent_only: true, per_shard_limit: PAGE }, "application/x-ndjson");
    const pairs = [], more = [];
    let shard = 0, hasMore = false;
    for (const line of (await stream.text()).split("\n")) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.sos) ({ shard, has_more: hasMore } = frame.sos);
      const u = frame.update?.Unspent;
      if (u) pairs.push([u.tag, toHex(Uint8Array.from(u.public_nonce))]);
      if (frame.eos) {
        reached[shard] = frame.eos.max_state_version;
        if (hasMore) more.push([shard, reached[shard]]);
      }
    }
    for (let i = 0; i < pairs.length; i += PAGE) {
      let cursor = null;
      do {
        const page = await (await post(`${root}/utxos/fetch`, { tag_and_nonce_pairs: pairs.slice(i, i + PAGE), resource_address: TARI, ...(cursor ? { cursor } : {}) })).json();
        for (const [id, utxo] of page.utxos ?? []) {
          scanned++;
          const bytes = openOutput(viewSecret, id, plainUtxo(utxo));
          if (bytes) memos.push({ id, bytes });
        }
        cursor = page.next_cursor ?? null; // v0.48 pages; v0.47 answers in one
      } while (cursor);
    }
    todo = more;
  }
  return { memos, shards: reached, scanned };
}
