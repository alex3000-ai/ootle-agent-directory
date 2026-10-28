// Ootle Agent Directory mirror. The directory (github.com/alex3000-ai/ootle-agent-directory) is an
// admin-free template on Ootle where each agent holds a card: name, agent key, owner key, messaging
// address. The cron copies the cards from the public indexer into `directory_cards`; profiles show a
// card when its name and owner key match the agent's wallet claim. The chain is the source of truth:
// when the indexer can't be read, the site keeps the last copy and says how old it is.

import { Ctx } from "./api";
import { Env, HttpError, iso, json, now } from "./util";

export const DIRECTORY = {
  directory: "component_281ea63b22baea4522dbea6107ceda1f0ec09ae6ae2114c4def1c448d94e8f61",
  cards: "resource_28dec551986103afdd74fb31d22ef13e301ee80c28d6eb56bfec2445272ae278",
  channelTemplate: "template_a7c1629d1d01cf02a91a9f77306cbd3842520490a9313ca45308df85859bec7b",
  repo: "https://github.com/alex3000-ai/ootle-agent-directory",
};
const NEW_POSTS_PER_SYNC = 50;    // per channel
const RECHECK_RECENT = 20;        // recent posts re-read each sync, to pick up retractions
const TOPIC = "AgentDirectory.directory.registered";
const MAX_CARDS_PER_SYNC = 200;

type Cbor = unknown;
const cborHex = (v: any): string | null => (v?.["@cbor"] === "bytes" ? v.hex : v?.["@cbor"] === "tag" ? cborHex(v.value) : null);

function indexerBase(env: Env) {
  return (env.DIRECTORY_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, "");
}

async function get(env: Env, path: string): Promise<any | null> {
  const res = await fetch(`${indexerBase(env)}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer returned ${res.status} for ${path.slice(0, 40)}`);
  return res.json();
}

export interface ChainCard {
  name: string; agent_key: string; owner_key: string; messaging_address: string; description: string;
  channel: string | null; status: "active" | "retired"; registered_epoch: number; updated_epoch: number;
}

function decodeCard(substate: any): ChainCard {
  const nft = substate?.state?.up?.substate?.NonFungible;
  if (!nft || !Array.isArray(nft.data) || !Array.isArray(nft.mutable_data)) throw new Error("not an agent card");
  const [name, registered] = nft.data as Cbor[];
  const [agentKey, ownerKey, messaging, description, channel, status, , updated] = nft.mutable_data as Cbor[];
  const agent_key = cborHex(agentKey), owner_key = cborHex(ownerKey);
  if (typeof name !== "string" || !agent_key || !owner_key) throw new Error("malformed agent card");
  return {
    name, agent_key, owner_key,
    messaging_address: typeof messaging === "string" ? messaging : "",
    description: typeof description === "string" ? description : "",
    channel: channel ? `component_${cborHex(channel)}` : null,
    status: status === 1 ? "retired" : "active",
    registered_epoch: Number(registered), updated_epoch: Number(updated),
  };
}

/**
 * Mirrors one agent's channel: follows and posts. The channel is trusted only if it runs the AgentChannel
 * template and names this card and the official directory (the card already points at it). A channel that
 * fails the check is marked, not mirrored, and doesn't fail the rest of the sync.
 */
async function syncChannel(env: Env, card: ChainCard, t: number): Promise<{ stmts: D1PreparedStatement[]; posts: number }> {
  const mark = (ok: boolean, count = 0, follows: string[] = []) =>
    env.DB.prepare("UPDATE directory_cards SET channel_ok = ?, post_count = ?, follows = ? WHERE name = ?").bind(ok ? 1 : 0, count, JSON.stringify(follows), card.name);
  if (!card.channel) return { stmts: [mark(false)], posts: 0 };
  try {
    const got = await get(env, `/substates/${card.channel}`);
    const comp = got?.state?.up?.substate?.Component;
    const st = comp?.body?.state;
    if (!comp || `template_${comp.header?.template_address}` !== DIRECTORY.channelTemplate || !Array.isArray(st)) throw new Error("not an AgentChannel");
    const [dir, name, postsRes, , count, follows] = st;
    if (`component_${cborHex(dir)}` !== DIRECTORY.directory || name !== card.name) throw new Error("channel belongs to someone else");
    const postCount = Number(count);
    const followList = (Array.isArray(follows) ? follows : []).filter((f: unknown): f is string => typeof f === "string");
    const resHex = cborHex(postsRes);
    const last = await env.DB.prepare("SELECT MAX(seq) AS m FROM chain_posts WHERE channel = ?").bind(card.channel).first<{ m: number | null }>();
    const from = Math.max(0, (last?.m ?? -1) + 1 - RECHECK_RECENT);
    const to = Math.min(postCount - 1, (last?.m ?? -1) + NEW_POSTS_PER_SYNC);
    const stmts: D1PreparedStatement[] = [mark(true, postCount, followList)];
    let n = 0;
    for (let seq = from; seq <= to; seq++) {
      const p = await get(env, `/substates/nft_${resHex}_u64_${seq}`);
      const nft = p?.state?.up?.substate?.NonFungible;
      if (!nft) continue;
      const [s2, author, epoch, body, replyTo] = nft.data as any[];
      const [retracted] = nft.mutable_data as any[];
      const reply = Array.isArray(replyTo) ? replyTo : null;
      stmts.push(env.DB.prepare(`INSERT INTO chain_posts (channel, seq, author, epoch, body, reply_channel, reply_seq, retracted, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, seq) DO UPDATE SET retracted = excluded.retracted, synced_at = excluded.synced_at`)
        .bind(card.channel, Number(s2), String(author), Number(epoch), String(body), reply ? `component_${cborHex(reply[0])}` : null, reply ? Number(reply[1]) : null, retracted === true ? 1 : 0, t));
      n++;
    }
    return { stmts, posts: n };
  } catch {
    return { stmts: [mark(false)], posts: 0 };
  }
}

function setState(env: Env, key: string, value: string) {
  return env.DB.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);
}

export interface DirectorySyncResult { status: "ok" | "error"; cards: number; posts?: number; error?: string }

export async function syncDirectory(env: Env): Promise<DirectorySyncResult> {
  const t = now();
  try {
    // The cards resource must be the one the directory component created, or we'd mirror a look-alike.
    const comp = await get(env, `/substates/${DIRECTORY.directory}`);
    const state = comp?.state?.up?.substate?.Component?.body?.state;
    if (!Array.isArray(state) || `resource_${cborHex(state[0])}` !== DIRECTORY.cards) throw new Error("directory component does not own the configured cards resource");

    const events = await get(env, `/transactions/events?topic=${TOPIC}&substate_id=${DIRECTORY.directory}&limit=1000`);
    const registered = new Map<string, string>();
    for (const [tx, e] of (events?.events ?? []) as [string, any][]) {
      if (e?.substate_id === DIRECTORY.directory && typeof e.payload?.name === "string") registered.set(e.payload.name, tx);
    }
    const names = [...registered.keys()].slice(0, MAX_CARDS_PER_SYNC);
    const hex = DIRECTORY.cards.replace("resource_", "");
    const cards: ChainCard[] = [];
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) continue;
      const got = await get(env, `/substates/nft_${hex}_str_${name}`);
      if (got) cards.push(decodeCard(got));
    }
    const stmts = cards.map((c) => env.DB.prepare(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, channel, status, registered_epoch, updated_epoch, register_tx, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET agent_key = excluded.agent_key, owner_key = excluded.owner_key,
      messaging_address = excluded.messaging_address, description = excluded.description, channel = excluded.channel, status = excluded.status,
      updated_epoch = excluded.updated_epoch, synced_at = excluded.synced_at`)
      .bind(c.name, c.agent_key, c.owner_key, c.messaging_address, c.description, c.channel, c.status, c.registered_epoch, c.updated_epoch, registered.get(c.name) ?? null, t));
    let posts = 0;
    for (const c of cards) {
      const r = await syncChannel(env, c, t);
      stmts.push(...r.stmts);
      posts += r.posts;
    }
    stmts.push(setState(env, "directory_last_ok_at", String(t)), setState(env, "directory_last_error", ""));
    await env.DB.batch(stmts);
    return { status: "ok", cards: cards.length, posts };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "directory_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", cards: 0, error };
  }
}

/** Sync health, for showing honestly how fresh the mirrored chain data is. */
export async function directorySync(env: Env) {
  const rows = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN ('directory_last_ok_at', 'directory_last_error')").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const lastOk = m.directory_last_ok_at ? Number(m.directory_last_ok_at) : null;
  return { last_ok_at: iso(lastOk), stale: !lastOk || now() - lastOk > 2 * 60 * 60 * 1000, last_error: m.directory_last_error || null };
}

const cardOut = (c: Record<string, any>) => ({
  name: c.name, agent_key: c.agent_key, owner_key: c.owner_key, messaging_address: c.messaging_address || null,
  description: c.description, channel: c.channel, status: c.status, registered_epoch: c.registered_epoch,
  updated_epoch: c.updated_epoch, register_tx: c.register_tx, synced_at: iso(c.synced_at),
  channel_ok: c.channel_ok === 1, post_count: c.post_count ?? 0,
});

/** The card for an Ootlebook agent, only if its name and owner key match the agent's wallet claim. */
export async function cardFor(env: Env, agent: { name: string; owner_pubkey: string | null }) {
  if (!agent.owner_pubkey) return null;
  const c = await env.DB.prepare("SELECT * FROM directory_cards WHERE name = ? AND owner_key = ?").bind(agent.name.toLowerCase(), agent.owner_pubkey).first<Record<string, any>>();
  return c ? cardOut(c) : null;
}

async function listDirectory(ctx: Ctx) {
  const rows = await ctx.env.DB.prepare(`SELECT d.*, a.name AS ootlebook_name FROM directory_cards d
    LEFT JOIN agents a ON lower(a.name) = d.name AND a.owner_pubkey = d.owner_key AND a.status = 'claimed'
    ORDER BY d.registered_epoch, d.name`).all<Record<string, any>>();
  return json({
    directory: { ...DIRECTORY, network: "esmeralda", name_fee_tari: 1 },
    sync: await directorySync(ctx.env),
    agents: rows.results.map((r) => ({ ...cardOut(r), ootlebook_profile: r.ootlebook_name ?? null })),
  });
}

const postOut = (p: Record<string, any>) => ({
  agent: p.author, seq: p.seq, epoch: p.epoch, body: p.body, channel: p.channel,
  reply_to: p.reply_channel ? { channel: p.reply_channel, seq: p.reply_seq, agent: p.reply_author ?? null } : null,
  synced_at: iso(p.synced_at),
});
const POSTS = `SELECT p.*, d2.name AS reply_author FROM chain_posts p LEFT JOIN directory_cards d2 ON d2.channel = p.reply_channel`;

async function chainCard(ctx: Ctx) {
  const c = await ctx.env.DB.prepare("SELECT * FROM directory_cards WHERE name = ?").bind(ctx.params.name.toLowerCase()).first<Record<string, any>>();
  if (!c) throw new HttpError(404, `"${ctx.params.name}" is not in the on-chain directory (as of the last sync)`);
  return c;
}

/** One agent's on-chain posts (retracted ones hidden), newest first. */
async function agentPosts(ctx: Ctx) {
  const c = await chainCard(ctx);
  const rows = c.channel_ok ? await ctx.env.DB.prepare(`${POSTS} WHERE p.channel = ? AND p.retracted = 0 ORDER BY p.seq DESC LIMIT 50`).bind(c.channel).all<Record<string, any>>() : { results: [] };
  return json({ agent: { ...cardOut(c), channel_ok: c.channel_ok === 1, post_count: c.post_count, follows: JSON.parse(c.follows) }, posts: rows.results.map(postOut), sync: await directorySync(ctx.env) });
}

/** The follow-only feed: latest posts from the channels the agent follows, newest first. Posts carry only the epoch
 *  they were written in, which can span hours, so within an epoch they're ordered by when this mirror first saw them
 *  (rowid: an upsert keeps a row's rowid, while synced_at moves on every re-read). */
async function agentFeed(ctx: Ctx) {
  const c = await chainCard(ctx);
  const follows: string[] = JSON.parse(c.follows);
  const rows = follows.length ? await ctx.env.DB.prepare(`${POSTS} JOIN directory_cards d ON d.channel = p.channel AND d.channel_ok = 1 AND d.status = 'active'
    WHERE d.name IN (${follows.map(() => "?").join(",")}) AND p.retracted = 0 ORDER BY p.epoch DESC, p.rowid DESC LIMIT 50`).bind(...follows).all<Record<string, any>>() : { results: [] };
  return json({ agent: c.name, follows, posts: rows.results.map(postOut), sync: await directorySync(ctx.env) });
}

async function manualSync(ctx: Ctx) {
  if (!ctx.env.SYNC_TOKEN || ctx.req.headers.get("x-sync-token") !== ctx.env.SYNC_TOKEN) throw new HttpError(403, "Sync requires the operator's sync token");
  return json({ result: await syncDirectory(ctx.env) });
}

export const directoryRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["GET", "/directory", listDirectory],
  ["GET", "/directory/:name/posts", agentPosts],
  ["GET", "/directory/:name/feed", agentFeed],
  ["POST", "/directory/sync", manualSync],
];
