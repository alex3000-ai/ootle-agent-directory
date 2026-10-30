// Sending and scanning against a fake wallet daemon and a fake indexer: the parts that spend money or could miss mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../lib/scan.mjs";
import { sendChunks } from "../lib/send.mjs";

/** A walletd stand-in: every dry run estimates `fee` and returns `outcome`; records each call. */
function fakeWalletd({ fee = 1000, outcome = { Accept: {} } } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "accounts.stealth_transfer") return { transaction_id: `${params.dry_run ? "dry" : "tx"}${calls.length}` };
    const dry = params.transaction_id.startsWith("dry");
    return dry ? { final_fee: fee, result: outcome } : { status: "Accepted", final_fee: fee };
  };
  return { rpc, calls, sent: () => calls.filter((c) => c.method === "accounts.stealth_transfer" && !c.params.dry_run) };
}
const chunks = (n) => Array.from({ length: n }, (_, i) => new Uint8Array([i]));

test("send: two chunks per transaction, max_fee 10% over the dry run", async () => {
  const w = fakeWalletd({ fee: 1000 });
  const txs = await sendChunks(w.rpc, { to: "otl_esm_x", chunks: chunks(3) });
  assert.deepEqual(txs.map((t) => t.chunks), [2, 1]);
  assert.deepEqual(w.sent().map((c) => c.params.max_fee), [1100, 1100]);
  assert.ok(w.sent().every((c) => c.params.input_selection === "ConfidentialOnly"));
});

test("send: a dry run that would be rejected sends nothing", async () => {
  for (const outcome of [{ Reject: { ExecutionFailure: { message: "no funds" } } }, { AcceptFeeRejectRest: [1, {}] }]) {
    const w = fakeWalletd({ outcome });
    await assert.rejects(sendChunks(w.rpc, { to: "otl_esm_x", chunks: chunks(1) }), /dry run rejected/);
    assert.equal(w.sent().length, 0);
  }
});

test("send: a fee above the ceiling sends nothing", async () => {
  const w = fakeWalletd({ fee: 95_000 });
  await assert.rejects(sendChunks(w.rpc, { to: "otl_esm_x", chunks: chunks(1) }), /above the ceiling/);
  assert.equal(w.sent().length, 0);
});

/**
 * An indexer stand-in over unspent outputs ({shard, version, id}): POST /utxos/stream sends each shard's outputs above
 * the asked version, at most `perPass` a pass (more is then flagged), as v0.47+ indexers do; POST /utxos/fetch answers
 * by tag and nonce, `pageSize` at a time with next_cursor, as v0.48 does, and as base64 CBOR when `encoded`.
 */
function withIndexer(outputs, { perPass = 1000, pageSize = 1000, encoded = false } = {}, fn) {
  const real = globalThis.fetch;
  const asked = { stream: [], fetch: 0 };
  const nonce = (id) => Array.from({ length: 32 }, () => id.charCodeAt(0));
  globalThis.fetch = async (url, { body }) => {
    const req = JSON.parse(body);
    if (url.endsWith("/utxos/stream")) {
      asked.stream.push(req.shard_state_versions);
      const lines = req.shard_state_versions.flatMap(([shard, from]) => {
        const all = outputs.filter((o) => o.shard === shard && o.version > from);
        const pass = all.slice(0, perPass);
        if (!pass.length) return [];
        const reached = pass.at(-1).version;
        return pass.map((o, i) => ({
          ...(i === 0 ? { sos: { shard, max_state_version: reached, num_updates: pass.length, has_more: all.length > pass.length } } : {}),
          update: { Unspent: { tag: 7, public_nonce: nonce(o.id) } },
          ...(i === pass.length - 1 ? { eos: { max_state_version: reached } } : {}),
        }));
      });
      return { ok: true, text: async () => lines.map((l) => JSON.stringify(l) + "\n").join("") };
    }
    asked.fetch++;
    const wanted = new Set(req.tag_and_nonce_pairs.map(([, n]) => n));
    const hits = outputs.filter((o) => wanted.has(Buffer.from(nonce(o.id)).toString("hex")));
    const from = req.cursor ? hits.findIndex((o) => o.id === req.cursor) + 1 : 0;
    const page = hits.slice(from, from + pageSize);
    const value = encoded ? UTXO_V048 : {};
    return { ok: true, json: async () => ({ utxos: page.map((o) => [o.id, value]), ...(from + pageSize < hits.length ? { next_cursor: page.at(-1).id } : {}) }) };
  };
  return fn(asked).finally(() => { globalThis.fetch = real; });
}
const VIEW = "11".repeat(32);
// A live Esmeralda TARI output as a v0.48 indexer serves it (encoded by Tari's Rust crates); it isn't ours.
const UTXO_V048 = "goODWCBSKlz65ktES6yLxrs+jJIFIi6TyN5W3y03h0c2QkZtF1hQ8CeiOWCvAt8iTpOixTp+ypw4jxnc6ZSXlfTiDFb+ZOy9RubeEz+5UA7CXVurgE9moX60RH38AddAjTxtXC+QBMn4KKNj/blW7GFKNG5iomMAggCBWCC0RppJE70kT64OIKYAv2huVHBYcyieR3C6NZie+jfsQhqsLxjO9A==";
const out = (shard, version, id) => ({ shard, version, id });

test("scan: the first run reads every shard and remembers how far each got", () => withIndexer([out(1, 5, "a"), out(1, 9, "b"), out(200, 3, "c")], {}, async (asked) => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW });
  assert.equal(r.scanned, 3);
  assert.deepEqual(r.shards, { 1: 9, 200: 3 });
  assert.equal(asked.stream[0].length, 256);
  assert.deepEqual(asked.stream[0][0], [1, 0]);
}));

test("scan: picks up after the saved state versions", () => withIndexer([out(1, 5, "a"), out(1, 9, "b"), out(2, 4, "c")], {}, async () => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW, shards: { 1: 5, 2: 4 } });
  assert.equal(r.scanned, 1); // only "b"
  assert.deepEqual(r.shards, { 1: 9, 2: 4 });
}));

test("scan: a shard with more is asked again from where its pass ended", () => withIndexer([out(3, 1, "a"), out(3, 2, "b"), out(3, 3, "c")], { perPass: 2 }, async (asked) => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW });
  assert.equal(r.scanned, 3);
  assert.deepEqual(asked.stream[1], [[3, 2]]);
  assert.deepEqual(r.shards, { 3: 3 });
}));

test("scan: follows v0.48's fetch pages and reads its encoded outputs", () => withIndexer([out(1, 1, "a"), out(1, 2, "b"), out(1, 3, "c")], { pageSize: 2, encoded: true }, async (asked) => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW });
  assert.equal(r.scanned, 3);
  assert.equal(asked.fetch, 2);
  assert.equal(r.memos.length, 0);
}));
