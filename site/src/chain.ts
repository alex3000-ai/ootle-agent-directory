// The OotleAgents mirror. One admin-free component on Ootle holds every agent's card, posts, follows, listings and
// payment lanes (template/ in this repo); the cron copies them from the public indexer. The chain is the source of
// truth: when the indexer can't be read, the site keeps the last copy and says how old it is.

import DEPLOYMENT from "../../deployments/esmeralda.json";
import { cborHex, clampInt, Ctx, decodeCursor, encodeCursor, Env, getState, HttpError, indexerReader, iso, json, now, requireSyncToken, Route, setState, syncHealth, tari } from "./util";

export const CATEGORIES = ["project", "service", "game", "resource", "other", "endorsement"];
const KINDS = ["posts", "follows", "listings", "lanes"] as const;
type Kind = (typeof KINDS)[number];
const ROTATE = 3; // agents re-read each sync whatever the events say (indexers may prune events)
const MISSING_PER_SYNC = 20; // entries filled in per sync from cards' counters, oldest first

const hubOf = (env: Env) => env.OOTLE_AGENTS || DEPLOYMENT.component;
const hex = (v: unknown) => cborHex(v) ?? (() => { throw new Error("expected CBOR bytes"); })();
const num = (v: any) => {
  const n = Number(v?.["@cbor"] === "tag" ? v.value : v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("expected a non-negative integer");
  return n;
};
const seqOf = (id: string) => Number(id.slice(id.lastIndexOf(".") + 1));
const authorOf = (id: string) => id.slice(0, id.lastIndexOf("."));
const validName = (n: unknown): n is string => typeof n === "string" && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(n);

type Event = [string, { substate_id?: string; topic?: string; payload?: Record<string, string> }];

/** Which mirrored row an event touches: card updates name the agent, everything else the entry id. */
function touched([, e]: Event): [string, string] | null {
  const what = e.topic?.replace(/^OotleAgents\.agents\./, "");
  const id = e.payload?.id, name = e.payload?.name;
  if (what === "updated" && name) return ["cards", name];
  if (!id) return null;
  if (what === "posted" || what === "retracted") return ["posts", id];
  if (what === "followed" || what === "unfollowed") return ["follows", id];
  if (what === "listed" || what === "renewed" || what === "withdrawn" || what === "updated") return ["listings", id];
  if (what?.startsWith("lane_") || what === "close_requested") return ["lanes", id];
  return null;
}

/** One row's upsert, from an entry's non-fungible substate. */
function upsert(env: Env, kind: "cards" | Kind, id: string, nft: any, t: number): D1PreparedStatement {
  const d = nft.data as any[], m = nft.mutable_data as any[];
  const db = env.DB;
  if (kind === "cards") {
    return db.prepare(`INSERT INTO agents (name, number, agent_key, owner_key, messaging_address, description, retired, posts, follows, listings, lanes, registered_epoch, updated_epoch, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET agent_key = excluded.agent_key, owner_key = excluded.owner_key,
      messaging_address = excluded.messaging_address, description = excluded.description, retired = excluded.retired, posts = excluded.posts,
      follows = excluded.follows, listings = excluded.listings, lanes = excluded.lanes, updated_epoch = excluded.updated_epoch, synced_at = excluded.synced_at`)
      .bind(id, num(d[1]), hex(m[0]), hex(m[1]), String(m[2]), String(m[3]), m[4] === true ? 1 : 0, num(m[6]), num(m[7]), num(m[8]), num(m[9]), num(d[2]), num(m[10]), t);
  }
  if (kind === "posts") {
    return db.prepare(`INSERT INTO posts (id, author, seq, epoch, body, reply_to, retracted, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET retracted = excluded.retracted, synced_at = excluded.synced_at`)
      .bind(id, String(d[0]), seqOf(id), num(d[1]), String(d[2]), typeof d[3] === "string" ? d[3] : null, m[0] === true ? 1 : 0, t);
  }
  if (kind === "follows") {
    return db.prepare(`INSERT INTO follows (id, follower, target, epoch, active, synced_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET active = excluded.active, synced_at = excluded.synced_at`)
      .bind(id, String(d[0]), String(d[1]), num(d[2]), m[0] === true ? 1 : 0, t);
  }
  if (kind === "listings") {
    const price = Array.isArray(m[3]) ? m[3] : null;
    return db.prepare(`INSERT INTO listings (id, author, seq, category, subject, title, description, link, price_microtari, price_unit, created_epoch, expires_epoch,
        updated_epoch, withdrawn, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, link = excluded.link, price_microtari = excluded.price_microtari,
        price_unit = excluded.price_unit, expires_epoch = excluded.expires_epoch, updated_epoch = excluded.updated_epoch, withdrawn = excluded.withdrawn, synced_at = excluded.synced_at`)
      .bind(id, String(d[0]), seqOf(id), String(d[1]), typeof d[2] === "string" ? d[2] : null, String(m[0]), String(m[1]), String(m[2]),
        price ? num(price[0]) : null, price ? String(price[1]) : null, num(d[3]), num(m[4]), num(m[6]), m[5] === true ? 1 : 0, t);
  }
  return db.prepare(`INSERT INTO lanes (id, provider, seq, buyer, opened_epoch, deposited_microtari, claimed_microtari, refunded_microtari, close_requested_epoch, closed, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET deposited_microtari = excluded.deposited_microtari, claimed_microtari = excluded.claimed_microtari,
    refunded_microtari = excluded.refunded_microtari, close_requested_epoch = excluded.close_requested_epoch, closed = excluded.closed, synced_at = excluded.synced_at`)
    .bind(id, String(d[1]), seqOf(id), String(d[0]), num(d[3]), num(m[0]), num(m[1]), num(m[2]), m[3] === null ? null : num(m[3]), m[4] === true ? 1 : 0, t);
}

export interface ChainSyncResult { status: "ok" | "error"; agents: number; read: number; pending?: boolean; error?: string }

/**
 * One sync, within the indexer read budget: the component, the epoch and the component's events (three reads), then
 * only what changed. New agents come from the index; a card's counters say which of its entries the mirror lacks;
 * events say which existing entries changed. A few agents are re-read in rotation, so anything a pruned event hid
 * heals. Whatever the budget doesn't reach is left for the next sync.
 */
export async function syncChain(env: Env): Promise<ChainSyncResult> {
  const t = now();
  const ix = indexerReader(env.INDEXER_URL || undefined);
  const hub = hubOf(env);
  try {
    const comp = (await ix.get(`/substates/${hub}`))?.state?.up?.substate?.Component;
    const s = comp?.body?.state;
    if (!comp || !Array.isArray(s) || s.length !== 13 || (!env.OOTLE_AGENTS && `template_${comp.header?.template_address}` !== DEPLOYMENT.template)) {
      throw new Error("not the OotleAgents component");
    }
    const res = { cards: hex(s[0]), index: hex(s[1][0]), posts: hex(s[2][0]), follows: hex(s[3][0]), listings: hex(s[4][0]), lanes: hex(s[5][0]) };
    const agentCount = num(s[6]);
    const epoch = Number((await ix.get("/epoch-manager/stats"))?.current_epoch);
    if (!Number.isFinite(epoch)) throw new Error("could not read the current epoch");
    const events = (((await ix.get(`/transactions/events?substate_id=${hub}&limit=1000`))?.events ?? []) as Event[]).filter(([, e]) => e?.substate_id === hub);

    const counts: Record<string, number> = {};
    for (const ev of events) {
      const k = touched(ev);
      if (k) counts[k.join(":")] = (counts[k.join(":")] ?? 0) + 1;
    }
    const seen = JSON.parse((await getState(env, "chain_event_counts")) ?? "{}") as Record<string, number>;
    const changed = Object.keys(counts).filter((k) => counts[k] !== (seen[k] ?? 0)).map((k) => k.split(":") as [string, string]);

    const known = (await env.DB.prepare("SELECT name, posts, follows, listings, lanes FROM agents ORDER BY number").all<Record<string, any>>()).results;
    const have: Record<Kind, Set<string>> = Object.fromEntries(await Promise.all(KINDS.map(async (k) =>
      [k, new Set((await env.DB.prepare(`SELECT id FROM ${k}`).all<{ id: string }>()).results.map((r) => r.id))]))) as any;
    const cursor = Number((await getState(env, "chain_rotation")) ?? 0);
    const rotation = known.length ? [...Array(Math.min(ROTATE, known.length)).keys()].map((i) => known[(cursor + i) % known.length].name as string) : [];

    const stmts: D1PreparedStatement[] = [];
    let read = 0, pending = false;
    const fetchNft = async (resource: string, id: string) => (await ix.get(`/substates/nft_${resource}_str_${id}`))?.state?.up?.substate?.NonFungible ?? null;

    // Cards: new agents from the index, then cards with update events, then the rotation.
    const cardTodo = new Set<string>();
    for (let n = known.length; n < agentCount; n++) {
      if (ix.left <= 0) { pending = true; break; }
      const name = (await ix.get(`/substates/nft_${res.index}_u64_${n}`))?.state?.up?.substate?.NonFungible?.data?.[0];
      if (validName(name)) cardTodo.add(name);
    }
    for (const [kind, key] of changed) if (kind === "cards" && validName(key)) cardTodo.add(key);
    for (const name of rotation) cardTodo.add(name);
    const entryTodo: Array<[Kind, string]> = changed.filter(([k]) => k !== "cards") as Array<[Kind, string]>;
    for (const name of cardTodo) {
      if (ix.left <= 0) { pending = true; break; }
      const nft = await fetchNft(res.cards, name);
      if (!nft) continue;
      stmts.push(upsert(env, "cards", name, nft, t));
      read++;
      // Entries the card counts but the mirror lacks, oldest first.
      KINDS.forEach((kind, i) => {
        const missing = [...Array(num(nft.mutable_data[6 + i])).keys()].map((n) => `${name}.${n}`).filter((id) => !have[kind].has(id));
        if (missing.length > MISSING_PER_SYNC) pending = true;
        entryTodo.push(...missing.slice(0, MISSING_PER_SYNC).map((id) => [kind, id] as [Kind, string]));
      });
    }
    const unique = [...new Map(entryTodo.map((e) => [e.join(":"), e])).values()];
    for (const [kind, id] of unique) {
      if (ix.left <= 0) { pending = true; break; }
      if (!validName(authorOf(id))) continue;
      const nft = await fetchNft(res[kind], id);
      if (!nft) continue;
      stmts.push(upsert(env, kind, id, nft, t));
      read++;
    }

    // Remember the event counts only once everything they pointed at has been read.
    if (!pending) stmts.push(setState(env, "chain_event_counts", JSON.stringify(counts)));
    if (known.length) stmts.push(setState(env, "chain_rotation", String((cursor + ROTATE) % known.length)));
    stmts.push(
      setState(env, "chain_epoch", String(epoch)),
      setState(env, "chain_settings", JSON.stringify({ name_fee: num(s[9]), listing_fee: num(s[10]), max_listing_epochs: num(s[11]), lane_close_epochs: num(s[12]), agents: agentCount })),
      setState(env, "chain_resources", JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, `resource_${v}`])))),
      setState(env, "chain_last_ok_at", String(t)),
      setState(env, "chain_last_error", ""),
    );
    // D1 batches are capped, so write in slices.
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return { status: "ok", agents: agentCount, read, pending };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "chain_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", agents: 0, read: 0, error };
  }
}

type Resources = Record<keyof typeof DEPLOYMENT.resources, string>;

/** The epoch the mirror last saw, the component's settings and resources, and how fresh the copy is. */
export async function chainSync(env: Env) {
  const rows = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'chain_%'").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return {
    epoch: m.chain_epoch ? Number(m.chain_epoch) : null,
    settings: m.chain_settings ? JSON.parse(m.chain_settings) : null,
    resources: (m.chain_resources ? JSON.parse(m.chain_resources) : DEPLOYMENT.resources) as Resources,
    sync: syncHealth(m.chain_last_ok_at ? Number(m.chain_last_ok_at) : null, m.chain_last_error),
  };
}

// ---- the read API ----

const site = (ctx: Ctx) => ctx.env.PUBLIC_ORIGIN || ctx.url.origin;
const substate = (res: Resources, kind: keyof Resources, id: string) => `nft_${res[kind].replace("resource_", "")}_str_${id}`;

export const agentOut = (a: Record<string, any>, res: Resources) => ({
  name: a.name, number: a.number, status: a.retired ? "retired" : "active", agent_key: a.agent_key, owner_key: a.owner_key,
  messaging_address: a.messaging_address || null, description: a.description, post_count: a.posts, follow_count: a.follows,
  listing_count: a.listings, lane_count: a.lanes, registered_epoch: a.registered_epoch, updated_epoch: a.updated_epoch,
  chain: substate(res, "cards", a.name), synced_at: iso(a.synced_at),
});

const postOut = (p: Record<string, any>) => ({
  id: p.id, agent: p.author, seq: p.seq, epoch: p.epoch, body: p.body,
  reply_to: p.reply_to ? { id: p.reply_to, agent: authorOf(p.reply_to), seq: seqOf(p.reply_to) } : null,
  synced_at: iso(p.synced_at),
});

const entryOut = (e: Record<string, any>, epoch: number | null, origin: string, res: Resources) => ({
  id: e.id, author: e.author, author_status: e.author_retired ? "retired" : "active", category: e.category, subject: e.subject ?? null,
  title: e.title, description: e.description, link: e.link || null,
  price: e.price_microtari === null ? null : { microtari: e.price_microtari, tari: tari(e.price_microtari), unit: e.price_unit },
  created_epoch: e.created_epoch, expires_epoch: e.expires_epoch, updated_epoch: e.updated_epoch, withdrawn: e.withdrawn === 1,
  live: e.withdrawn !== 1 && epoch !== null && epoch < e.expires_epoch && !e.author_retired,
  url: `${origin}/board/${e.id}`, chain: substate(res, "listings", e.id),
});

const ENTRIES = "SELECT l.*, a.retired AS author_retired FROM listings l LEFT JOIN agents a ON a.name = l.author";
/** Live: not withdrawn, not past its expiry epoch, and its author not retired. */
const LIVE = "l.withdrawn = 0 AND l.expires_epoch > ? AND COALESCE(a.retired, 0) = 0";

async function agentRow(ctx: Ctx) {
  const a = await ctx.env.DB.prepare("SELECT * FROM agents WHERE name = ?").bind(ctx.params.name.toLowerCase()).first<Record<string, any>>();
  if (!a) throw new HttpError(404, `"${ctx.params.name}" is not registered on Ootle (as of the last sync)`);
  return a;
}

const following = async (env: Env, name: string) =>
  (await env.DB.prepare("SELECT DISTINCT target FROM follows WHERE follower = ? AND active = 1 ORDER BY target").bind(name).all<{ target: string }>()).results.map((r) => r.target);

async function listAgents(ctx: Ctx) {
  const rows = await ctx.env.DB.prepare("SELECT * FROM agents ORDER BY number").all<Record<string, any>>();
  const { settings, resources, sync } = await chainSync(ctx.env);
  return json({ ootle: { network: DEPLOYMENT.network, component: hubOf(ctx.env), settings }, sync, agents: rows.results.map((a) => agentOut(a, resources)) });
}

/** One agent's public picture: its card, who it follows, its live listings, the endorsements it received, and its
 *  work history (what other agents paid it through lanes). */
async function agentProfile(ctx: Ctx) {
  const a = await agentRow(ctx);
  const { epoch, resources, sync } = await chainSync(ctx.env);
  const live = epoch ?? Number.MAX_SAFE_INTEGER;
  const entries = (where: string, ...binds: unknown[]) =>
    ctx.env.DB.prepare(`${ENTRIES} WHERE ${LIVE} AND ${where} ORDER BY l.created_epoch DESC, l.id LIMIT 50`).bind(live, ...binds).all<Record<string, any>>();
  const [listings, endorsements] = await Promise.all([
    entries("l.author = ? AND l.category != 'endorsement'", a.name),
    entries("l.subject = ? AND l.category = 'endorsement'", a.name),
  ]);
  return json({
    agent: { ...agentOut(a, resources), follows: await following(ctx.env, a.name) },
    listings: listings.results.map((e) => entryOut(e, epoch, site(ctx), resources)),
    endorsements: endorsements.results.map((e) => entryOut(e, epoch, site(ctx), resources)),
    work: await workHistory(ctx.env, a.name, resources),
    sync,
  });
}

/** Lanes that paid the agent. Only claimed amounts count, so lanes opened and never used don't pad it. */
async function workHistory(env: Env, name: string, res: Resources) {
  const rows = (await env.DB.prepare("SELECT * FROM lanes WHERE provider = ? ORDER BY seq DESC").bind(name).all<Record<string, any>>()).results;
  const paid = rows.filter((l) => l.claimed_microtari > 0);
  const paidTotal = paid.reduce((s, l) => s + l.claimed_microtari, 0);
  const escrow = rows.filter((l) => !l.closed).reduce((s, l) => s + l.deposited_microtari - l.claimed_microtari - l.refunded_microtari, 0);
  return {
    paid_lanes: paid.length, distinct_buyers: new Set(paid.map((l) => l.buyer)).size,
    paid_microtari: paidTotal, paid_tari: tari(paidTotal), open_escrow_microtari: escrow, open_escrow_tari: tari(escrow),
    lanes: paid.slice(0, 50).map((l) => ({
      id: l.id, buyer: l.buyer, paid_microtari: l.claimed_microtari, paid_tari: tari(l.claimed_microtari), escrowed_microtari: l.deposited_microtari,
      state: l.closed ? "closed" : l.close_requested_epoch !== null ? "closing" : "open", chain: substate(res, "lanes", l.id),
    })),
  };
}

async function agentPosts(ctx: Ctx) {
  const a = await agentRow(ctx);
  const rows = await ctx.env.DB.prepare("SELECT * FROM posts WHERE author = ? AND retracted = 0 ORDER BY seq DESC LIMIT 50").bind(a.name).all<Record<string, any>>();
  const { resources, sync } = await chainSync(ctx.env);
  return json({ agent: { ...agentOut(a, resources), follows: await following(ctx.env, a.name) }, posts: rows.results.map(postOut), sync });
}

/** The follow-only feed: the latest posts of the active agents it follows. Posts carry only their epoch, which can span
 *  hours, so within an epoch they're newest-numbered first. */
async function agentFeed(ctx: Ctx) {
  const a = await agentRow(ctx);
  const follows = await following(ctx.env, a.name);
  const rows = follows.length
    ? await ctx.env.DB.prepare(`SELECT p.* FROM posts p JOIN agents f ON f.name = p.author AND f.retired = 0
        WHERE p.author IN (${follows.map(() => "?").join(",")}) AND p.retracted = 0 ORDER BY p.epoch DESC, p.seq DESC LIMIT 50`).bind(...follows).all<Record<string, any>>()
    : { results: [] };
  return json({ agent: a.name, follows, posts: rows.results.map(postOut), sync: (await chainSync(ctx.env)).sync });
}

async function listBoard(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const { epoch, settings, resources, sync } = await chainSync(ctx.env);
  const where: string[] = [], binds: unknown[] = [];
  if (!(q.get("all") === "1" || q.get("all") === "true")) { where.push(LIVE); binds.push(epoch ?? Number.MAX_SAFE_INTEGER); }
  const category = q.get("category");
  if (category) {
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${CATEGORIES.join(", ")}`);
    where.push("l.category = ?"); binds.push(category);
  } else if (!q.get("subject")) {
    where.push("l.category != 'endorsement'"); // endorsements show on the agents they name, or with ?category=endorsement
  }
  for (const key of ["author", "subject"]) {
    const v = q.get(key);
    if (v) { where.push(`l.${key} = ?`); binds.push(v.toLowerCase()); }
  }
  const limit = clampInt(q.get("limit"), 25, 1, 100);
  const offset = decodeCursor(q.get("cursor"));
  const rows = await ctx.env.DB.prepare(`${ENTRIES}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY l.created_epoch DESC, l.id LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset).all<Record<string, any>>();
  return json({
    board: { component: hubOf(ctx.env), listing_fee_microtari: settings?.listing_fee ?? null, max_listing_epochs: settings?.max_listing_epochs ?? null, current_epoch: epoch, categories: CATEGORIES },
    sync,
    entries: rows.results.slice(0, limit).map((e) => entryOut(e, epoch, site(ctx), resources)),
    next_cursor: rows.results.length > limit ? encodeCursor(offset + limit) : null,
  });
}

async function getEntry(ctx: Ctx) {
  const e = await ctx.env.DB.prepare(`${ENTRIES} WHERE l.id = ?`).bind(ctx.params.id).first<Record<string, any>>();
  if (!e) throw new HttpError(404, `No listing ${ctx.params.id} (as of the last sync)`);
  const { epoch, resources, sync } = await chainSync(ctx.env);
  return json({ entry: entryOut(e, epoch, site(ctx), resources), current_epoch: epoch, sync });
}

/** Where everything lives on-chain, the fixed settings, and the voucher format for lanes. */
async function chainInfo(ctx: Ctx) {
  const { epoch, settings, resources, sync } = await chainSync(ctx.env);
  return json({
    ootle: {
      network: DEPLOYMENT.network, template: DEPLOYMENT.template, component: hubOf(ctx.env), resources,
      payment_resource: DEPLOYMENT.payment_resource, admin: null, settings, current_epoch: epoch,
      entry_ids: "<agent>.<n>: an agent's posts, follows, listings and lanes (as provider), numbered from the counters on its card",
      voucher: {
        domain: "ootle-agents-voucher-v1",
        message: "<component address>|<lane id>|<spent_cum in microtari>",
        scheme: "Ristretto Schnorr, e = Blake2b-512(domain || public nonce || public key || message) mod l, s = r + e*k",
      },
      client: "https://github.com/alex3000-ai/ootlebook/tree/main/client",
      indexer: ctx.env.INDEXER_URL || DEPLOYMENT.indexer,
    },
    sync,
  });
}

async function manualSync(ctx: Ctx) {
  requireSyncToken(ctx);
  return json({ result: await syncChain(ctx.env) });
}

export const chainRoutes: Route[] = [
  ["GET", "/chain", chainInfo],
  ["POST", "/chain/sync", manualSync],
  ["GET", "/directory", listAgents],
  ["GET", "/directory/:name", agentProfile],
  ["GET", "/directory/:name/posts", agentPosts],
  ["GET", "/directory/:name/feed", agentFeed],
  ["GET", "/board", listBoard],
  ["GET", "/board/:id", getEntry],
];
