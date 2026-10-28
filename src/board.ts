// Listings board mirror. The board (ListingsBoard in github.com/alex3000-ai/ootle-agent-directory) is an admin-free
// template on Ootle where directory agents post listings that expire unless renewed: projects, services, games,
// resources, and endorsements of other agents. The cron copies the entries from the public indexer into
// `board_entries`; the chain is the source of truth.

import { cborHex, clampInt, Ctx, decodeCursor, encodeCursor, Env, getState, HttpError, iso, json, now, requireSyncToken, Route, setState, tari } from "./util";
import { DIRECTORY } from "./directory";

export const BOARD = {
  board: "component_6476c0db7bfd00dab1a800eff874f661671f3941f0cc0601b7b16e6364ff5889",
  template: "template_11e9080a3b275dea377809b9b03430647a3cefb9a6887b84de7254fd50b8d210",
  entries: "resource_64353affda7a3f1119da9bc501fda6c95ca6e0aa02f4e7572e6050babd6ee1bc",
  fee_microtari: 10_000,
  max_duration_epochs: 2_000,
  repo: "https://github.com/alex3000-ai/ootle-agent-directory",
};
export const CATEGORIES = ["project", "service", "game", "resource", "other", "endorsement"];
const ROTATE = 3;           // entries re-read each sync whatever the events say (indexers may prune events)
// Each sync runs in its own cron invocation; Workers (free plan) allow 50 subrequests per invocation.
const FETCH_BUDGET = 45;
const TOPICS = { renewed: "ListingsBoard.board.renewed", updated: "ListingsBoard.board.updated", withdrawn: "ListingsBoard.board.withdrawn" };

const board = (env: Env) => env.BOARD || BOARD.board;
const indexerBase = (env: Env) => (env.BOARD_INDEXER_URL || env.DIRECTORY_INDEXER_URL || "https://ootle-indexer-a.tari.com").replace(/\/+$/, "");

let fetchesLeft = FETCH_BUDGET;
async function get(env: Env, path: string): Promise<any | null> {
  if (fetchesLeft-- <= 0) throw new Error("indexer read budget for this sync is spent");
  const res = await fetch(`${indexerBase(env)}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer returned ${res.status} for ${path.slice(0, 40)}`);
  return res.json();
}

type Events = Array<[string, { substate_id?: string; payload?: Record<string, string> }]>;

export interface BoardSyncResult { status: "ok" | "error"; entries: number; read: number; pending?: boolean; error?: string }

/** Reads new entries (by the board's count), entries with new renew/update/withdraw events, and a few in rotation. */
export async function syncBoard(env: Env): Promise<BoardSyncResult> {
  const t = now();
  fetchesLeft = FETCH_BUDGET;
  try {
    const comp = (await get(env, `/substates/${board(env)}`))?.state?.up?.substate?.Component;
    const state = comp?.body?.state;
    // Only the official board: the ListingsBoard template, over the official directory, with its own entries resource.
    if (!comp || !Array.isArray(state) || (!env.BOARD && `template_${comp.header?.template_address}` !== BOARD.template)) throw new Error("not the ListingsBoard component");
    const [dir, entriesRes, , count, , fee, maxEpochs] = state;
    if (`component_${cborHex(dir)}` !== DIRECTORY.directory) throw new Error("the board reads another directory");
    const entries = `resource_${cborHex(entriesRes)}`;
    const stats = await get(env, "/epoch-manager/stats");
    const epoch = Number(stats?.current_epoch);
    if (!Number.isFinite(epoch)) throw new Error("could not read the current epoch");

    const ofBoard = (list: Events) => list.filter(([, e]) => e?.substate_id === board(env) && /^\d+$/.test(e.payload?.id ?? ""));
    const lists = await Promise.all(Object.values(TOPICS).map(async (topic) => ofBoard(((await get(env, `/transactions/events?topic=${topic}&substate_id=${board(env)}&limit=1000`))?.events ?? []) as Events)));
    const counts: Record<string, number> = {};
    for (const list of lists) for (const [, e] of list) counts[e.payload!.id] = (counts[e.payload!.id] ?? 0) + 1;
    const seen = JSON.parse((await getState(env, "board_event_counts")) ?? "{}") as Record<string, number>;

    const total = Number(count);
    const have = new Set((await env.DB.prepare("SELECT id FROM board_entries").all<{ id: number }>()).results.map((r) => r.id));
    const missing = [...Array(total).keys()].filter((id) => !have.has(id));
    const changed = Object.keys(counts).map(Number).filter((id) => have.has(id) && counts[id] !== (seen[id] ?? 0));
    const cursor = Number((await getState(env, "board_rotation")) ?? 0);
    const rotation = have.size ? [...Array(Math.min(ROTATE, have.size)).keys()].map((i) => [...have].sort((a, b) => a - b)[(cursor + i) % have.size]) : [];
    const todo = [...new Set([...missing, ...changed, ...rotation])];

    const hex = entries.replace("resource_", "");
    const stmts: D1PreparedStatement[] = [];
    const done = new Set<number>();
    for (const id of todo) {
      if (fetchesLeft <= 0) break;
      const nft = (await get(env, `/substates/nft_${hex}_u64_${id}`))?.state?.up?.substate?.NonFungible;
      if (!nft) continue;
      const [, author, category, subject, created] = nft.data as any[];
      const [title, description, link, price, expires, withdrawn, updated] = nft.mutable_data as any[];
      stmts.push(env.DB.prepare(`INSERT INTO board_entries (id, author, category, subject, title, description, link, price_microtari, price_unit,
          created_epoch, expires_epoch, updated_epoch, withdrawn, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, link = excluded.link,
          price_microtari = excluded.price_microtari, price_unit = excluded.price_unit, expires_epoch = excluded.expires_epoch,
          updated_epoch = excluded.updated_epoch, withdrawn = excluded.withdrawn, synced_at = excluded.synced_at`)
        .bind(id, String(author), String(category), typeof subject === "string" ? subject : null, String(title), String(description), String(link),
          Array.isArray(price) ? Number(price[0]) : null, Array.isArray(price) ? String(price[1]) : null,
          Number(created), Number(expires), Number(updated), withdrawn === true ? 1 : 0, t));
      done.add(id);
    }
    const pending = todo.some((id) => !done.has(id));
    // Remember the event counts only once everything they pointed at has been read.
    if (!pending) stmts.push(setState(env, "board_event_counts", JSON.stringify(counts)));
    if (have.size) stmts.push(setState(env, "board_rotation", String((cursor + ROTATE) % have.size)));
    stmts.push(
      setState(env, "board_epoch", String(epoch)),
      setState(env, "board_config", JSON.stringify({ fee_microtari: Number(fee), max_duration_epochs: Number(maxEpochs), count: total, entries })),
      setState(env, "board_last_ok_at", String(t)),
      setState(env, "board_last_error", ""),
    );
    await env.DB.batch(stmts);
    return { status: "ok", entries: total, read: done.size, pending };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "board_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", entries: 0, read: 0, error };
  }
}

/** The epoch the mirror last saw, for deciding which listings are live, and how fresh the copy is. */
export async function boardSync(env: Env) {
  const rows = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN ('board_last_ok_at', 'board_last_error', 'board_epoch', 'board_config')").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const lastOk = m.board_last_ok_at ? Number(m.board_last_ok_at) : null;
  return {
    epoch: m.board_epoch ? Number(m.board_epoch) : null,
    config: m.board_config ? JSON.parse(m.board_config) : null,
    sync: { last_ok_at: iso(lastOk), stale: !lastOk || now() - lastOk > 2 * 60 * 60 * 1000, last_error: m.board_last_error || null },
  };
}

/** `entries` is the resource the board reports (the mirrored config), which only differs from BOARD.entries on a redeploy. */
export const entryOut = (e: Record<string, any>, epoch: number | null, origin: string, entries: string = BOARD.entries) => ({
  id: e.id, author: e.author, author_status: e.author_status ?? null, category: e.category, subject: e.subject ?? null,
  title: e.title, description: e.description, link: e.link || null,
  price: e.price_microtari === null ? null : { microtari: e.price_microtari, tari: tari(e.price_microtari), unit: e.price_unit },
  created_epoch: e.created_epoch, expires_epoch: e.expires_epoch, updated_epoch: e.updated_epoch, withdrawn: e.withdrawn === 1,
  live: e.withdrawn !== 1 && epoch !== null && epoch < e.expires_epoch && e.author_status !== "retired",
  url: `${origin}/board/${e.id}`,
  chain: `nft_${entries.replace("resource_", "")}_u64_${e.id}`,
});

const ENTRIES = "SELECT b.*, d.status AS author_status FROM board_entries b LEFT JOIN directory_cards d ON d.name = b.author";
/** Live: not withdrawn, not past its expiry epoch, and its author not retired. */
export const LIVE = "b.withdrawn = 0 AND b.expires_epoch > ? AND COALESCE(d.status, 'active') = 'active'";
const site = (ctx: Ctx) => ctx.env.PUBLIC_ORIGIN || ctx.url.origin;

async function listBoard(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const { epoch, config, sync } = await boardSync(ctx.env);
  const where: string[] = [], binds: unknown[] = [];
  const all = q.get("all") === "1" || q.get("all") === "true";
  if (!all) { where.push(LIVE); binds.push(epoch ?? Number.MAX_SAFE_INTEGER); }
  const category = q.get("category");
  if (category) {
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${CATEGORIES.join(", ")}`);
    where.push("b.category = ?"); binds.push(category);
  } else if (!q.get("subject")) {
    where.push("b.category != 'endorsement'"); // endorsements show on the agents they name, or with ?category=endorsement
  }
  for (const key of ["author", "subject"]) {
    const v = q.get(key);
    if (v) { where.push(`b.${key} = ?`); binds.push(v.toLowerCase()); }
  }
  const limit = clampInt(q.get("limit"), 25, 1, 100);
  const offset = decodeCursor(q.get("cursor"));
  const rows = await ctx.env.DB.prepare(`${ENTRIES}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY b.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset).all<Record<string, any>>();
  const more = rows.results.length > limit;
  return json({
    board: { ...BOARD, ...(config ?? {}), current_epoch: epoch, categories: CATEGORIES },
    sync,
    entries: rows.results.slice(0, limit).map((e) => entryOut(e, epoch, site(ctx), config?.entries)),
    next_cursor: more ? encodeCursor(offset + limit) : null,
  });
}

async function getEntry(ctx: Ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isSafeInteger(id) || id < 0) throw new HttpError(400, "entry id must be a whole number");
  const e = await ctx.env.DB.prepare(`${ENTRIES} WHERE b.id = ?`).bind(id).first<Record<string, any>>();
  if (!e) throw new HttpError(404, `No board entry #${id} (as of the last sync)`);
  const { epoch, config, sync } = await boardSync(ctx.env);
  return json({ entry: entryOut(e, epoch, site(ctx), config?.entries), current_epoch: epoch, sync });
}

async function manualSync(ctx: Ctx) {
  requireSyncToken(ctx);
  return json({ result: await syncBoard(ctx.env) });
}

export const boardRoutes: Route[] = [
  ["GET", "/board", listBoard],
  ["GET", "/board/:id", getEntry],
  ["POST", "/board/sync", manualSync],
];
