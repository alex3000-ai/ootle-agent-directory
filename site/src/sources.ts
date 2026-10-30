// Community directories other than the on-chain board, named in sources.json (curated by the Ootlebook maintainer,
// public in the repo). Each is shown with its source and links back to it; Ootlebook keeps only a cache. The Ootle
// Lobby is mirrored listing by listing (projects.ts); a forum thread is read from its first post; a registry from its
// catalog, with each package's download checked against the hash the catalog publishes.

import SOURCES from "../sources.json";
import { checkLinks, checksFor } from "./checks";
import { Ctx, Env, getState, iso, json, now, requireSyncToken, Route, setState } from "./util";

interface Source { id: string; name: string; url: string; kind: string; note: string; forum?: string; topic?: number; repo?: string; catalog?: string }
const UA = "Ootlebook (+https://github.com/alex3000-ai/ootlebook)";
const VERIFY_PER_RUN = 5; // package downloads per sync; the rest wait for the next one
export const sources = SOURCES.sources as Source[];

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const clean = (u: string) => { try { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (k.startsWith("utm_")) x.searchParams.delete(k); return x.toString(); } catch { return null; } };

/**
 * A Discourse directory thread: the items of the first post's "Quick Navigation" list ("Name — Category"), each with
 * the link it carries. Free-form posts change shape, so anything this can't parse is left out and the thread itself
 * stays linked.
 */
export function parseDirectoryPost(cooked: string, forumHost: string): Array<{ title: string; category: string | null; url: string | null }> {
  const start = cooked.search(/Quick Navigation/i);
  if (start < 0) return [];
  const list = /<(ol|ul)>([\s\S]*?)<\/\1>/.exec(cooked.slice(start));
  if (!list) return [];
  return [...list[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].slice(0, 100).map((m) => {
    const [title, category] = text(m[1]).split(/\s+[—–]\s+/, 2);
    const href = [...m[1].matchAll(/href="(https?:\/\/[^"]+)"/g)].map((h) => h[1]).find((h) => !h.includes(forumHost)) ?? null;
    return { title: title.slice(0, 120), category: category?.slice(0, 120) ?? null, url: href ? clean(href) : null };
  }).filter((i) => i.title);
}

const words = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
const wordList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 200)) : []);

/** SHA-256 of a download, as hex, or null when it can't be read (or is over 5 MB). */
async function sha256Of(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 5e6) { await res.body?.cancel(); return null; }
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await res.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * A registry catalog (TariTracker's format): each package with what its manifest declares, and whether its download
 * matched the catalog's SHA-256 when Ootlebook fetched it. A match is kept until the package's hash changes; anything
 * else is tried again on a later sync.
 */
async function syncRegistry(env: Env, s: Source, t: number): Promise<number> {
  const url = env.REGISTRY_URL ? `${env.REGISTRY_URL.replace(/\/+$/, "")}/catalog.json` : s.catalog!;
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!res.ok) throw new Error(`${s.id}: catalog returned ${res.status}`);
  const catalog = (await res.json()) as any;
  const base = new URL(".", url).toString();
  const before = new Map((await env.DB.prepare("SELECT detail FROM source_items WHERE source = ?").bind(s.id).all<{ detail: string }>()).results
    .map((r) => JSON.parse(r.detail)).map((d) => [d.sha256, d.verified]));
  let budget = VERIFY_PER_RUN;
  const rows = [];
  for (const p of (Array.isArray(catalog?.packages) ? catalog.packages : []).slice(0, 100)) {
    const kind = ["agent", "mcp", "skill"].includes(p?.kind) ? p.kind : null;
    const download = typeof p?.download === "string" ? new URL(p.download, base).toString() : "";
    if (!kind || !/^[a-z0-9-]{1,64}$/.test(p.id) || !/^[0-9a-f]{64}$/.test(p.sha256) || !download.startsWith(base)) continue;
    let verified = before.get(p.sha256)?.matches ? before.get(p.sha256) : null;
    if (!verified && budget-- > 0) {
      const got = await sha256Of(download);
      verified = { matches: got === p.sha256, read: got !== null, checked_at: iso(t) };
    }
    rows.push({
      title: words(p.name, 120) ?? p.id, category: kind, url: `https://github.com/${s.repo}/tree/main/packages/${kind}s/${p.id}`,
      detail: JSON.stringify({
        id: p.id, version: words(p.version, 40), description: words(p.description, 500), license: words(p.license, 60), maintainers: wordList(p.maintainers),
        runtime: words(p.runtime, 60), risk: words(p.risk, 40), status: words(p.status, 40), permissions: wordList(p.permissions),
        networks: wordList(p.networks), network_hosts: wordList(p.network_hosts), security_notes: words(p.security_notes, 500),
        sha256: p.sha256, download, verified,
      }),
    });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM source_items WHERE source = ?").bind(s.id),
    ...rows.map((r, n) => env.DB.prepare("INSERT INTO source_items (source, position, title, category, url, synced_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(s.id, n, r.title, r.category, r.url, t, r.detail)),
    setState(env, `source_${s.id}_meta`, JSON.stringify({ revision: words(catalog?.revision, 64), publisher: words(catalog?.publisher, 120) })),
  ]);
  return rows.length;
}

export interface SourcesSyncResult { status: "ok" | "error"; items: number; error?: string }

export async function syncSources(env: Env): Promise<SourcesSyncResult> {
  const t = now();
  let items = 0;
  try {
    for (const s of sources.filter((x) => x.kind === "discourse-topic")) {
      const base = (env.FORUM_URL || s.forum!).replace(/\/+$/, "");
      const res = await fetch(`${base}/t/${s.topic}.json`, { headers: { accept: "application/json", "user-agent": UA } });
      if (!res.ok) throw new Error(`${s.id}: forum returned ${res.status}`);
      const topic = (await res.json()) as any;
      const parsed = parseDirectoryPost(String(topic?.post_stream?.posts?.[0]?.cooked ?? ""), new URL(s.forum!).host);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM source_items WHERE source = ?").bind(s.id),
        ...parsed.map((i, n) => env.DB.prepare("INSERT INTO source_items (source, position, title, category, url, synced_at) VALUES (?, ?, ?, ?, ?, ?)").bind(s.id, n, i.title, i.category, i.url, t)),
        setState(env, `source_${s.id}_meta`, JSON.stringify({ title: topic?.title ?? null, last_posted_at: topic?.last_posted_at ?? null, replies: topic?.posts_count ?? null })),
      ]);
      items += parsed.length;
    }
    for (const s of sources.filter((x) => x.kind === "agent-registry")) items += await syncRegistry(env, s, t);
    await env.DB.batch([setState(env, "sources_last_ok_at", String(t)), setState(env, "sources_last_error", "")]);
    return { status: "ok", items };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setState(env, "sources_last_error", `${iso(t)}: ${error}`).run();
    return { status: "error", items, error };
  }
}

async function listSources(ctx: Ctx) {
  const out = [];
  for (const s of sources) {
    if (s.kind === "ootle-lobby") {
      const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE removed = 0").first<{ n: number }>();
      out.push({ ...s, items_endpoint: "/api/v1/projects", item_count: n?.n ?? 0 });
      continue;
    }
    const rows = await ctx.env.DB.prepare("SELECT title, category, url, detail, synced_at FROM source_items WHERE source = ? ORDER BY position").bind(s.id).all<Record<string, any>>();
    const meta = await getState(ctx.env, `source_${s.id}_meta`);
    const checks = await checksFor(ctx.env, rows.results.map((r) => r.url));
    out.push({ ...s, meta: meta ? JSON.parse(meta) : null, item_count: rows.results.length,
      items: rows.results.map((r) => ({ title: r.title, category: r.category, url: r.url, ...(r.detail ? JSON.parse(r.detail) : {}), link_check: checks[r.url] ?? null })),
      synced_at: iso(rows.results[0]?.synced_at) });
  }
  const last = await getState(ctx.env, "sources_last_ok_at");
  return json({
    sources: out,
    curated: { by: "the Ootlebook maintainer", list: "https://github.com/alex3000-ai/ootlebook/blob/main/site/sources.json" },
    last_sync_at: last ? iso(Number(last)) : null,
    last_error: (await getState(ctx.env, "sources_last_error")) || null,
  });
}

async function manualSync(ctx: Ctx) {
  requireSyncToken(ctx);
  return json({ result: await syncSources(ctx.env), links: await checkLinks(ctx.env) });
}

export const sourceRoutes: Route[] = [
  ["GET", "/sources", listSources],
  ["POST", "/sources/sync", manualSync],
];
