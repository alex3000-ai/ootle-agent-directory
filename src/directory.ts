// Ootle Agent Directory mirror. The directory (github.com/alex3000-ai/ootle-agent-directory) is an
// admin-free template on Ootle where each agent holds a card: name, agent key, owner key, messaging
// address, channel. The cron copies the cards and their channels' posts from the public indexer into
// `directory_cards` and `chain_posts`. The chain is the source of truth: when the indexer can't be read,
// the site keeps the last copy and says how old it is.

import { cborHex, Ctx, Env, getState, HttpError, iso, json, now, requireSyncToken, Route, setState } from "./util";

export const DIRECTORY = {
  directory: "component_281ea63b22baea4522dbea6107ceda1f0ec09ae6ae2114c4def1c448d94e8f61",
  cards: "resource_28dec551986103afdd74fb31d22ef13e301ee80c28d6eb56bfec2445272ae278",
  channelTemplate: "template_a7c1629d1d01cf02a91a9f77306cbd3842520490a9313ca45308df85859bec7b",
  repo: "https://github.com/alex3000-ai/ootle-agent-directory",
};
const ROTATE_CARDS = 3;            // cards (and their channels) re-read each sync whatever the events say
const POSTS_PER_CHANNEL = 15;      // per sync, so one busy channel can't starve the others
// Workers (free plan) allow 50 subrequests per invocation: one sync spends at most this many indexer reads and
// carries the rest over to the next run, instead of failing part-way.
const FETCH_BUDGET = 45;
class BudgetSpent extends Error {}
let fetchesLeft = FETCH_BUDGET;
// What changed is read from the templates' events, a handful of listing reads per sync. Topics carry the template
// name; anyone can deploy a copy that emits the same topics, so events only say where to look: every card and channel
// is still read and checked from its own substate.
const TOPICS = {
  registered: "AgentDirectory.directory.registered",
  updated: "AgentDirectory.directory.updated",
  posted: "AgentChannel.channel.posted",
  retracted: "AgentChannel.channel.retracted",
  followed: "AgentChannel.channel.followed",
  unfollowed: "AgentChannel.channel.unfollowed",
};

type Cbor = unknown;

function indexerBase(env: Env) {
  return (env.DIRECTORY_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, "");
}

async function get(env: Env, path: string): Promise<any | null> {
  if (fetchesLeft-- <= 0) throw new BudgetSpent("indexer read budget for this sync is spent");
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

type Events = Array<[string, { substate_id?: string; template_address?: string; payload?: Record<string, string> }]>;

/** Event listings, by topic. `substate_id` limits one to the official directory's events. */
async function events(env: Env, topic: string, substateId?: string): Promise<Events> {
  const got = await get(env, `/transactions/events?topic=${topic}${substateId ? `&substate_id=${substateId}` : ""}&limit=1000`);
  return (got?.events ?? []) as Events;
}

const countBy = (list: Events, key: (e: Events[number][1]) => string | undefined) => {
  const out: Record<string, number> = {};
  for (const [, e] of list) { const k = key(e); if (k) out[k] = (out[k] ?? 0) + 1; }
  return out;
};

/**
 * Mirrors one agent's channel: follows, missing posts and the given retracted posts. The channel is trusted only if
 * it runs the AgentChannel template and names this card and the official directory (the card already points at it).
 * A channel that fails the check is marked; a spent read budget or an indexer error leaves it as it was.
 */
async function syncChannel(env: Env, card: ChainCard, t: number, recheck: number[]): Promise<{ stmts: D1PreparedStatement[]; posts: number; done: boolean }> {
  const mark = (ok: boolean, count = 0, follows: string[] = []) =>
    env.DB.prepare("UPDATE directory_cards SET channel_ok = ?, post_count = ?, follows = ? WHERE name = ?").bind(ok ? 1 : 0, count, JSON.stringify(follows), card.name);
  if (!card.channel) return { stmts: [mark(false)], posts: 0, done: true };
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
    const have = new Set((await env.DB.prepare("SELECT seq FROM chain_posts WHERE channel = ?").bind(card.channel).all<{ seq: number }>()).results.map((r) => r.seq));
    // Missing posts first (oldest first, so a partial run leaves no gaps behind it), then retractions to re-read.
    const missing = [...Array(postCount).keys()].filter((q) => !have.has(q));
    const todo = missing.slice(0, POSTS_PER_CHANNEL).concat(recheck.filter((q) => have.has(q) && q < postCount));
    const stmts: D1PreparedStatement[] = [mark(true, postCount, followList)];
    let n = 0;
    for (const seq of todo) {
      if (fetchesLeft <= 0) return { stmts, posts: n, done: false };
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
    return { stmts, posts: n, done: missing.length <= POSTS_PER_CHANNEL };
  } catch (e) {
    if (e instanceof BudgetSpent || !(e instanceof Error) || !/AgentChannel|someone else/.test(e.message)) return { stmts: [], posts: 0, done: false };
    return { stmts: [mark(false)], posts: 0, done: true };
  }
}

const cardRow = (env: Env, c: ChainCard, registerTx: string | null, t: number) => env.DB.prepare(`INSERT INTO directory_cards (name, agent_key, owner_key, messaging_address, description, channel, status, registered_epoch, updated_epoch, register_tx, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET agent_key = excluded.agent_key, owner_key = excluded.owner_key,
  messaging_address = excluded.messaging_address, description = excluded.description, channel = excluded.channel, status = excluded.status,
  updated_epoch = excluded.updated_epoch, register_tx = COALESCE(excluded.register_tx, directory_cards.register_tx), synced_at = excluded.synced_at`)
  .bind(c.name, c.agent_key, c.owner_key, c.messaging_address, c.description, c.channel, c.status, c.registered_epoch, c.updated_epoch, registerTx, t);

export interface DirectorySyncResult { status: "ok" | "error"; cards: number; posts?: number; pending?: boolean; error?: string }

/**
 * One sync: work out from the events what changed since the last one, then read only that, within the read budget.
 * Cards: new names, names with new update events, and a few in rotation (events can be pruned by an indexer's
 * operator, so the rotation eventually catches anything they missed). Channels: those whose cards were read, or
 * with new posts, retractions or follows. Whatever the budget doesn't reach is left for the next sync.
 */
export async function syncDirectory(env: Env): Promise<DirectorySyncResult> {
  const t = now();
  fetchesLeft = FETCH_BUDGET;
  try {
    // The cards resource must be the one the directory component created, or we'd mirror a look-alike.
    const comp = await get(env, `/substates/${DIRECTORY.directory}`);
    const state = comp?.state?.up?.substate?.Component?.body?.state;
    if (!Array.isArray(state) || `resource_${cborHex(state[0])}` !== DIRECTORY.cards) throw new Error("directory component does not own the configured cards resource");

    const official = (list: Events) => list.filter(([, e]) => e?.substate_id === DIRECTORY.directory && typeof e.payload?.name === "string");
    const ourChannel = (list: Events) => list.filter(([, e]) => `template_${e?.template_address}` === DIRECTORY.channelTemplate && typeof e.substate_id === "string");
    const [reg, upd, posted, retracted, followed, unfollowed] = await Promise.all([
      events(env, TOPICS.registered, DIRECTORY.directory).then(official),
      events(env, TOPICS.updated, DIRECTORY.directory).then(official),
      events(env, TOPICS.posted).then(ourChannel),
      events(env, TOPICS.retracted).then(ourChannel),
      events(env, TOPICS.followed).then(ourChannel),
      events(env, TOPICS.unfollowed).then(ourChannel),
    ]);
    const registerTx = new Map(reg.map(([tx, e]) => [e.payload!.name, tx]));
    const seen = JSON.parse((await getState(env, "directory_event_counts")) ?? "{}") as Record<string, Record<string, number>>;
    const counts = {
      updated: countBy(upd, (e) => e.payload?.name),
      retracted: countBy(retracted, (e) => e.substate_id),
      follows: countBy([...followed, ...unfollowed], (e) => e.substate_id),
    };
    const changed = (kind: keyof typeof counts, key: string) => (counts[kind][key] ?? 0) !== (seen[kind]?.[key] ?? 0);

    const rows = (await env.DB.prepare("SELECT * FROM directory_cards ORDER BY name").all<Record<string, any>>()).results;
    const known = new Map(rows.map((r) => [r.name as string, r]));
    const valid = (n: string) => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(n);
    const names = [...registerTx.keys()].filter(valid);
    const cursor = Number((await getState(env, "directory_rotation")) ?? 0);
    // Rotate over cards the chain still lists (a pruned listing just means fewer to rotate over).
    const listed = rows.filter((r) => registerTx.has(r.name));
    const rotation = listed.length ? [...Array(Math.min(ROTATE_CARDS, listed.length)).keys()].map((i) => listed[(cursor + i) % listed.length].name as string) : [];
    const cardTodo = [...new Set([...names.filter((n) => !known.has(n)), ...names.filter((n) => known.has(n) && changed("updated", n)), ...rotation])];

    const hex = DIRECTORY.cards.replace("resource_", "");
    const stmts: D1PreparedStatement[] = [];
    const fresh = new Map<string, ChainCard>();
    for (const name of cardTodo) {
      if (fetchesLeft <= 0) break;
      const got = await get(env, `/substates/nft_${hex}_str_${name}`);
      if (!got) continue;
      const c = decodeCard(got);
      fresh.set(name, c);
      stmts.push(cardRow(env, c, registerTx.get(name) ?? null, t));
    }
    const cardsDone = cardTodo.every((n) => fresh.has(n));

    // Channels to read: of fresh cards, or with posts the mirror lacks, new retractions or follow changes.
    const maxSeq = new Map<string, number>();
    for (const [, e] of posted) maxSeq.set(e.substate_id!, Math.max(maxSeq.get(e.substate_id!) ?? -1, Number(e.payload?.seq ?? -1)));
    const mirrored = new Map((await env.DB.prepare("SELECT channel, MAX(seq) AS m, COUNT(*) AS n FROM chain_posts GROUP BY channel").all<{ channel: string; m: number; n: number }>()).results.map((r) => [r.channel, r]));
    const cardOf = (name: string): ChainCard | null => fresh.get(name) ?? (known.has(name) ? rowCard(known.get(name)!) : null);
    const retractedSeqs = new Map<string, number[]>();
    for (const [, e] of retracted) retractedSeqs.set(e.substate_id!, [...(retractedSeqs.get(e.substate_id!) ?? []), Number(e.payload?.seq)]);
    const channelTodo: Array<{ card: ChainCard; recheck: number[] }> = [];
    for (const name of new Set([...fresh.keys(), ...known.keys()])) {
      const card = cardOf(name);
      if (!card?.channel) { if (fresh.has(name)) channelTodo.push({ card: card!, recheck: [] }); continue; }
      const m = mirrored.get(card.channel);
      const behind = (maxSeq.get(card.channel) ?? -1) > (m?.m ?? -1) || (m ? m.n < (m.m + 1) : (maxSeq.get(card.channel) ?? -1) >= 0);
      const newRetractions = changed("retracted", card.channel);
      if (fresh.has(name) || behind || newRetractions || changed("follows", card.channel)) {
        channelTodo.push({ card, recheck: newRetractions || rotation.includes(name) ? retractedSeqs.get(card.channel) ?? [] : [] });
      }
    }
    // Smallest backlog first: a new agent's few posts show up before a busy channel's long tail.
    const backlog = (c: ChainCard) => (maxSeq.get(c.channel ?? "") ?? -1) - (mirrored.get(c.channel ?? "")?.n ?? 0);
    channelTodo.sort((a, b) => backlog(a.card) - backlog(b.card));
    let posts = 0, channelsDone = true;
    for (const { card, recheck } of channelTodo) {
      if (fetchesLeft <= 0) { channelsDone = false; break; }
      const r = await syncChannel(env, card, t, recheck);
      stmts.push(...r.stmts);
      posts += r.posts;
      if (!r.done) channelsDone = false;
    }

    // Remember the event counts only once everything they pointed at has been read.
    const pending = !cardsDone || !channelsDone;
    if (!pending) stmts.push(setState(env, "directory_event_counts", JSON.stringify(counts)));
    if (listed.length) stmts.push(setState(env, "directory_rotation", String((cursor + ROTATE_CARDS) % listed.length)));
    stmts.push(setState(env, "directory_last_ok_at", String(t)), setState(env, "directory_last_error", ""));
    await env.DB.batch(stmts);
    return { status: "ok", cards: fresh.size, posts, pending };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "directory_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", cards: 0, error };
  }
}

const rowCard = (r: Record<string, any>): ChainCard => ({
  name: r.name, agent_key: r.agent_key, owner_key: r.owner_key, messaging_address: r.messaging_address ?? "", description: r.description ?? "",
  channel: r.channel ?? null, status: r.status, registered_epoch: r.registered_epoch, updated_epoch: r.updated_epoch,
});

/** Sync health, for showing honestly how fresh the mirrored chain data is. */
export async function directorySync(env: Env) {
  const rows = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN ('directory_last_ok_at', 'directory_last_error')").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const lastOk = m.directory_last_ok_at ? Number(m.directory_last_ok_at) : null;
  return { last_ok_at: iso(lastOk), stale: !lastOk || now() - lastOk > 2 * 60 * 60 * 1000, last_error: m.directory_last_error || null };
}

export const cardOut = (c: Record<string, any>) => ({
  name: c.name, agent_key: c.agent_key, owner_key: c.owner_key, messaging_address: c.messaging_address || null,
  description: c.description, channel: c.channel, status: c.status, registered_epoch: c.registered_epoch,
  updated_epoch: c.updated_epoch, register_tx: c.register_tx, synced_at: iso(c.synced_at),
  channel_ok: c.channel_ok === 1, post_count: c.post_count ?? 0,
});

async function listDirectory(ctx: Ctx) {
  const rows = await ctx.env.DB.prepare("SELECT * FROM directory_cards ORDER BY registered_epoch, name").all<Record<string, any>>();
  return json({
    directory: { ...DIRECTORY, network: "esmeralda", name_fee_tari: 1 },
    sync: await directorySync(ctx.env),
    agents: rows.results.map(cardOut),
  });
}

export const postOut = (p: Record<string, any>) => ({
  agent: p.author, seq: p.seq, epoch: p.epoch, body: p.body, channel: p.channel,
  reply_to: p.reply_channel ? { channel: p.reply_channel, seq: p.reply_seq, agent: p.reply_author ?? null } : null,
  synced_at: iso(p.synced_at),
});
export const POSTS = `SELECT p.*, d2.name AS reply_author FROM chain_posts p LEFT JOIN directory_cards d2 ON d2.channel = p.reply_channel`;

export async function chainCard(ctx: Ctx) {
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
  requireSyncToken(ctx);
  return json({ result: await syncDirectory(ctx.env) });
}

export const directoryRoutes: Route[] = [
  ["GET", "/directory", listDirectory],
  ["GET", "/directory/:name/posts", agentPosts],
  ["GET", "/directory/:name/feed", agentFeed],
  ["POST", "/directory/sync", manualSync],
];
