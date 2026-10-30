import { plainBody } from "./encoded";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string; // optional: raises the GitHub API rate limit for the Ootle Lobby mirror
  SYNC_TOKEN?: string;   // optional: enables the operator's manual sync endpoints
  PUBLIC_ORIGIN?: string; // site URL used in links written by background jobs
  INDEXER_URL?: string;           // Ootle indexer (default: Esmeralda indexer A)
  OOTLEBOOK_COMPONENT?: string;          // override for the Ootlebook component (tests); skips the template check
  FORUM_URL?: string;             // override for the Tari forum's base URL (tests)
  REGISTRY_URL?: string;          // override for registry catalogs' base URL (tests)
  READ_LIMITER?: RateLimit;       // Cloudflare rate limiter: counts at the edge, so no IP ever reaches this code's storage
}

/** One API request. Ootlebook has no accounts: every route is a public read (or an operator sync). */
export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  params: Record<string, string>;
}

export type Route = [string, string, (ctx: Ctx) => Promise<Response>];

export class HttpError extends Error {
  constructor(public status: number, message: string, public hint?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function json(data: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: status < 400, ...data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(e: HttpError): Response {
  const headers: Record<string, string> = {};
  if (e.status === 429 && typeof e.extra.retry_after_seconds === "number") {
    headers["retry-after"] = String(e.extra.retry_after_seconds);
  }
  return json({ error: e.message, ...(e.hint ? { hint: e.hint } : {}), ...e.extra }, e.status, headers);
}

export const now = () => Date.now();
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? def : parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// Offset cursors, opaque to clients.
export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`).replace(/=+$/, "");
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const m = /^o:(\d+)$/.exec(atob(cursor));
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

export const DEFAULT_INDEXER = "https://ootle-indexer-a.tari.com";
/** Workers (free plan) allow 50 subrequests per invocation: each sync reads the indexer at most this many times and
 *  carries the rest over to the next run, instead of failing part-way. */
export const FETCH_BUDGET = 45;
export class BudgetSpent extends Error {}

/** Reads a public Ootle indexer, at most `budget` times; `left` is what remains. A 404 reads as null. */
export function indexerReader(base = DEFAULT_INDEXER, budget = FETCH_BUDGET) {
  const root = base.replace(/\/+$/, "");
  const reader = {
    left: budget,
    async get(path: string): Promise<any | null> {
      if (reader.left-- <= 0) throw new BudgetSpent("indexer read budget for this sync is spent");
      const res = await fetch(`${root}${path}`, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`indexer returned ${res.status} for ${path.slice(0, 40)}`);
      return plainBody(await res.json());
    },
  };
  return reader;
}

/** How fresh a mirror is: stale after two hours without a good sync. */
export const syncHealth = (lastOkMs: number | null, lastError: string | null | undefined) =>
  ({ last_ok_at: iso(lastOkMs), stale: !lastOkMs || now() - lastOkMs > 2 * 60 * 60 * 1000, last_error: lastError || null });

export function setState(env: Env, key: string, value: string) {
  return env.DB.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);
}

export async function getState(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

/** The operator's manual sync endpoints need the sync token. */
export function requireSyncToken(ctx: Ctx) {
  if (!ctx.env.SYNC_TOKEN || ctx.req.headers.get("x-sync-token") !== ctx.env.SYNC_TOKEN) throw new HttpError(403, "Sync requires the operator's sync token");
}

export function tari(microtari: number): string {
  const whole = Math.floor(microtari / 1e6);
  const frac = String(microtari % 1e6).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** CBOR bytes (or a tagged byte string) as the indexer renders it, as hex. */
export const cborHex = (v: any): string | null => (v?.["@cbor"] === "bytes" ? v.hex : v?.["@cbor"] === "tag" ? cborHex(v.value) : null);
