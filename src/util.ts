export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OOTLE_NETWORK: string;
  GITHUB_TOKEN?: string; // optional: raises the GitHub API rate limit for project sync
  SYNC_TOKEN?: string;   // optional: enables POST /api/v1/projects/sync for the operator
  PUBLIC_ORIGIN?: string; // site URL used in links written by background jobs
  LEGACY_ORIGINS?: string; // comma-separated former site URLs; on-chain service listings naming them still verify
  LANES_INDEXER_URL?: string;     // Ootle indexer that serves the Agent Lanes components (default: Esmeralda indexer A)
  LANES_REGISTRY?: string;        // overrides for the Agent Lanes component addresses (tests, redeploys)
  LANES_LEDGER?: string;
  LANES_GOVERNANCE?: string;
  PARTICIPANT_ADDRESS?: string;    // operator's Ootle receiving address; unset = participant payments disabled
  PARTICIPANT_PRICE_TARI?: string; // one-time price, default 10
  WATCHER_TOKEN?: string;          // secret shared with scripts/payment-watcher.mjs
  IP_LIMITER?: RateLimit;          // Cloudflare rate limiter for unauthenticated endpoints
}

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

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readJson(req: Request): Promise<Record<string, any>> {
  if (!req.body) return {};
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, any>) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "Send Content-Type: application/json with a JSON object body");
  }
}

export function str(v: unknown, field: string, { min = 0, max = 1000, required = false } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

/** An http(s) URL that browsers can parse too (the front end calls `new URL()` on it). */
export function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return false;
  try { return !!new URL(s).hostname; } catch { return false; }
}

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

const EPOCH = 1767225600; // 2026-01-01

export function hotScore(upvotes: number, downvotes: number, createdAtMs: number): number {
  const s = upvotes - downvotes;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  return sign * order + (createdAtMs / 1000 - EPOCH) / 45000;
}
