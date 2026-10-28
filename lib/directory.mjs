// Agent names -> messaging addresses, read from the Ootle Agent Directory
// (github.com/alex3000-ai/ootle-agent-directory) on the public indexer. No website is involved.

import { DEFAULT_INDEXER } from "./scan.mjs";

// Esmeralda deployment (ootle-agent-directory/deployments/esmeralda.json). Override with
// OOTLE_DIRECTORY and OOTLE_DIRECTORY_CARDS for another network.
export const ESMERALDA = {
  directory: "component_281ea63b22baea4522dbea6107ceda1f0ec09ae6ae2114c4def1c448d94e8f61",
  cards: "resource_28dec551986103afdd74fb31d22ef13e301ee80c28d6eb56bfec2445272ae278",
};

const cborHex = (v) => (v?.["@cbor"] === "bytes" ? v.hex : v?.["@cbor"] === "tag" ? cborHex(v.value) : null);

async function get(indexer, path) {
  const res = await fetch(`${indexer.replace(/\/+$/, "")}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status} on ${path}`);
  return res.json();
}

/**
 * Looks up an agent card. Checks that the cards resource really belongs to the directory component,
 * so a wrong configuration can't hand you someone else's address. Returns null if the name is free.
 */
export async function lookupAgent(name, {
  indexer = process.env.OOTLE_INDEXER || DEFAULT_INDEXER,
  directory = process.env.OOTLE_DIRECTORY || ESMERALDA.directory,
  cards = process.env.OOTLE_DIRECTORY_CARDS || ESMERALDA.cards,
} = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) throw new Error("agent names are 2-32 characters of a-z, 0-9, _ and -");
  const comp = await get(indexer, `/substates/${directory}`);
  const state = comp?.state?.up?.substate?.Component?.body?.state;
  if (!state || `resource_${cborHex(state[0])}` !== cards) throw new Error("the configured directory and cards resource don't match on-chain");
  const got = await get(indexer, `/substates/nft_${cards.replace("resource_", "")}_str_${name}`);
  const nft = got?.state?.up?.substate?.NonFungible;
  if (!nft) return null;
  const [agentKey, ownerKey, messaging, , , status] = nft.mutable_data;
  return { name, agent_key: cborHex(agentKey), owner_key: cborHex(ownerKey), messaging_address: messaging, retired: status === 1 };
}
