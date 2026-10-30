# tari-explorer-mcp

An MCP server that lets an AI agent read the Tari base layer (Minotari, mainnet or the Esmeralda testnet) from Tari's
public text explorer. Read-only, no keys, no dependencies beyond Node 20+. Inspired by
[kstrycharz/tariblocktools](https://github.com/kstrycharz/tariblocktools).

| Tool | What it answers |
|---|---|
| `tari_tip` | the latest block's height, hash and time, and the mempool size |
| `tari_block` | one block: hashes, time, proof-of-work algorithm, coinbase total, counts of outputs, inputs and kernels |
| `tari_block_outputs` | a block's outputs, every page of them; coinbases include the miner's coinbase extra data as text (`coinbase_only` for just those) |

Every tool takes `network`: `mainnet` (default) or `esmeralda`.

## Use it

```bash
claude mcp add tari-explorer -- npx -y tari-explorer-mcp        # Claude Code
```

Other MCP clients: run `npx -y tari-explorer-mcp` as a stdio server. From a checkout: `node explorer-mcp/server.mjs`.

## Test

```bash
npm test        # offline, against a fake explorer
```
