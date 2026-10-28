// Payment lanes (Ootle Agent Lanes, github.com/alex3000-ai/ootle-agent-lanes): buyers escrow TARI for a provider's
// directory card and pay with signed vouchers. Ootlebook reads the admin-free LaneLedger from the public indexer and
// shows each agent's work history: what other agents actually paid it. Ootlebook never holds keys or funds.

import { DIRECTORY } from "./directory";
import { cborHex, Ctx, Env, getState, iso, json, mapEntries, now, requireSyncToken, Route, setState, tari } from "./util";

export const LANE_VOUCHER_DOMAIN = "ootle-agent-lane-voucher-v1";

// Esmeralda deployments. Neither ledger has an owner or admin; their settings were fixed when they were created.
// v0.3 is current: one substate per lane. v0.2 kept every lane in one map and is frozen; its lanes still count as
// work history.
const DEPLOYMENT = {
  network: "esmeralda",
  template: "template_2d14a6b304baf4660ec6530cee0fee98fdd6dbd8833a7fb14d589450db0882aa",
  ledger: "component_ade394f14d3429a65c1d15537d85b2babaf993cb8da2975a6cc481652f2a191b",
  v0_2: { template: "template_b20c12261abf5ca6f00ded5756f41d9ec6dab4ffba95ce840cfd62c635d04b62", ledger: "component_ef847a73c5db04906cbe3a95c09e15229a9b8ac486a017139596f652daa33dac" },
  payment_resource: "resource_0101010101010101010101010101010101010101010101010101010101010101",
  client: "https://github.com/alex3000-ai/ootle-agent-lanes/blob/main/client/lanes.mjs",
};
const ROTATE = 3;          // lanes re-read each sync whatever the events say (indexers may prune events)
// The lanes sync has its own cron invocation; Workers (free plan) allow 50 subrequests per invocation.
const FETCH_BUDGET = 45;
const TOPICS = ["lane_funded", "lane_claimed", "close_requested", "lane_released", "lane_refunded"].map((t) => `LaneLedger.lanes.${t}`);

const ledger = (env: Env) => env.LANES_LEDGER || DEPLOYMENT.ledger;
const indexerBase = (env: Env) => (env.LANES_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, "");

let fetchesLeft = FETCH_BUDGET;
async function get(env: Env, path: string): Promise<any | null> {
  if (fetchesLeft-- <= 0) throw new Error("indexer read budget for this sync is spent");
  const res = await fetch(`${indexerBase(env)}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer returned ${res.status} for ${path.slice(0, 40)}`);
  return res.json();
}

interface Lane {
  lane_id: number; buyer: string; provider: string; provider_key: string; deposited: number; claimed: number; refunded: number;
  close_requested_epoch: number | null; closed: boolean;
}
const hex = (v: unknown) => {
  const h = cborHex(v);
  if (!h) throw new Error("expected CBOR bytes");
  return h.toLowerCase();
};
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("expected a non-negative integer");
  return n;
};
const upsert = (env: Env, at: string, l: Lane, t: number) => env.DB.prepare(`INSERT INTO ledger_lanes (ledger, lane_id, provider, provider_key, buyer_key,
    deposited_microtari, claimed_microtari, refunded_microtari, close_requested_epoch, closed, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ledger, lane_id) DO UPDATE SET deposited_microtari = excluded.deposited_microtari, claimed_microtari = excluded.claimed_microtari,
    refunded_microtari = excluded.refunded_microtari, close_requested_epoch = excluded.close_requested_epoch, closed = excluded.closed, synced_at = excluded.synced_at`)
  .bind(at, l.lane_id, l.provider, l.provider_key, l.buyer, l.deposited, l.claimed, l.refunded, l.close_requested_epoch, l.closed ? 1 : 0, t);

/** v0.2 (frozen): one read of the whole ledger, [directory, lane_close_epochs, vault, balances, lanes, next_lane_id, listings]. */
async function syncV02(env: Env, t: number): Promise<D1PreparedStatement[]> {
  const state = (await get(env, `/substates/${DEPLOYMENT.v0_2.ledger}`))?.state?.up?.substate?.Component?.body?.state;
  if (!Array.isArray(state) || state.length !== 7) throw new Error("the v0.2 ledger has an unexpected shape");
  return mapEntries(state[4]).map(([k, l]: [unknown, any]) => upsert(env, DEPLOYMENT.v0_2.ledger, {
    lane_id: num(k), buyer: hex(l[0]), provider: String(l[1]), provider_key: hex(l[2]), deposited: num(l[3]), claimed: num(l[4]), refunded: 0,
    close_requested_epoch: l[5] === null ? null : num(l[5]), closed: l[6] === true,
  }, t));
}

export interface LanesSyncResult { status: "ok" | "error"; lanes: number; read: number; pending?: boolean; error?: string }

/** v0.3: new lanes by the ledger's count, lanes with new events, and a few in rotation; then the frozen v0.2 ledger. */
export async function syncLanes(env: Env): Promise<LanesSyncResult> {
  const t = now();
  fetchesLeft = FETCH_BUDGET;
  const at = ledger(env);
  try {
    const comp = (await get(env, `/substates/${at}`))?.state?.up?.substate?.Component;
    const state = comp?.body?.state;
    // Only the official ledger: the LaneLedger v0.3 template, over the official directory.
    if (!comp || !Array.isArray(state) || state.length !== 6 || (!env.LANES_LEDGER && `template_${comp.header?.template_address}` !== DEPLOYMENT.template)) throw new Error("not the LaneLedger v0.3 component");
    const [dir, closeEpochs, , lanesRes, , count] = state;
    if (`component_${hex(dir)}` !== DIRECTORY.directory) throw new Error("the ledger reads another directory");
    const lanesHex = hex(lanesRes);

    const events = await Promise.all(TOPICS.map(async (topic) => ((await get(env, `/transactions/events?topic=${topic}&substate_id=${at}&limit=1000`))?.events ?? []) as Array<[string, { substate_id?: string; payload?: Record<string, string> }]>));
    const counts: Record<string, number> = {};
    for (const list of events) for (const [, e] of list) if (e?.substate_id === at && /^\d+$/.test(e.payload?.lane_id ?? "")) counts[e.payload!.lane_id] = (counts[e.payload!.lane_id] ?? 0) + 1;
    const seen = JSON.parse((await getState(env, "lanes_event_counts")) ?? "{}") as Record<string, number>;

    const total = num(count);
    const have = (await env.DB.prepare("SELECT lane_id FROM ledger_lanes WHERE ledger = ? ORDER BY lane_id").bind(at).all<{ lane_id: number }>()).results.map((r) => r.lane_id);
    const haveSet = new Set(have);
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((id) => !haveSet.has(id));
    const changed = Object.keys(counts).map(Number).filter((id) => haveSet.has(id) && counts[id] !== (seen[id] ?? 0));
    const cursor = Number((await getState(env, "lanes_rotation")) ?? 0);
    const rotation = have.length ? Array.from({ length: Math.min(ROTATE, have.length) }, (_, i) => have[(cursor + i) % have.length]) : [];
    const todo = [...new Set([...missing, ...changed, ...rotation])];

    const stmts = await syncV02(env, t);
    const done = new Set<number>();
    for (const id of todo) {
      if (fetchesLeft <= 0) break;
      const nft = (await get(env, `/substates/nft_${lanesHex}_u64_${id}`))?.state?.up?.substate?.NonFungible;
      if (!nft) continue;
      // LaneInfo [id, buyer, provider, provider_key, voucher_key, opened_epoch]; LaneState [deposited, claimed, refunded, close_requested_epoch, closed].
      const [, buyer, provider, providerKey] = nft.data as any[];
      const [deposited, claimed, refunded, closeRequested, closed] = nft.mutable_data as any[];
      stmts.push(upsert(env, at, {
        lane_id: id, buyer: hex(buyer), provider: String(provider), provider_key: hex(providerKey), deposited: num(deposited), claimed: num(claimed),
        refunded: num(refunded), close_requested_epoch: closeRequested === null ? null : num(closeRequested), closed: closed === true,
      }, t));
      done.add(id);
    }
    const pending = todo.some((id) => !done.has(id));
    // Remember the event counts only once everything they pointed at has been read.
    if (!pending) stmts.push(setState(env, "lanes_event_counts", JSON.stringify(counts)));
    if (have.length) stmts.push(setState(env, "lanes_rotation", String((cursor + ROTATE) % have.length)));
    stmts.push(
      setState(env, "lanes_config", JSON.stringify({ lane_close_epochs: num(closeEpochs), count: total, lanes_resource: `resource_${lanesHex}` })),
      setState(env, "lanes_last_sync_at", String(t)),
      setState(env, "lanes_last_error", ""),
    );
    // D1 batches are capped, so write in slices.
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return { status: "ok", lanes: total, read: done.size, pending };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "lanes_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", lanes: 0, read: 0, error };
  }
}

/**
 * An agent's work history on both ledgers: lanes that actually paid it. Only paid-out lanes count, so lanes opened
 * with dust and never used don't inflate it. Escrow still open is shown separately.
 */
export async function workHistory(env: Env, name: string) {
  const ledgers = [ledger(env), DEPLOYMENT.v0_2.ledger];
  const rows = (await env.DB.prepare("SELECT * FROM ledger_lanes WHERE ledger IN (?, ?) AND provider = ? ORDER BY ledger = ? DESC, lane_id DESC")
    .bind(...ledgers, name, ledgers[0]).all<Record<string, any>>()).results;
  const paid = rows.filter((l) => l.claimed_microtari > 0);
  const buyers = new Set(paid.map((l) => l.buyer_key));
  const escrow = rows.filter((l) => !l.closed).reduce((s, l) => s + l.deposited_microtari - l.claimed_microtari - l.refunded_microtari, 0);
  const paidTotal = paid.reduce((s, l) => s + l.claimed_microtari, 0);
  return {
    ledgers,
    paid_lanes: paid.length,
    distinct_buyers: buyers.size,
    paid_microtari: paidTotal, paid_tari: tari(paidTotal),
    open_escrow_microtari: escrow, open_escrow_tari: tari(escrow),
    lanes: paid.slice(0, 50).map((l) => ({
      ledger: l.ledger, version: l.ledger === DEPLOYMENT.v0_2.ledger ? "v0.2" : "v0.3", lane_id: l.lane_id, buyer_key: l.buyer_key, paid_microtari: l.claimed_microtari, paid_tari: tari(l.claimed_microtari),
      escrowed_microtari: l.deposited_microtari, state: l.closed ? "closed" : l.close_requested_epoch !== null ? "closing" : "open",
    })),
  };
}

async function getLanesConfig(ctx: Ctx) {
  const cfg = await getState(ctx.env, "lanes_config");
  const last = await getState(ctx.env, "lanes_last_sync_at");
  const c = cfg ? JSON.parse(cfg) : {};
  return json({
    lanes: {
      network: DEPLOYMENT.network, ledger: ledger(ctx.env), template: DEPLOYMENT.template, lanes_resource: c.lanes_resource ?? null, lane_count: c.count ?? null,
      directory: DIRECTORY.directory, payment_resource: DEPLOYMENT.payment_resource,
      admin: null, fee: "none", lane_close_epochs: c.lane_close_epochs ?? null, client: DEPLOYMENT.client,
      voucher: {
        domain: LANE_VOUCHER_DOMAIN,
        message: "<ledger component address>|<lane id>|<spent_cum in microtari>",
        scheme: "Ristretto Schnorr, e = Blake2b-512(domain || public nonce || public key || message) mod l, s = r + e*k",
        signer: "/lane-voucher.mjs",
      },
      frozen: { v0_2: { ...DEPLOYMENT.v0_2, note: "no new lanes; funds can still be withdrawn (legacy/ in the lanes repo)" } },
      indexer: indexerBase(ctx.env), last_sync_at: last ? iso(Number(last)) : null, last_error: (await getState(ctx.env, "lanes_last_error")) || null,
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
