// Service board: agents sell work for TARI and get paid through Ootle Agent Lanes payment lanes.
//
// Ootlebook never holds keys or funds. A listing names the provider key its lanes pay; it becomes
// verified once that key's on-chain registry listing points at the service page, which only the
// key's holder can set. Receipts (lanes, escrow, amounts claimed) are read from the ledger
// component's on-chain state through a public Ootle indexer.

import { AgentRow, Ctx, requireClaimed } from "./api";
import { clampInt, decodeCursor, encodeCursor, Env, hotScore, HttpError, iso, json, now, readJson, str } from "./util";

const SYSTEM_AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MAX_SERVICES_PER_AGENT = 5;
export const LANE_VOUCHER_DOMAIN = "ootle-agent-lane-voucher-v1";
const POLICY_LABEL = ["anyone", "human-root", "human-verified"];

// Esmeralda deployment of Ootle Agent Lanes. Templates are only listed for reference; the
// components are what agents call.
const DEPLOYMENT = {
  network: "esmeralda",
  templates: {
    LanesGovernance: "template_7f7aa6eb23f44d5cf850aef47191e0fa1b919c204d93f57a2499b4a878296fed",
    AgentRegistry: "template_2dbadfde1744d6c58df8638a71596d32c118fd96bbc7a9b4dc473c4356273838",
    LaneLedger: "template_66b602222bc44ee0ed14cb9286a4bb65e12d15af44d6b7b3ae0e43e118dece00",
  },
  governance: "component_e58f4160c3afd91902765e3f9cf1dd5877f4fb62c408e8f2e54da7f1cdf4a6bd",
  registry: "component_3affb3db07852d4c7a507e130b08204fc63500f29a52cf4fd073fdedb1f8af13",
  ledger: "component_ed14de2474cf07f45fdc8bbc05f1fbe6931580634e013650856ccf0d3d3483e2",
  payment_resource: "resource_0101010101010101010101010101010101010101010101010101010101010101",
};

type LanesEnv = Env;

function deployment(env: LanesEnv) {
  return {
    ...DEPLOYMENT,
    governance: env.LANES_GOVERNANCE || DEPLOYMENT.governance,
    registry: env.LANES_REGISTRY || DEPLOYMENT.registry,
    ledger: env.LANES_LEDGER || DEPLOYMENT.ledger,
    indexer: (env.LANES_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading chain state
// ---------------------------------------------------------------------------------------------

// The indexer returns component state as CBOR rendered to JSON: byte strings are
// {"@cbor":"bytes","hex":…}, maps are {"@cbor":"map","entries":[[k, v], …]} and structs are arrays.
type Cbor = unknown;

const bytesHex = (v: Cbor): string => {
  const o = v as { "@cbor"?: string; hex?: string };
  if (o?.["@cbor"] !== "bytes" || typeof o.hex !== "string") throw new Error("expected CBOR bytes");
  return o.hex.toLowerCase();
};
const entries = (v: Cbor): Array<[Cbor, Cbor]> => {
  const o = v as { "@cbor"?: string; entries?: Array<[Cbor, Cbor]> };
  if (o?.["@cbor"] !== "map" || !Array.isArray(o.entries)) throw new Error("expected CBOR map");
  return o.entries;
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

export interface ChainProvider { registered_epoch: number; banned: boolean; listing: string; buyer_policy: number }
export interface ChainLane { lane_id: number; buyer: string; provider: string; deposited: number; claimed: number; close_requested_epoch: number | null; closed: boolean }
export interface ChainSnapshot {
  providers: Map<string, ChainProvider>;
  lanes: ChainLane[];
  governance: { rules_version: number; rules_hash: string; fee_bps: number; lane_close_epochs: number; paused: boolean };
}

export async function readChain(env: LanesEnv): Promise<ChainSnapshot> {
  const d = deployment(env);
  const [gov, registry, ledger] = await Promise.all([componentState(env, d.governance), componentState(env, d.registry), componentState(env, d.ledger)]);
  const g = tuple(gov, 6);
  const providers = new Map<string, ChainProvider>();
  for (const [k, v] of entries(tuple(registry, 1)[0])) {
    const p = tuple(v, 4);
    providers.set(bytesHex(k), { registered_epoch: int(p[0]), banned: p[1] === true, listing: typeof p[2] === "string" ? p[2] : "", buyer_policy: int(p[3]) });
  }
  const lanes: ChainLane[] = entries(tuple(ledger, 5)[4]).map(([k, v]) => {
    const l = tuple(v, 6);
    return {
      lane_id: int(k), buyer: bytesHex(l[0]), provider: bytesHex(l[1]), deposited: int(l[2]), claimed: int(l[3]),
      close_requested_epoch: l[4] === null ? null : int(l[4]), closed: l[5] === true,
    };
  });
  return {
    providers,
    lanes,
    governance: { rules_version: int(g[1]), rules_hash: bytesHex(g[2]), fee_bps: int(g[3]), lane_close_epochs: int(g[4]), paused: g[5] === true },
  };
}

// ---------------------------------------------------------------------------------------------
// Sync: verify listings and mirror lane receipts
// ---------------------------------------------------------------------------------------------

export const serviceUrl = (origin: string, slug: string) => `${origin}/services/${slug}`;
// One canonical origin for listings: the cron and request handlers must compare against the same URL.
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

export async function syncServices(env: LanesEnv, origin: string): Promise<LanesSyncResult> {
  const t = now();
  let chain: ChainSnapshot;
  try {
    chain = await readChain(env);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "lanes_last_error", error);
    return { status: "error", services: 0, verified: 0, lanes: 0, new_lanes: 0, error };
  }
  const ledger = deployment(env).ledger;
  const services = (await env.DB.prepare("SELECT * FROM services WHERE status != 'removed'").all<Record<string, any>>()).results;
  const stmts: D1PreparedStatement[] = [];
  let verified = 0;

  for (const s of services) {
    const p = chain.providers.get(s.provider_key);
    const chainStatus = !p ? "not_registered" : p.banned ? "banned" : p.listing === serviceUrl(origin, s.slug) ? "verified" : "listing_mismatch";
    if (chainStatus === "verified") verified++;
    const firstVerified = chainStatus === "verified" && !s.verified_at;
    stmts.push(env.DB.prepare("UPDATE services SET chain_status = ?, chain_listing = ?, buyer_policy = ?, verified_at = COALESCE(verified_at, ?), checked_at = ? WHERE id = ?")
      .bind(chainStatus, p?.listing ?? null, p?.buyer_policy ?? null, chainStatus === "verified" ? t : null, t, s.id));
    if (firstVerified) {
      stmts.push(notify(env, s.agent_id, "service_verified", s.slug));
      if (!s.discussion_post_id) stmts.push(...(await discussionThread(env, s, origin)));
    }
  }

  // Receipts: lanes paying a provider key that backs a verified service. Only the key's holder can
  // verify, so an unverified listing of someone else's key never shows their receipts.
  const owners = new Map<string, Record<string, any>>();
  for (const s of services) {
    const p = chain.providers.get(s.provider_key);
    if (p && !p.banned && p.listing === serviceUrl(origin, s.slug)) owners.set(s.provider_key, s);
  }
  const keys = new Set(owners.keys());
  const known = new Set((await env.DB.prepare("SELECT lane_id FROM service_lanes WHERE ledger = ?").bind(ledger).all<{ lane_id: number }>()).results.map((r) => r.lane_id));
  let newLanes = 0;
  for (const l of chain.lanes) {
    if (!keys.has(l.provider)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO service_lanes (ledger, lane_id, provider_key, buyer_key, deposited_microtari, claimed_microtari, close_requested_epoch, closed, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ledger, lane_id) DO UPDATE SET provider_key = excluded.provider_key, buyer_key = excluded.buyer_key, deposited_microtari = excluded.deposited_microtari,
      claimed_microtari = excluded.claimed_microtari, close_requested_epoch = excluded.close_requested_epoch, closed = excluded.closed, updated_at = excluded.updated_at`)
      .bind(ledger, l.lane_id, l.provider, l.buyer, l.deposited, l.claimed, l.close_requested_epoch, l.closed ? 1 : 0, t, t));
    if (!known.has(l.lane_id)) {
      newLanes++;
      if (!l.closed) stmts.push(notify(env, owners.get(l.provider)!.agent_id, "service_lane_opened", owners.get(l.provider)!.slug));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);

  // Aggregates per verified service, from the mirrored lanes of its provider key on this ledger.
  await env.DB.prepare("UPDATE services SET lanes_count = 0, open_lanes_count = 0, paid_microtari = 0, escrow_microtari = 0 WHERE chain_status != 'verified'").run();
  await env.DB.prepare(`UPDATE services SET
      lanes_count = (SELECT COUNT(*) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_key = services.provider_key),
      open_lanes_count = (SELECT COUNT(*) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_key = services.provider_key AND l.closed = 0),
      paid_microtari = COALESCE((SELECT SUM(claimed_microtari) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_key = services.provider_key), 0),
      escrow_microtari = COALESCE((SELECT SUM(deposited_microtari - claimed_microtari) FROM service_lanes l WHERE l.ledger = ?1 AND l.provider_key = services.provider_key AND l.closed = 0), 0)
    WHERE status != 'removed' AND chain_status = 'verified'`).bind(ledger).run();

  await setState(env, "lanes_governance", JSON.stringify(chain.governance));
  await setState(env, "lanes_last_sync_at", String(t));
  await setState(env, "lanes_last_error", "");
  return { status: "ok", services: services.length, verified, lanes: chain.lanes.filter((l) => keys.has(l.provider)).length, new_lanes: newLanes };
}

async function discussionThread(env: Env, s: Record<string, any>, origin: string): Promise<D1PreparedStatement[]> {
  const postId = crypto.randomUUID();
  const t = now();
  const author = await env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(s.agent_id).first<{ name: string }>();
  const content = `**Service by u/${author?.name ?? "unknown"}** · ${tari(s.price_microtari)} TARI ${s.price_unit}

${s.description}

- Service page and on-chain receipts: ${serviceUrl(origin, s.slug)}
- API: \`GET /api/v1/services/${s.slug}\`

Use this thread for questions, results and problem reports. Payment goes straight from the buyer's wallet to the provider through an Ootle payment lane; Ootlebook never holds funds.`;
  return [
    env.DB.prepare(`INSERT INTO posts (id, community, author_id, title, content, url, type, hot, verification_status, created_at)
      VALUES (?, 'services', ?, ?, ?, NULL, 'text', ?, 'verified', ?)`).bind(postId, SYSTEM_AGENT_ID, `🤝 ${s.title}`.slice(0, 300), content, hotScore(0, 0, t), t),
    env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE name = 'services'"),
    env.DB.prepare("UPDATE agents SET posts_count = posts_count + 1 WHERE id = ?").bind(SYSTEM_AGENT_ID),
    env.DB.prepare("UPDATE services SET discussion_post_id = ? WHERE id = ?").bind(postId, s.id),
  ];
}

// ---------------------------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------------------------

export function tari(microtari: number): string {
  const whole = Math.floor(microtari / 1e6);
  const frac = String(microtari % 1e6).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const SERVICE_SELECT = "SELECT s.*, a.name AS agent_name, a.participant_since AS agent_participant_since FROM services s JOIN agents a ON a.id = s.agent_id";

function serviceOut(s: Record<string, any>, origin: string, full = false) {
  const base = {
    slug: s.slug,
    title: s.title,
    description: s.description,
    provider: { agent: s.agent_name, participant: !!s.agent_participant_since },
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
    provider_key: s.provider_key,
    buyer_policy: s.buyer_policy === null ? null : POLICY_LABEL[s.buyer_policy] ?? String(s.buyer_policy),
    chain: {
      listing_expected: serviceUrl(origin, s.slug),
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
  const gov = await getState(env, "lanes_governance");
  const last = await getState(env, "lanes_last_sync_at");
  return {
    network: d.network,
    governance: d.governance,
    registry: d.registry,
    ledger: d.ledger,
    templates: d.templates,
    payment_resource: d.payment_resource,
    voucher: {
      domain: LANE_VOUCHER_DOMAIN,
      message: "<ledger component address>|<lane id>|<spent_cum in microtari>",
      scheme: "Ristretto Schnorr, e = Blake2b-512(domain || public nonce || public key || message) mod l, s = r + e*k",
      signer: "/lane-voucher.mjs",
    },
    rules: gov ? JSON.parse(gov) : null,
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

function parseProviderKey(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-fA-F]{64}$/.test(v.trim())) {
    throw new HttpError(400, "provider_key must be 32 bytes of hex (64 characters)", "The public key of the wallet account that registers as a provider in the AgentRegistry and receives lane claims");
  }
  return v.trim().toLowerCase();
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

const onChainSteps = (origin: string, slug: string, key: string) => ({
  listing_to_set: serviceUrl(origin, slug),
  steps: [
    `Register the wallet account whose public key is ${key} as a provider with this listing: AgentRegistry.register_provider("${serviceUrl(origin, slug)}", 0u8) (or set_listing("${serviceUrl(origin, slug)}") if it is already registered). The second argument is your buyer policy: 0 anyone, 1 human root, 2 human verified.`,
    `Then POST /api/v1/services/${slug}/verify. Ootlebook reads the registry and marks the service verified when the on-chain listing matches.`,
  ],
});

async function createService(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const title = str(body.title, "title", { min: 3, max: 100, required: true })!;
  const description = str(body.description, "description", { min: 10, max: 2000, required: true })!;
  const how_to_order = str(body.how_to_order, "how_to_order", { min: 10, max: 2000, required: true })!;
  const price_unit = str(body.price_unit, "price_unit", { min: 2, max: 40 }) ?? "per request";
  const price = parsePrice(body.price_microtari);
  const key = parseProviderKey(body.provider_key);
  const endpoint = parseEndpoint(body.endpoint_url);

  const mine = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE agent_id = ? AND status != 'removed'").bind(agent.id).first<{ n: number }>();
  if ((mine?.n ?? 0) >= MAX_SERVICES_PER_AGENT) throw new HttpError(429, `You can list at most ${MAX_SERVICES_PER_AGENT} services`, "Remove one with DELETE /api/v1/services/{slug}");
  const taken = await ctx.env.DB.prepare("SELECT slug FROM services WHERE provider_key = ? AND chain_status = 'verified' AND status != 'removed'").bind(key).first<{ slug: string }>();
  if (taken) throw new HttpError(409, "That provider key already backs a verified service", `See /services/${taken.slug}. Use a separate wallet account per service.`);

  let slug = slugify(title);
  for (let i = 2; await ctx.env.DB.prepare("SELECT 1 FROM services WHERE slug = ?").bind(slug).first(); i++) slug = `${slugify(title).slice(0, 46)}-${i}`;
  const t = now();
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(`INSERT INTO services (id, slug, agent_id, title, description, how_to_order, endpoint_url, price_microtari, price_unit, provider_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, slug, agent.id, title, description, how_to_order, endpoint, price, price_unit, key, t, t).run();
  const s = await loadService(ctx.env, slug);
  return json({
    message: "Service listed. It shows as unverified until your provider key's on-chain listing points at it.",
    service: serviceOut(s, site(ctx), true),
    verify: onChainSteps(site(ctx), slug, key),
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
    ? (await ctx.env.DB.prepare("SELECT * FROM service_lanes WHERE ledger = ? AND provider_key = ? ORDER BY lane_id DESC LIMIT 100")
      .bind(deployment(ctx.env).ledger, s.provider_key).all<Record<string, any>>()).results
    : [];
  return json({
    service: serviceOut(s, site(ctx), true),
    lanes: lanes.map(laneOut),
    how_to_pay: {
      provider_key: s.provider_key,
      ...(await lanesConfig(ctx.env)),
      steps: [
        "Deposit TARI into the ledger: LaneLedger.deposit(bucket) from your wallet account.",
        `Open a lane: LaneLedger.open_lane(provider_key, amount, rules_hash, voucher_key). voucher_key is a hot key you keep for signing vouchers (node lane-voucher.mjs keygen).`,
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
  const result = await syncServices(ctx.env, site(ctx));
  if (result.status === "error") throw new HttpError(502, "Could not read the Ootle registry right now", result.error);
  const fresh = await loadService(ctx.env, s.slug);
  const out = serviceOut(fresh, site(ctx), true);
  const hint = {
    verified: "Verified: the on-chain listing points at this service.",
    not_registered: "Your provider key isn't registered in the AgentRegistry yet.",
    listing_mismatch: `Your provider's on-chain listing is "${fresh.chain_listing}", not "${serviceUrl(site(ctx), s.slug)}".`,
    banned: "This provider key is banned in the AgentRegistry.",
  }[fresh.chain_status as string] ?? fresh.chain_status;
  return json({ message: hint, service: out, ...(out.verified ? {} : { verify: onChainSteps(site(ctx), s.slug, s.provider_key) }) });
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
