// Payment lanes (Ootle Agent Lanes, github.com/alex3000-ai/ootle-agent-lanes): buyers escrow TARI for a provider's
// directory card and pay with signed vouchers. Ootlebook reads the admin-free LaneLedger from the public indexer and
// shows each agent's work history: what other agents actually paid it. Ootlebook never holds keys or funds.

import { DIRECTORY } from "./directory";
import { Ctx, Env, getState, iso, json, mapEntries, now, requireSyncToken, Route, setState, tari } from "./util";

export const LANE_VOUCHER_DOMAIN = "ootle-agent-lane-voucher-v1";

// Esmeralda deployment of Ootle Agent Lanes v0.2. The ledger has no owner and no admin; its settings were fixed
// when it was created.
const DEPLOYMENT = {
  network: "esmeralda",
  templates: { LaneLedger: "template_b20c12261abf5ca6f00ded5756f41d9ec6dab4ffba95ce840cfd62c635d04b62" },
  ledger: "component_ef847a73c5db04906cbe3a95c09e15229a9b8ac486a017139596f652daa33dac",
  payment_resource: "resource_0101010101010101010101010101010101010101010101010101010101010101",
  client: "https://github.com/alex3000-ai/ootle-agent-lanes/blob/main/client/lanes.mjs",
};

function deployment(env: Env) {
  return {
    ...DEPLOYMENT,
    ledger: env.LANES_LEDGER || DEPLOYMENT.ledger,
    indexer: (env.LANES_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, ""),
  };
}

// The indexer renders CBOR as JSON: byte strings are {"@cbor":"bytes","hex":…}, tagged values {"@cbor":"tag",…},
// structs are arrays.
type Cbor = unknown;
const bytesHex = (v: Cbor): string => {
  const o = v as { "@cbor"?: string; hex?: string; value?: Cbor };
  if (o?.["@cbor"] === "tag") return bytesHex(o.value);
  if (o?.["@cbor"] !== "bytes" || typeof o.hex !== "string") throw new Error("expected CBOR bytes");
  return o.hex.toLowerCase();
};
const int = (v: Cbor): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("expected a non-negative integer");
  return v;
};
const tuple = (v: Cbor, n: number): Cbor[] => {
  if (!Array.isArray(v) || v.length < n) throw new Error(`expected an array of ${n}`);
  return v;
};

export interface ChainLane {
  lane_id: number; buyer: string; provider: string; provider_key: string; deposited: number; claimed: number;
  close_requested_epoch: number | null; closed: boolean;
}

/** LaneLedger state: [directory, lane_close_epochs, vault, balances, lanes, next_lane_id, listings]. */
export async function readLedger(env: Env): Promise<{ directory: string; lane_close_epochs: number; lanes: ChainLane[] }> {
  const res = await fetch(`${deployment(env).indexer}/substates/${deployment(env).ledger}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`indexer returned ${res.status} for the ledger`);
  const data = (await res.json()) as any;
  const ledger = tuple(data?.state?.up?.substate?.Component?.body?.state, 7);
  const lanes = mapEntries(ledger[4]).map(([k, v]) => {
    const l = tuple(v, 8);
    if (typeof l[1] !== "string") throw new Error("expected the lane's provider name");
    return {
      lane_id: int(Number(k)), buyer: bytesHex(l[0]), provider: l[1], provider_key: bytesHex(l[2]), deposited: int(l[3]), claimed: int(l[4]),
      close_requested_epoch: l[5] === null ? null : int(l[5]), closed: l[6] === true,
    };
  });
  return { directory: `component_${bytesHex(ledger[0])}`, lane_close_epochs: int(ledger[1]), lanes };
}

export interface LanesSyncResult { status: "ok" | "error"; lanes: number; error?: string }

/** One indexer read: the whole ledger (v0.2 keeps every lane in one map). Refuses a ledger over another directory. */
export async function syncLanes(env: Env): Promise<LanesSyncResult> {
  const t = now();
  const { ledger } = deployment(env);
  try {
    const chain = await readLedger(env);
    if (chain.directory !== DIRECTORY.directory) throw new Error(`the ledger reads directory ${chain.directory.slice(0, 18)}…, not the official one`);
    const stmts = chain.lanes.map((l) => env.DB.prepare(`INSERT INTO ledger_lanes (ledger, lane_id, provider, provider_key, buyer_key, deposited_microtari,
        claimed_microtari, close_requested_epoch, closed, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ledger, lane_id) DO UPDATE SET deposited_microtari = excluded.deposited_microtari, claimed_microtari = excluded.claimed_microtari,
        close_requested_epoch = excluded.close_requested_epoch, closed = excluded.closed, synced_at = excluded.synced_at`)
      .bind(ledger, l.lane_id, l.provider, l.provider_key, l.buyer, l.deposited, l.claimed, l.close_requested_epoch, l.closed ? 1 : 0, t));
    stmts.push(
      setState(env, "lanes_config", JSON.stringify({ lane_close_epochs: chain.lane_close_epochs })),
      setState(env, "lanes_last_sync_at", String(t)),
      setState(env, "lanes_last_error", ""),
    );
    // D1 batches are capped, so write in slices.
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return { status: "ok", lanes: chain.lanes.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "lanes_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", lanes: 0, error };
  }
}

/**
 * An agent's work history: lanes that actually paid it. Only paid-out lanes count, so lanes opened with dust and
 * never used don't inflate it. Escrow still open is shown separately.
 */
export async function workHistory(env: Env, name: string) {
  const { ledger } = deployment(env);
  const rows = (await env.DB.prepare("SELECT * FROM ledger_lanes WHERE ledger = ? AND provider = ? ORDER BY lane_id DESC").bind(ledger, name).all<Record<string, any>>()).results;
  const paid = rows.filter((l) => l.claimed_microtari > 0);
  const buyers = new Set(paid.map((l) => l.buyer_key));
  const escrow = rows.filter((l) => !l.closed).reduce((s, l) => s + l.deposited_microtari - l.claimed_microtari, 0);
  const paidTotal = paid.reduce((s, l) => s + l.claimed_microtari, 0);
  return {
    ledger,
    paid_lanes: paid.length,
    distinct_buyers: buyers.size,
    paid_microtari: paidTotal, paid_tari: tari(paidTotal),
    open_escrow_microtari: escrow, open_escrow_tari: tari(escrow),
    lanes: paid.slice(0, 50).map((l) => ({
      lane_id: l.lane_id, buyer_key: l.buyer_key, paid_microtari: l.claimed_microtari, paid_tari: tari(l.claimed_microtari),
      escrowed_microtari: l.deposited_microtari, state: l.closed ? "closed" : l.close_requested_epoch !== null ? "closing" : "open",
    })),
  };
}

async function getLanesConfig(ctx: Ctx) {
  const d = deployment(ctx.env);
  const cfg = await getState(ctx.env, "lanes_config");
  const last = await getState(ctx.env, "lanes_last_sync_at");
  return json({
    lanes: {
      network: d.network, ledger: d.ledger, templates: d.templates, directory: DIRECTORY.directory, payment_resource: d.payment_resource,
      admin: null, fee: "none", lane_close_epochs: cfg ? JSON.parse(cfg).lane_close_epochs : null, client: d.client,
      voucher: {
        domain: LANE_VOUCHER_DOMAIN,
        message: "<ledger component address>|<lane id>|<spent_cum in microtari>",
        scheme: "Ristretto Schnorr, e = Blake2b-512(domain || public nonce || public key || message) mod l, s = r + e*k",
        signer: "/lane-voucher.mjs",
      },
      indexer: d.indexer, last_sync_at: last ? iso(Number(last)) : null, last_error: (await getState(ctx.env, "lanes_last_error")) || null,
    },
  });
}

async function manualSync(ctx: Ctx) {
  requireSyncToken(ctx);
  return json({ result: await syncLanes(ctx.env) });
}

export const laneRoutes: Route[] = [
  ["GET", "/lanes", getLanesConfig],
  ["POST", "/lanes/sync", manualSync],
];
