import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./server.mjs";

const buf = (...data) => ({ type: "Buffer", data });
const output = (type, extra = []) => ({ features: { output_type: type, maturity: type === 1 ? 1000 : 0, coinbase_extra: buf(...extra) }, commitment: buf(1), hash: buf(2) });

// A fake explorer: block 7 spreads three outputs over two pages, like the real one does with 10 per page.
const pages = {
  "/blocks/7": { body: { outputs: [output(1, [..."p2pool\u0001"].map((c) => c.charCodeAt(0))), output(0)], outputsNextLink: "/blocks/7?outputs_from=2&outputs_to=4" } },
  "/blocks/7?outputs_from=2&outputs_to=4": { body: { outputs: [output(0)], outputsNextLink: null } },
};
globalThis.fetch = async (url) => {
  const u = new URL(url);
  u.searchParams.delete("json");
  const page = pages[u.pathname + u.search];
  return { ok: !!page, status: page ? 200 : 404, json: async () => page };
};

const call = async (name, args) => (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;

test("handshake and tool list", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["tari_tip", "tari_block", "tari_block_outputs"]);
});

test("outputs follow every page and decode coinbase extra data", async () => {
  const all = (await call("tari_block_outputs", { height: 7 })).structuredContent;
  assert.equal(all.complete, true);
  assert.equal(all.outputs.length, 3);
  assert.equal(all.outputs[0].coinbase_extra, "p2pool?");
  const mined = (await call("tari_block_outputs", { height: 7, coinbase_only: true })).structuredContent;
  assert.deepEqual(mined.outputs.map((o) => o.type), ["coinbase"]);
});

test("bad input is a tool error, not a crash", async () => {
  assert.equal((await call("tari_block", { height: -1 })).isError, true);
  assert.equal((await call("tari_tip", { network: "nextnet" })).isError, true);
  assert.equal((await call("tari_block", { height: 99 })).isError, true);
  assert.equal((await handle({ jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601);
});
