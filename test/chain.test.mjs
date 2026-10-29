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

/** An indexer stand-in over a list of unspent output ids, paged like GET /utxos?from_id=. */
function withIndexer(ids, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const from = new URL(url).searchParams.get("from_id");
    asked.push(from);
    const start = from === null ? 0 : ids.indexOf(from) + 1;
    const utxos = from !== null && !ids.includes(from) ? [] : ids.slice(start).map((id) => [id, {}]);
    return { ok: true, json: async () => ({ utxos }) };
  };
  return fn(asked).finally(() => { globalThis.fetch = real; });
}
const VIEW = "11".repeat(32);

test("scan: picks up after the newest cursor", () => withIndexer(["a", "b", "c", "d"], async (asked) => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW, cursors: ["b", "a"] });
  assert.equal(r.scanned, 2);
  assert.deepEqual(asked, ["b"]);
  assert.equal(r.cursors[0], "d");
}));

test("scan: no news is trusted only when an older cursor shows the newest still exists", () => withIndexer(["a", "b"], async (asked) => {
  const r = await scan({ indexer: "http://fake", viewSecretHex: VIEW, cursors: ["b", "a"] });
  assert.equal(r.scanned, 0);
  assert.deepEqual(asked, ["b", "a"]);
}));

test("scan: a spent cursor falls back to an older one, then to a full rescan", () => withIndexer(["a", "c"], async (asked) => {
  const fallback = await scan({ indexer: "http://fake", viewSecretHex: VIEW, cursors: ["b", "a"] });
  assert.equal(fallback.scanned, 1); // "c", read from cursor "a"
  asked.length = 0;
  const rescan = await scan({ indexer: "http://fake", viewSecretHex: VIEW, cursors: ["x"] });
  assert.equal(rescan.scanned, 2);
  assert.deepEqual(asked, ["x", null]);
}));
