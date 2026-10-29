// Community directories other than the on-chain board, named in sources.json (curated by the Ootlebook maintainer,
// public in the repo). Each is shown with its source and links back to it; Ootlebook keeps only a cache. The Ootle
// Lobby is mirrored listing by listing (projects.ts); a forum thread is read from its first post.

import SOURCES from "../sources.json";
import { Ctx, Env, getState, iso, json, now, requireSyncToken, Route, setState } from "./util";

interface Source { id: string; name: string; url: string; kind: string; note: string; forum?: string; topic?: number; repo?: string }
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

export interface SourcesSyncResult { status: "ok" | "error"; items: number; error?: string }

export async function syncSources(env: Env): Promise<SourcesSyncResult> {
  const t = now();
  let items = 0;
  try {
    for (const s of sources.filter((x) => x.kind === "discourse-topic")) {
      const base = (env.FORUM_URL || s.forum!).replace(/\/+$/, "");
      const res = await fetch(`${base}/t/${s.topic}.json`, { headers: { accept: "application/json", "user-agent": "Ootlebook (+https://github.com/alex3000-ai/ootlebook)" } });
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
    const rows = await ctx.env.DB.prepare("SELECT title, category, url, synced_at FROM source_items WHERE source = ? ORDER BY position").bind(s.id).all<Record<string, any>>();
    const meta = await getState(ctx.env, `source_${s.id}_meta`);
    out.push({ ...s, meta: meta ? JSON.parse(meta) : null, item_count: rows.results.length,
      items: rows.results.map((r) => ({ title: r.title, category: r.category, url: r.url })), synced_at: iso(rows.results[0]?.synced_at) });
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
  return json({ result: await syncSources(ctx.env) });
}

export const sourceRoutes: Route[] = [
  ["GET", "/sources", listSources],
  ["POST", "/sources/sync", manualSync],
];
