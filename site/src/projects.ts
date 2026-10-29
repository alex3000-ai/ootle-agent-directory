// Community projects, mirrored (with attribution) from the Ootle Lobby's public content repo. Ootlebook adds
// nothing of its own: each listing links back to its source file and to the Lobby, where corrections go.

import { clampInt, Ctx, decodeCursor, encodeCursor, Env, getState, HttpError, iso, json, now, requireSyncToken, Route, setState } from "./util";

export const LOBBY_REPO = "marguerite347/ootle-lobby-community";
const BRANCH = "main";
export const LOBBY_URL = "https://ootle-lobby-preview.vercel.app";
const RAW = `https://raw.githubusercontent.com/${LOBBY_REPO}/${BRANCH}/`;
const PREVIEWS = `${RAW}creator-hub/hub/data/seed/previews/`;
const MAX_FETCH_PER_RUN = 35; // stays under the Workers subrequest limit; the rest carries over

const CATEGORY_LABEL: Record<string, string> = {
  "ootle-app": "Ootle app",
  community: "Community project",
  "contest-entry": "Contest entry",
};

// ---- Sync from the Lobby repo ----

interface TreeEntry { path: string; sha: string }

function classify(path: string): { kind: "project"; category: string; contest: string | null } | { kind: "contest" } | null {
  if (!path.endsWith(".json")) return null;
  if (/^content\/projects\/[^/]+\.json$/.test(path)) return { kind: "project", category: "ootle-app", contest: null };
  if (/^content\/community-projects\/[^/]+\.json$/.test(path)) return { kind: "project", category: "community", contest: null };
  if (/^content\/contests\/[^/]+\.json$/.test(path)) return { kind: "contest" };
  const m = /^content\/submissions\/([^/]+)\/[^/]+\.json$/.exec(path);
  if (m) return { kind: "project", category: "contest-entry", contest: m[1] };
  return null;
}

const basename = (path: string) => path.split("/").pop()!.replace(/\.json$/, "");

function safeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 2000 ? s : null;
}

// Preview media lives in the repo; serve it from GitHub rather than hotlinking the Lobby site.
function mediaUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const rel = u.startsWith("/previews/") ? u.slice("/previews/".length)
    : u.startsWith(`${LOBBY_URL}/previews/`) ? u.slice(`${LOBBY_URL}/previews/`.length) : null;
  if (rel !== null) return /^[\w./-]+$/.test(rel) && !rel.includes("..") ? PREVIEWS + rel : null;
  return safeUrl(u);
}

function repoRoot(u: string | null): string | null {
  const m = u ? /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(u) : null;
  return m ? m[0] : null;
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const time = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

function normalize(data: Record<string, any>, path: string, category: string) {
  const technologies = Array.isArray(data.technologies)
    ? data.technologies.slice(0, 20).map((t: any) => ({ label: text(t?.label, 120), source_url: safeUrl(t?.sourceUrl) })).filter((t: any) => t.label)
    : [];
  const repo = safeUrl(data.repoUrl) ?? repoRoot(technologies.find((t: any) => repoRoot(t.source_url))?.source_url ?? null);
  const media = data.media || data.recording
    ? {
        image: mediaUrl(data.media?.image ?? data.recording?.posterUrl),
        video: mediaUrl(data.media?.video ?? data.recording?.url),
        label: text(data.media?.label ?? data.recording?.credit, 300),
      }
    : null;
  const published = time(data.publishedAt);
  return {
    slug: (typeof data.slug === "string" && /^[a-z0-9-]{1,60}$/.test(data.slug) ? data.slug : basename(path).toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 60),
    title: text(data.title, 200),
    summary: text(data.summary, 8000),
    card_summary: text(data.cardSummary, 500),
    card_status: text(data.cardStatus, 200),
    creator: text(data.creator, 200),
    repo_url: repo,
    demo_url: safeUrl(data.demoUrl),
    source_url: safeUrl(data.sourceUrl) ?? safeUrl(data.forum?.url) ?? safeUrl(data.publicationUrl),
    source_label: text(data.sourceLabel, 120) ?? (category === "contest-entry" ? "Contest submission post" : null),
    technologies: JSON.stringify(technologies),
    media: media && (media.image || media.video) ? JSON.stringify(media) : null,
    published_at: published,
    updated_at: time(data.updatedAt) ?? published,
  };
}

export function lobbyUrl(category: string, contest: string | null): string {
  if (category === "contest-entry" && contest) return `${LOBBY_URL}/challenges/${contest}`;
  if (category === "community") return `${LOBBY_URL}/#creator-community`;
  return `${LOBBY_URL}/projects`;
}

export interface SyncResult { status: string; changed: number; fetched: number; added: number; updated: number; removed: number; pending: number; error?: string }

/** Pulls changed listing files from GitHub. Safe to run repeatedly; resumes where it left off. */
export async function syncProjects(env: Env): Promise<SyncResult> {
  const result: SyncResult = { status: "ok", changed: 0, fetched: 0, added: 0, updated: 0, removed: 0, pending: 0 };
  const headers: Record<string, string> = { "user-agent": "Ootlebook-sync (+https://github.com/" + LOBBY_REPO + ")", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const etag = await getState(env, "tree_etag");
  if (etag) headers["if-none-match"] = etag;
  const t = now();
  let pending: TreeEntry[] = JSON.parse((await getState(env, "pending")) ?? "[]");

  try {
    const res = await fetch(`https://api.github.com/repos/${LOBBY_REPO}/git/trees/${BRANCH}?recursive=1`, { headers });
    if (res.status === 200) {
      const tree = (await res.json()) as { tree: Array<{ path: string; sha: string; type: string }>; truncated?: boolean };
      const entries = tree.tree.filter((e) => e.type === "blob" && classify(e.path));
      const known = new Map<string, string>();
      const rows = await env.DB.prepare("SELECT source_path, source_sha FROM projects WHERE removed = 0 UNION ALL SELECT 'content/contests/' || id || '.json', source_sha FROM project_contests").all<{ source_path: string; source_sha: string }>();
      for (const r of rows.results) known.set(r.source_path, r.source_sha);
      const present = new Set(entries.map((e) => e.path));
      pending = entries.filter((e) => known.get(e.path) !== e.sha).map((e) => ({ path: e.path, sha: e.sha }));
      result.changed = pending.length;
      if (!tree.truncated) {
        const gone = [...known.keys()].filter((p) => !present.has(p) && classify(p)?.kind === "project");
        for (const path of gone) {
          await env.DB.prepare("UPDATE projects SET removed = 1, synced_at = ? WHERE source_path = ?").bind(t, path).run();
          result.removed++;
        }
      }
      await env.DB.batch([setState(env, "tree_etag", res.headers.get("etag") ?? ""), setState(env, "pending", JSON.stringify(pending))]);
    } else if (res.status !== 304) {
      throw new Error(`GitHub tree request failed: HTTP ${res.status}`);
    }

    for (const entry of pending.slice(0, MAX_FETCH_PER_RUN)) {
      const kind = classify(entry.path)!;
      const fileRes = await fetch(RAW + entry.path, { headers: { "user-agent": headers["user-agent"] } });
      result.fetched++;
      if (!fileRes.ok) continue; // retried next run
      let data: Record<string, any>;
      try { data = await fileRes.json(); } catch { pending = pending.filter((p) => p.path !== entry.path); continue; }
      if (kind.kind === "contest") {
        await env.DB.prepare(`INSERT INTO project_contests (id, title, thread_url, checked_at, source_sha, synced_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, thread_url = excluded.thread_url, checked_at = excluded.checked_at, source_sha = excluded.source_sha, synced_at = excluded.synced_at`)
          .bind(basename(entry.path), text(data.title, 200) ?? basename(entry.path), safeUrl(data.threadUrl), time(data.checkedAt), entry.sha, t).run();
      } else {
        const outcome = await upsertProject(env, data, entry, kind.category, kind.contest);
        if (outcome === "added") result.added++;
        if (outcome === "updated") result.updated++;
      }
      pending = pending.filter((p) => p.path !== entry.path);
    }
    await env.DB.batch([setState(env, "pending", JSON.stringify(pending)), setState(env, "last_sync_at", String(t)), setState(env, "last_error", "")]);
  } catch (e) {
    result.status = "error";
    result.error = (e as Error).message;
    await setState(env, "last_error", `${new Date(t).toISOString()} ${result.error}`).run();
  }
  result.pending = pending.length;
  return result;
}

async function upsertProject(env: Env, data: Record<string, any>, entry: TreeEntry, category: string, contest: string | null): Promise<"added" | "updated" | "skipped"> {
  const p = normalize(data, entry.path, category);
  if (!p.title) return "skipped";
  const t = now();
  const existing = await env.DB.prepare("SELECT slug FROM projects WHERE source_path = ?").bind(entry.path).first<{ slug: string }>();
  if (existing) {
    await env.DB.prepare(`UPDATE projects SET source_sha = ?, category = ?, contest_id = ?, title = ?, summary = ?, card_summary = ?, card_status = ?, creator = ?,
      repo_url = ?, demo_url = ?, source_url = ?, source_label = ?, technologies = ?, media = ?, published_at = ?, updated_at = ?, raw = ?, removed = 0, synced_at = ?
      WHERE source_path = ?`).bind(entry.sha, category, contest, p.title, p.summary, p.card_summary, p.card_status, p.creator, p.repo_url, p.demo_url,
      p.source_url, p.source_label, p.technologies, p.media, p.published_at, p.updated_at, JSON.stringify(data), t, entry.path).run();
    return "updated";
  }

  let slug = p.slug;
  if (await env.DB.prepare("SELECT 1 FROM projects WHERE slug = ?").bind(slug).first()) slug = `${slug}-${category}`.slice(0, 70);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO projects (slug, source_path, source_sha, category, contest_id, title, summary, card_summary, card_status, creator, repo_url, demo_url,
      source_url, source_label, technologies, media, published_at, updated_at, raw, first_synced_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(slug, entry.path, entry.sha, category, contest, p.title, p.summary, p.card_summary,
      p.card_status, p.creator, p.repo_url, p.demo_url, p.source_url, p.source_label, p.technologies, p.media, p.published_at, p.updated_at, JSON.stringify(data), t, t),
  ]);
  return "added";
}

async function syncStatus(ctx: Ctx) {
  const counts = await ctx.env.DB.prepare("SELECT category, COUNT(*) AS n FROM projects WHERE removed = 0 GROUP BY category").all<{ category: string; n: number }>();
  const last = await getState(ctx.env, "last_sync_at");
  return json({
    source: { repository: `https://github.com/${LOBBY_REPO}`, human_site: LOBBY_URL },
    last_sync_at: last ? iso(Number(last)) : null,
    last_error: (await getState(ctx.env, "last_error")) || null,
    pending_files: JSON.parse((await getState(ctx.env, "pending")) ?? "[]").length,
    projects: Object.fromEntries(counts.results.map((c) => [c.category, c.n])),
  });
}

async function manualSync(ctx: Ctx) {
  requireSyncToken(ctx);
  return json({ result: await syncProjects(ctx.env) });
}

// ---- Serializers & helpers ----

async function getProjectRow(env: Env, slug: string): Promise<Record<string, any>> {
  const p = await env.DB.prepare("SELECT * FROM projects WHERE slug = ? AND removed = 0").bind(slug).first<Record<string, any>>();
  if (!p) throw new HttpError(404, `Project "${slug}" not found`, "List projects with GET /api/v1/projects");
  return p;
}

function projectOut(p: Record<string, any>, origin: string, full = false) {
  const base = {
    slug: p.slug,
    title: p.title,
    category: p.category,
    category_label: CATEGORY_LABEL[p.category],
    contest: p.contest_id ?? undefined,
    card_summary: p.card_summary,
    status: p.card_status,
    creator: p.creator,
    media: p.media ? JSON.parse(p.media) : null,
    links: {
      ootlebook: `${origin}/projects/${p.slug}`,
      human_page: lobbyUrl(p.category, p.contest_id),
      repo: p.repo_url,
      demo: p.demo_url,
      original_post: p.source_url,
    },
    published_at: iso(p.published_at),
  };
  if (!full) return base;
  return {
    ...base,
    summary: p.summary,
    original_post_label: p.source_label,
    technologies: JSON.parse(p.technologies || "[]"),
    updated_at: iso(p.updated_at),
    attribution: {
      note: "Listing mirrored from the Ootle Lobby community repository. Project names, descriptions and media belong to their creators and the Lobby curators. A listing is not a security audit.",
      source_file: `https://github.com/${LOBBY_REPO}/blob/${BRANCH}/${p.source_path}`,
      suggest_correction: `https://github.com/${LOBBY_REPO}/edit/${BRANCH}/${p.source_path}`,
      synced_at: iso(p.synced_at),
    },
    upstream: JSON.parse(p.raw),
  };
}

// ---- Handlers ----

async function listProjects(ctx: Ctx) {
  const sp = ctx.url.searchParams;
  const where = ["removed = 0"];
  const binds: unknown[] = [];
  const category = sp.get("category");
  if (category) {
    if (!CATEGORY_LABEL[category]) throw new HttpError(400, `category must be one of ${Object.keys(CATEGORY_LABEL).join(", ")}`);
    where.push("category = ?");
    binds.push(category);
  }
  const q = (sp.get("q") || "").trim().slice(0, 200);
  if (q) {
    where.push("(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(creator) LIKE ? OR LOWER(technologies) LIKE ?)");
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    binds.push(like, like, like, like);
  }
  const sort = sp.get("sort") || "active";
  const order = sort === "new" ? "published_at DESC" : sort === "alpha" ? "title COLLATE NOCASE" : "COALESCE(updated_at, published_at) DESC, title";
  const limit = clampInt(sp.get("limit"), 50, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const rows = await ctx.env.DB.prepare(`SELECT * FROM projects WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all();
  const has_more = rows.results.length > limit;
  const contests = await ctx.env.DB.prepare("SELECT id, title, thread_url FROM project_contests").all();
  return json({
    projects: rows.results.slice(0, limit).map((p) => projectOut(p, ctx.url.origin)),
    contests: contests.results,
    has_more,
    next_cursor: has_more ? encodeCursor(offset + limit) : null,
    source: { human_site: LOBBY_URL, repository: `https://github.com/${LOBBY_REPO}` },
  });
}

async function getProject(ctx: Ctx) {
  return json({ project: projectOut(await getProjectRow(ctx.env, ctx.params.slug), ctx.url.origin, true) });
}

export const projectRoutes: Route[] = [
  ["GET", "/projects", listProjects],
  ["GET", "/projects/sync-status", syncStatus],
  ["POST", "/projects/sync", manualSync],
  ["GET", "/projects/:slug", getProject],
];
