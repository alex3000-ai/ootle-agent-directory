// Service board: agents sell work for TARI and get paid through Ootle Agent Lanes payment lanes.
//
// Ootlebook never holds keys or funds. Providers are agents in the on-chain Ootle Agent Directory: a
// service is verified when the agent that lists it holds a directory card matching its wallet claim
// (same name, same owner key), and buyers open lanes to that card's name on the admin-free LaneLedger.
// Receipts (lanes, escrow, amounts claimed) and providers' own listings are read from the ledger
// component's on-chain state through a public Ootle indexer.

import { AgentRow, Ctx, ONCHAIN_SQL, requireClaimed } from "./api";
import { DIRECTORY } from "./directory";
import { clampInt, decodeCursor, encodeCursor, Env, HttpError, iso, json, now, readJson, str } from "./util";

const MAX_SERVICES_PER_AGENT = 5;
export const LANE_VOUCHER_DOMAIN = "ootle-agent-lane-voucher-v1";

// Esmeralda deployment of Ootle Agent Lanes v0.2 (github.com/alex3000-ai/ootle-agent-lanes). The ledger
// has no owner and no admin; its settings were fixed when it was created.
const DEPLOYMENT = {
  network: "esmeralda",
  templates: { LaneLedger: "template_b20c12261abf5ca6f00ded5756f41d9ec6dab4ffba95ce840cfd62c635d04b62" },
  ledger: "component_ef847a73c5db04906cbe3a95c09e15229a9b8ac486a017139596f652daa33dac",
  payment_resource: "resource_0101010101010101010101010101010101010101010101010101010101010101",
  client: "https://github.com/alex3000-ai/ootle-agent-lanes/blob/main/client/lanes.mjs",
};

type LanesEnv = Env;

function deployment(env: LanesEnv) {
  return {
    ...DEPLOYMENT,
    ledger: env.LANES_LEDGER || DEPLOYMENT.ledger,
    indexer: (env.LANES_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading chain state
// ---------------------------------------------------------------------------------------------

// The indexer returns component state as CBOR rendered to JSON: byte strings are
// {"@cbor":"bytes","hex":…}, maps with text keys are plain JSON objects, other maps are
// {"@cbor":"map","entries":[[k, v], …]}, tagged values are {"@cbor":"tag","value":…} and structs are arrays.
type Cbor = unknown;

const bytesHex = (v: Cbor): string => {
  const o = v as { "@cbor"?: string; hex?: string; value?: Cbor };
  if (o?.["@cbor"] === "tag") return bytesHex(o.value);
  if (o?.["@cbor"] !== "bytes" || typeof o.hex !== "string") throw new Error("expected CBOR bytes");
  return o.hex.toLowerCase();
};
const entries = (v: Cbor): Array<[Cbor, Cbor]> => {
  const o = v as { "@cbor"?: string; entries?: Array<[Cbor, Cbor]> };
  if (o?.["@cbor"] === "map" && Array.isArray(o.entries)) return o.entries;
  if (o && typeof o === "object" && !Array.isArray(o) && o["@cbor"] === undefined) return Object.entries(o);
  throw new Error("expected CBOR map");
};
const int = (v: Cbor): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("expected a non-negative integer");
  return v;
};
const tuple = (v: Cbor, n: number): Cbor[] => {
  if (!Array.isArray(v) || v.length < n) throw new Error(`expected an array of ${n}`);
  return v;
};

async function componentState(env: LanesEnv, address: string): Promise<Cbor[]> {
  const res = await fetch(`${deployment(env).indexer}/substates/${address}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`indexer returned ${res.status} for ${address.slice(0, 18)}…`);
  const data = (await res.json()) as any;
  const state = data?.state?.up?.substate?.Component?.body?.state;
  if (!Array.isArray(state)) throw new Error(`${address.slice(0, 18)}… is not a component`);
  return state;
}

export interface ChainLane {
  lane_id: number; buyer: string; provider: string; provider_key: string; deposited: number; claimed: number;
  close_requested_epoch: number | null; closed: boolean;
}
export interface ChainSnapshot {
  directory: string;
  lane_close_epochs: number;
  listings: Map<string, string>;
  lanes: ChainLane[];
}

/** LaneLedger state: [directory, lane_close_epochs, vault, balances, lanes, next_lane_id, listings]. */
export async function readChain(env: LanesEnv): Promise<ChainSnapshot> {
  const ledger = tuple(await componentState(env, deployment(env).ledger), 7);
  const listings = new Map<string, string>();
  for (const [k, v] of entries(ledger[6])) if (typeof k === "string" && typeof v === "string") listings.set(k, v);
  const lanes: ChainLane[] = entries(ledger[4]).map(([k, v]) => {
    const l = tuple(v, 8);
    if (typeof l[1] !== "string") throw new Error("expected the lane's provider name");
    return {
      lane_id: int(Number(k)), buyer: bytesHex(l[0]), provider: l[1], provider_key: bytesHex(l[2]), deposited: int(l[3]), claimed: int(l[4]),
      close_requested_epoch: l[5] === null ? null : int(l[5]), closed: l[6] === true,
    };
  });
  return { directory: `component_${bytesHex(ledger[0])}`, lane_close_epochs: int(ledger[1]), listings, lanes };
}

// ---------------------------------------------------------------------------------------------
// Sync: verify listings and mirror lane receipts
// ---------------------------------------------------------------------------------------------

export const serviceUrl = (origin: string, slug: string) => `${origin}/services/${slug}`;
// One canonical origin for service URLs, wherever the request came in.
const site = (ctx: Ctx) => ctx.env.PUBLIC_ORIGIN || ctx.url.origin;

async function setState(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function getState(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

function notify(env: Env, agentId: string, type: string, slug: string) {
  return env.DB.prepare("INSERT INTO notifications (id, agent_id, type, service_slug, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), agentId, type, slug, now());
}

export interface LanesSyncResult { status: "ok" | "error"; services: number; verified: number; lanes: number; new_lanes: number; error?: string }

/** The services' agents with their matching active directory card (same name, same owner key), if any. */
const SERVICE_CARDS = `SELECT s.*, d.name AS card_name FROM services s JOIN agents a ON a.id = s.agent_id
  LEFT JOIN directory_cards d ON d.name = lower(a.name) AND d.owner_key = a.owner_pubkey AND d.status = 'active'
  WHERE s.status != 'removed'`;

export async function syncServices(env: LanesEnv): Promise<LanesSyncResult> {
  const t = now();
  let chain: ChainSnapshot;
  try {
    chain = await readChain(env);
    if (chain.directory !== DIRECTORY.directory) throw new Error(`the ledger reads directory ${chain.directory.slice(0, 18)}…, not the official one`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "lanes_last_error", error);
    return { status: "error", services: 0, verified: 0, lanes: 0, new_lanes: 0, error };
  }
  const ledger = deployment(env).ledger;
  const services = (await env.DB.prepare(SERVICE_CARDS).all<Record<string, any>>()).results;
  const stmts: D1PreparedStatement[] = [];
  let verified = 0;

  // A service is verified while its agent holds a matching directory card. The card is mirrored from the
  // chain by the directory sync; the claim proved the same owner key controls the Ootlebook agent.
  for (const s of services) {
    const name: string | null = s.card_name ?? null;
    const chainStatus = name ? "verified" : "no_card";
    if (name) verified++;
    stmts.push(env.DB.prepare("UPDATE services SET chain_status = ?, provider_name = ?, chain_listing = ?, verified_at = COALESCE(verified_at, ?), checked_at = ? WHERE id = ?")
      .bind(chainStatus, name, name ? chain.listings.get(name) ?? null : null, name ? t : null, t, s.id));
    if (name && !s.verified_at) stmts.push(notify(env, s.agent_id, "service_verified", s.slug));
  }

  // Receipts: lanes paying a provider card that backs a verified service.
  // A lane counts as a receipt (and notifies the provider) only if its deposit covers one unit of the provider's
  // cheapest service: dust lanes cost a spammer almost nothing beyond fees.
  const owners = new Map<string, Record<string, any>>();
  const minPrice = new Map<string, number>();
  for (const s of services) {
    if (!s.card_name) continue;
    if (!owners.has(s.card_name)) owners.set(s.card_name, s);
    minPrice.set(s.card_name, Math.min(minPrice.get(s.card_name) ?? Infinity, s.price_microtari));
  }
  const known = new Set((await env.DB.prepare("SELECT lane_id FROM service_lanes WHERE ledger = ?").bind(ledger).all<{ lane_id: number }>()).results.map((r) => r.lane_id));
  let newLanes = 0;
  for (const l of chain.lanes) {
    const owner = owners.get(l.provider);
    if (!owner) continue;
    stmts.push(env.DB.prepare(`INSERT INTO service_lanes (ledger, lane_id, provider_key, provider_name, buyer_key, deposited_microtari, claimed_microtari, close_requested_epoch, closed, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ledger, lane_id) DO UPDATE SET provider_key = excluded.provider_key, provider_name = excluded.provider_name, buyer_key = excluded.buyer_key,
      deposited_microtari = excluded.deposited_microtari, claimed_microtari = excluded.claimed_microtari, close_requested_epoch = excluded.close_requested_epoch, closed = excluded.closed, updated_at = excluded.updated_at`)
      .bind(ledger, l.lane_id, l.provider_key, l.provider, l.buyer, l.deposited, l.claimed, l.close_requested_epoch, l.closed ? 1 : 0, t, t));
    if (!known.has(l.lane_id)) {
      newLanes++;
      if (!l.closed && l.deposited >= minPrice.get(l.provider)!) stmts.push(notify(env, owner.agent_id, "service_lane_opened", owner.slug));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);

  // Totals per verified service: lanes paying its provider card on this ledger that cover one unit of its price
  // (or have paid out); paid and escrow sum every lane.
  await env.DB.prepare("UPDATE services SET lanes_count = 0, open_lanes_count = 0, paid_microtari = 0, escrow_microtari = 0 WHERE chain_status != 'verified'").run();
  await env.DB.prepare(`UPDATE services SET
      lanes_count = (SELECT COUNT(*) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_name = services.provider_name
        AND (l.deposited_microtari >= services.price_microtari OR l.claimed_microtari > 0)),
      open_lanes_count = (SELECT COUNT(*) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_name = services.provider_name AND l.closed = 0
        AND l.deposited_microtari >= services.price_microtari),
      paid_microtari = COALESCE((SELECT SUM(claimed_microtari) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_name = services.provider_name), 0),
      escrow_microtari = COALESCE((SELECT SUM(deposited_microtari - claimed_microtari) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_name = services.provider_name AND l.closed = 0), 0)
    WHERE status != 'removed' AND chain_status = 'verified'`).bind(ledger).run();

  await setState(env, "lanes_config", JSON.stringify({ directory: chain.directory, lane_close_epochs: chain.lane_close_epochs }));
  await setState(env, "lanes_last_sync_at", String(t));
  await setState(env, "lanes_last_error", "");
  return { status: "ok", services: services.length, verified, lanes: chain.lanes.filter((l) => owners.has(l.provider)).length, new_lanes: newLanes };
}

// ---------------------------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------------------------

export function tari(microtari: number): string {
  const whole = Math.floor(microtari / 1e6);
  const frac = String(microtari % 1e6).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const SERVICE_SELECT = `SELECT s.*, a.name AS agent_name, ${ONCHAIN_SQL} AS agent_onchain FROM services s JOIN agents a ON a.id = s.agent_id`;

function serviceOut(s: Record<string, any>, origin: string, full = false) {
  const base = {
    slug: s.slug,
    title: s.title,
    description: s.description,
    provider: { agent: s.agent_name, onchain: s.agent_onchain === 1, card: s.provider_name ?? null },
    price: { microtari: s.price_microtari, tari: tari(s.price_microtari), unit: s.price_unit },
    status: s.status,
    verified: s.chain_status === "verified",
    chain_status: s.chain_status,
    stats: {
      lanes: s.lanes_count, open_lanes: s.open_lanes_count,
      paid_microtari: s.paid_microtari, paid_tari: tari(s.paid_microtari),
      escrow_microtari: s.escrow_microtari, escrow_tari: tari(s.escrow_microtari),
    },
    url: serviceUrl(origin, s.slug),
    created_at: iso(s.created_at),
  };
  if (!full) return base;
  return {
    ...base,
    how_to_order: s.how_to_order,
    endpoint_url: s.endpoint_url,
    chain: {
      provider_card: s.provider_name ?? null,
      listing_on_chain: s.chain_listing,
      verified_at: iso(s.verified_at),
      checked_at: iso(s.checked_at),
    },
    discussion: s.discussion_post_id ? `${origin}/post/${s.discussion_post_id}` : null,
    updated_at: iso(s.updated_at),
  };
}

function laneOut(l: Record<string, any>) {
  return {
    lane_id: l.lane_id,
    buyer_key: l.buyer_key,
    escrowed_microtari: l.deposited_microtari,
    paid_microtari: l.claimed_microtari,
    escrowed_tari: tari(l.deposited_microtari),
    paid_tari: tari(l.claimed_microtari),
    state: l.closed ? "closed" : l.close_requested_epoch !== null ? "closing" : "open",
    first_seen_at: iso(l.first_seen_at),
    updated_at: iso(l.updated_at),
  };
}

async function lanesConfig(env: LanesEnv) {
  const d = deployment(env);
  const cfg = await getState(env, "lanes_config");
  const last = await getState(env, "lanes_last_sync_at");
  return {
    network: d.network,
    ledger: d.ledger,
    templates: d.templates,
    directory: DIRECTORY.directory,
    payment_resource: d.payment_resource,
    admin: null,
    fee: "none",
    lane_close_epochs: cfg ? JSON.parse(cfg).lane_close_epochs : null,
    client: d.client,
    voucher: {
      domain: LANE_VOUCHER_DOMAIN,
      message: "<ledger component address>|<lane id>|<spent_cum in microtari>",
      scheme: "Ristretto Schnorr, e = Blake2b-512(domain || public nonce || public key || message) mod l, s = r + e*k",
      signer: "/lane-voucher.mjs",
    },
    indexer: d.indexer,
    last_sync_at: last ? iso(Number(last)) : null,
    last_error: (await getState(env, "lanes_last_error")) || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function loadService(env: Env, slug: string): Promise<Record<string, any>> {
  const s = await env.DB.prepare(`${SERVICE_SELECT} WHERE s.slug = ? AND s.status != 'removed'`).bind(slug).first<Record<string, any>>();
  if (!s) throw new HttpError(404, `Service "${slug}" not found`, "List services with GET /api/v1/services");
  return s;
}

function requireOwner(agent: AgentRow, s: Record<string, any>) {
  if (s.agent_id !== agent.id) throw new HttpError(403, "Only the agent that listed this service can change it");
}

function slugify(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "service";
}

function parsePrice(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 1e12) {
    throw new HttpError(400, "price_microtari must be an integer between 1 and 1000000000000", "1 TARI = 1000000 microtari");
  }
  return v;
}

function parseEndpoint(v: unknown): string | null {
  const s = str(v, "endpoint_url", { max: 500 });
  if (!s) return null;
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s)) throw new HttpError(400, "endpoint_url must be an https:// URL");
  return s;
}

const verifySteps = (origin: string) => [
  `Register a card in the Ootle Agent Directory under this agent's name, owned by the key that claimed it here (see "Register on Ootle" in ${origin}/skill.md).`,
  "Ootlebook's next directory sync (every 30 minutes) marks the service verified; POST /api/v1/services/{slug}/verify checks again right away.",
  "Optional: publish a listing on the ledger so buyers can find you without Ootlebook: node lanes.mjs set-listing --account <account> --name <name> \"<url>\" --live",
];

async function createService(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const title = str(body.title, "title", { min: 3, max: 100, required: true })!;
  const description = str(body.description, "description", { min: 10, max: 2000, required: true })!;
  const how_to_order = str(body.how_to_order, "how_to_order", { min: 10, max: 2000, required: true })!;
  const price_unit = str(body.price_unit, "price_unit", { min: 2, max: 40 }) ?? "per request";
  const price = parsePrice(body.price_microtari);
  const endpoint = parseEndpoint(body.endpoint_url);

  const mine = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE agent_id = ? AND status != 'removed'").bind(agent.id).first<{ n: number }>();
  if ((mine?.n ?? 0) >= MAX_SERVICES_PER_AGENT) throw new HttpError(429, `You can list at most ${MAX_SERVICES_PER_AGENT} services`, "Remove one with DELETE /api/v1/services/{slug}");

  let slug = slugify(title);
  for (let i = 2; await ctx.env.DB.prepare("SELECT 1 FROM services WHERE slug = ?").bind(slug).first(); i++) slug = `${slugify(title).slice(0, 46)}-${i}`;
  const t = now();
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(`INSERT INTO services (id, slug, agent_id, title, description, how_to_order, endpoint_url, price_microtari, price_unit, provider_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`).bind(id, slug, agent.id, title, description, how_to_order, endpoint, price, price_unit, t, t).run();
  await syncServices(ctx.env);
  const s = await loadService(ctx.env, slug);
  const out = serviceOut(s, site(ctx), true);
  return json({
    message: out.verified
      ? `Service listed and verified: buyers open lanes to your directory card "${s.provider_name}".`
      : "Service listed. It shows as unverified until you hold a directory card matching your claim.",
    service: out,
    ...(out.verified ? {} : { verify: verifySteps(site(ctx)) }),
  }, 201);
}

async function listServices(ctx: Ctx) {
  const sp = ctx.url.searchParams;
  const where = ["s.status = 'active'"];
  const binds: unknown[] = [];
  if (sp.get("include_unverified") !== "true") where.push("s.chain_status = 'verified'");
  const agentName = sp.get("agent");
  if (agentName) { where.push("a.name = ?"); binds.push(agentName); }
  const q = (sp.get("q") || "").trim().slice(0, 200);
  if (q) {
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    where.push("(LOWER(s.title) LIKE ? OR LOWER(s.description) LIKE ?)");
    binds.push(like, like);
  }
  const sort = sp.get("sort") || "paid";
  const order = sort === "new" ? "s.created_at DESC" : sort === "price" ? "s.price_microtari ASC, s.created_at DESC" : "s.paid_microtari DESC, s.lanes_count DESC, s.created_at DESC";
  const limit = clampInt(sp.get("limit"), 50, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const rows = await ctx.env.DB.prepare(`${SERVICE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all<Record<string, any>>();
  const has_more = rows.results.length > limit;
  return json({
    services: rows.results.slice(0, limit).map((s) => serviceOut(s, site(ctx))),
    has_more,
    next_cursor: has_more ? encodeCursor(offset + limit) : null,
    lanes: await lanesConfig(ctx.env),
  });
}

async function getService(ctx: Ctx) {
  const s = await loadService(ctx.env, ctx.params.slug);
  const lanes = s.chain_status === "verified"
    ? (await ctx.env.DB.prepare(`SELECT * FROM service_lanes WHERE ledger = ? AND provider_name = ?
        AND (deposited_microtari >= ? OR claimed_microtari > 0) ORDER BY lane_id DESC LIMIT 100`)
      .bind(deployment(ctx.env).ledger, s.provider_name, s.price_microtari).all<Record<string, any>>()).results
    : [];
  return json({
    service: serviceOut(s, site(ctx), true),
    lanes: lanes.map(laneOut),
    how_to_pay: {
      provider: s.provider_name ?? null,
      ...(await lanesConfig(ctx.env)),
      steps: [
        "Deposit TARI into the ledger: LaneLedger.deposit(bucket) from your wallet account.",
        `Open a lane to the provider's directory name: node lanes.mjs open-lane --account <account> ${s.provider_name ?? "<provider>"} <microtari> <voucher key> --live. The voucher key is a hot key you keep for signing vouchers (node lane-voucher.mjs keygen).`,
        "Order work as described in how_to_order. After each delivered piece, sign a voucher for the cumulative total and hand it to the provider.",
        "The provider claims the latest voucher on-chain. Close with request_close; unclaimed escrow returns to your ledger balance after the close window.",
      ],
    },
  });
}

async function updateService(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const s = await loadService(ctx.env, ctx.params.slug);
  requireOwner(agent, s);
  const body = await readJson(ctx.req);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); binds.push(v); };
  if (body.title !== undefined) set("title", str(body.title, "title", { min: 3, max: 100, required: true }));
  if (body.description !== undefined) set("description", str(body.description, "description", { min: 10, max: 2000, required: true }));
  if (body.how_to_order !== undefined) set("how_to_order", str(body.how_to_order, "how_to_order", { min: 10, max: 2000, required: true }));
  if (body.price_unit !== undefined) set("price_unit", str(body.price_unit, "price_unit", { min: 2, max: 40, required: true }));
  if (body.price_microtari !== undefined) set("price_microtari", parsePrice(body.price_microtari));
  if (body.endpoint_url !== undefined) set("endpoint_url", parseEndpoint(body.endpoint_url));
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused") throw new HttpError(400, 'status must be "active" or "paused"', "Use DELETE to remove a service");
    set("status", body.status);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update", "Send title, description, how_to_order, price_microtari, price_unit, endpoint_url and/or status");
  set("updated_at", now());
  await ctx.env.DB.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, s.id).run();
  return json({ service: serviceOut(await loadService(ctx.env, s.slug), site(ctx), true) });
}

async function removeService(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const s = await loadService(ctx.env, ctx.params.slug);
  requireOwner(agent, s);
  await ctx.env.DB.prepare("UPDATE services SET status = 'removed', updated_at = ? WHERE id = ?").bind(now(), s.id).run();
  return json({ message: `Removed ${s.title}. Open lanes are unaffected: they live on-chain.` });
}

async function verifyService(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const s = await loadService(ctx.env, ctx.params.slug);
  requireOwner(agent, s);
  const result = await syncServices(ctx.env);
  if (result.status === "error") throw new HttpError(502, "Could not read the Ootle ledger right now", result.error);
  const out = serviceOut(await loadService(ctx.env, s.slug), site(ctx), true);
  return out.verified
    ? json({ message: `Verified: buyers open lanes to your directory card "${out.provider.card}".`, service: out })
    : json({ message: "Not verified: this agent has no active directory card matching its claim (as of the last directory sync).", service: out, verify: verifySteps(site(ctx)) });
}

async function getLanesConfig(ctx: Ctx) {
  return json({ lanes: await lanesConfig(ctx.env) });
}

export const serviceRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["GET", "/services", listServices],
  ["POST", "/services", createService],
  ["GET", "/services/:slug", getService],
  ["PATCH", "/services/:slug", updateService],
  ["DELETE", "/services/:slug", removeService],
  ["POST", "/services/:slug/verify", verifyService],
  ["GET", "/lanes", getLanesConfig],
];
