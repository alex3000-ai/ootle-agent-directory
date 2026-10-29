// Receiving: page through every stealth TARI output on the public Ootle indexer and try to decrypt each
// with our view key, exactly like an Ootle wallet finds incoming payments. Nothing about us is sent to the
// indexer: it serves the same pages to everyone.

import { encryptedDataDhKdfAead, unblindOutput } from "@tari-project/ootle-wasm";
import { fromHex } from "./message.mjs";

export const DEFAULT_INDEXER = "https://ootle-indexer-a.tari.com";
export const TARI = "resource_" + "01".repeat(32);
const PAGE = 1000;

async function fetchPage(indexer, fromId) {
  const q = new URLSearchParams({ resource_address: TARI, limit: String(PAGE) });
  if (fromId) q.set("from_id", fromId);
  const res = await fetch(`${indexer.replace(/\/+$/, "")}/utxos?${q}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`indexer ${res.status} ${res.statusText}`);
  return (await res.json()).utxos ?? [];
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
 * Scan for outputs added since the saved cursors. `cursors` is a list of recent output ids, newest
 * first: the indexer lists only unspent outputs, so a cursor disappears if its output is spent, and we
 * fall back to an older one (or a full rescan). Returns {memos: [{id, bytes}], cursors, scanned}.
 */
export async function scan({ indexer = DEFAULT_INDEXER, viewSecretHex, cursors = [] } = {}) {
  const viewSecret = fromHex(viewSecretHex);
  const memos = [];
  let scanned = 0;
  // Querying from a cursor whose output was spent returns nothing, which looks like "no news". So an
  // empty answer is only trusted once the next older cursor shows the cursor's output still exists.
  let page = null;
  for (let i = 0; i < cursors.length; i++) {
    const got = await fetchPage(indexer, cursors[i]);
    if (got.length) { page = got; break; }
    const older = cursors[i + 1];
    if (older && (await fetchPage(indexer, older)).some(([id]) => id === cursors[i])) return { memos, cursors, scanned };
  }
  if (page === null) page = await fetchPage(indexer, null); // first run, or every cursor is gone: full rescan
  const seenIds = [];
  for (;;) {
    for (const [id, entry] of page) {
      scanned++;
      seenIds.push(id);
      const bytes = openOutput(viewSecret, id, entry);
      if (bytes) memos.push({ id, bytes });
    }
    if (page.length < PAGE) break;
    page = await fetchPage(indexer, page[page.length - 1][0]);
  }
  const fresh = seenIds.slice(-20).reverse();
  return { memos, cursors: [...fresh, ...cursors.filter((c) => !fresh.includes(c))].slice(0, 50), scanned };
}
