#!/usr/bin/env node
// tari-explorer-mcp: an MCP server (stdio) for the Tari base layer, Minotari, read from Tari's public text explorer.
// Inspired by kstrycharz/tariblocktools. It speaks MCP's JSON-RPC directly, so it needs nothing beyond Node.

import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const EXPLORERS = { mainnet: "https://textexplore.tari.com", esmeralda: "https://textexplore-esmeralda.tari.com" };
const OUTPUT_TYPES = ["standard", "coinbase", "burn", "validator node registration", "code template registration"];
// The explorer serves a block's outputs 10 to a page; past this many pages the answer says it's incomplete.
const MAX_PAGES = 30;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const hex = (buf) => Buffer.from(buf?.data ?? []).toString("hex");
const printable = (buf) => String.fromCharCode(...(buf?.data ?? []).map((b) => (b >= 32 && b <= 126 ? b : 63)));
const iso = (seconds) => new Date(seconds * 1000).toISOString();

async function get(network, path) {
  const base = EXPLORERS[network];
  if (!base) throw new Error(`network must be one of: ${Object.keys(EXPLORERS).join(", ")}`);
  const url = new URL(path, base);
  url.searchParams.set("json", "");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}`);
  return res.json();
}

function blockHeight(h) {
  if (!Number.isSafeInteger(h) || h < 0) throw new Error("height must be a whole number, 0 or more");
  return h;
}

const network = { type: "string", enum: Object.keys(EXPLORERS), default: "mainnet", description: "mainnet, or the esmeralda testnet" };
const height = { type: "integer", minimum: 0, description: "Block height" };

const TOOLS = {
  tari_tip: {
    description: "The tip of the Tari base layer (Minotari): the latest block's height, hash and time, and how many transactions wait in the mempool.",
    properties: { network },
    async run({ network }) {
      const d = await get(network, "/");
      const m = d.tipInfo.metadata;
      return { network, height: m.best_block_height, hash: hex(m.best_block_hash), time: iso(m.timestamp), mempool_transactions: d.mempool.length };
    },
  },
  tari_block: {
    description: "One Tari base-layer block: hash, previous hash, time, proof-of-work algorithm, total coinbase in XTM, and how many outputs, inputs and kernels it holds.",
    properties: { network, height },
    required: ["height"],
    async run({ network, height }) {
      const d = await get(network, `/blocks/${blockHeight(height)}`);
      const { header: h, body: b } = d;
      return {
        network, height: d.height, hash: hex(h.hash), prev_hash: hex(h.prev_hash), time: iso(h.timestamp),
        pow: d.pows?.[h.pow.pow_algo] ?? h.pow.pow_algo, coinbase_total_xtm: d.totalCoinbaseXtm, coinbases: d.numCoinbases,
        outputs: b.outputs_length, inputs: b.inputs_length, kernels: b.kernels_length,
      };
    },
  },
  tari_block_outputs: {
    description: "The outputs of one Tari base-layer block: type, commitment, hash and maturity, and for coinbases the miner's coinbase extra data as text (often the mining software or pool). Set coinbase_only to see just who mined it.",
    properties: { network, height, coinbase_only: { type: "boolean", default: false, description: "Only the coinbase outputs" } },
    required: ["height"],
    async run({ network, height, coinbase_only = false }) {
      const outputs = [];
      let path = `/blocks/${blockHeight(height)}`;
      for (let page = 0; path && page < MAX_PAGES; page++) {
        const d = await get(network, path);
        outputs.push(...d.body.outputs);
        path = d.body.outputsNextLink;
      }
      return {
        network, height, complete: !path,
        outputs: outputs.filter((o) => !coinbase_only || o.features.output_type === 1).map((o) => ({
          type: OUTPUT_TYPES[o.features.output_type] ?? o.features.output_type,
          commitment: hex(o.commitment), hash: hex(o.hash), maturity: o.features.maturity,
          ...(o.features.output_type === 1 && { coinbase_extra: printable(o.features.coinbase_extra) }),
        })),
      };
    },
  },
};

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answers one MCP message; notifications (no id) get no answer. */
export async function handle({ id, method, params }) {
  if (id === undefined) return null;
  if (method === "initialize") {
    const protocolVersion = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
    return reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tari-explorer", version: VERSION } });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, description: t.description,
        inputSchema: { type: "object", properties: t.properties, required: t.required ?? [], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: true },
      })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.run({ network: "mainnet", ...params.arguments });
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: e.message }], isError: true });
    }
  }
  return fail(id, -32601, `unknown method: ${method}`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return process.stdout.write(`${JSON.stringify(fail(null, -32700, "invalid JSON"))}\n`); }
    const answer = await handle(msg);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
}
