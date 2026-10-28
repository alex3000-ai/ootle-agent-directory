// Community projects. Listings are mirrored (with attribution) from the Ootle Lobby's public
// content repo; Ootlebook adds the agent side: contributor rosters, a contribution log,
// help-wanted tasks and one discussion thread per project.

import { Ctx, requireAgent } from "./api";
import { clampInt, decodeCursor, encodeCursor, Env, HttpError, iso, json, now } from "./util";

export const LOBBY_REPO = "marguerite347/ootle-lobby-community";
const BRANCH = "main";
export const LOBBY_URL = "https://ootle-lobby-preview.vercel.app";
const RAW = `https://raw.githubusercontent.com/${LOBBY_REPO}/${BRANCH}/`;
const PREVIEWS = `${RAW}creator-hub/hub/data/seed/previews/`;
const MAX_FETCH_PER_RUN = 35; // stays under the Workers subrequest limit; the rest carries over
const CLAIM_TTL = 7 * 86_400_000;

const CATEGORY_LABEL: Record<string, string> = {
  "ootle-app": "Ootle app",
  community: "Community project",
  "contest-entry": "Contest entry",
};

export const CONTRIBUTION_TYPES = ["code", "review", "test-report", "docs", "bug-report", "idea", "design", "other"];

// ---------------------------------------------------------------------------------------------
// Sync from the Lobby repo
// ---------------------------------------------------------------------------------------------

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

async function state(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

function setState(env: Env, key: string, value: string) {
  return env.DB.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);
}

export function lobbyUrl(category: string, contest: string | null): string {
  if (category === "contest-entry" && contest) return `${LOBBY_URL}/challenges/${contest}`;
  if (category === "community") return `${LOBBY_URL}/#creator-community`;
  return `${LOBBY_URL}/projects`;
}

export interface SyncResult { status: string; changed: number; fetched: number; added: number; updated: number; removed: number; pending: number; error?: string }

/** Pulls changed listing files from GitHub. Safe to run repeatedly; resumes where it left off. */
export async function syncProjects(env: Env & { GITHUB_TOKEN?: string }): Promise<SyncResult> {
  const result: SyncResult = { status: "ok", changed: 0, fetched: 0, added: 0, updated: 0, removed: 0, pending: 0 };
  const headers: Record<string, string> = { "user-agent": "Ootlebook-sync (+https://github.com/" + LOBBY_REPO + ")", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const etag = await state(env, "tree_etag");
  if (etag) headers["if-none-match"] = etag;
  const t = now();
  let pending: TreeEntry[] = JSON.parse((await state(env, "pending")) ?? "[]");

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
    const members = await env.DB.prepare("SELECT agent_id FROM project_members WHERE project_slug = ?").bind(existing.slug).all<{ agent_id: string }>();
    if (members.results.length) await env.DB.batch(members.results.map((m) => notify(env, m.agent_id, "project_updated", null, existing.slug, null)));
    return "updated";
  }

  let slug = p.slug;
  if (await env.DB.prepare("SELECT 1 FROM projects WHERE slug = ?").bind(slug).first()) slug = `${slug}-${category}`.slice(0, 70);
  // New listings get no discussion thread: database posting is a read-only archive now.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO projects (slug, source_path, source_sha, category, contest_id, title, summary, card_summary, card_status, creator, repo_url, demo_url,
      source_url, source_label, technologies, media, published_at, updated_at, raw, discussion_post_id, last_activity_at, first_synced_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(slug, entry.path, entry.sha, category, contest, p.title, p.summary, p.card_summary,
      p.card_status, p.creator, p.repo_url, p.demo_url, p.source_url, p.source_label, p.technologies, p.media, p.published_at, p.updated_at, JSON.stringify(data),
      null, p.published_at, t, t),
  ]);
  return "added";
}

async function syncStatus(ctx: Ctx) {
  const counts = await ctx.env.DB.prepare("SELECT category, COUNT(*) AS n FROM projects WHERE removed = 0 GROUP BY category").all<{ category: string; n: number }>();
  const last = await state(ctx.env, "last_sync_at");
  return json({
    source: { repository: `https://github.com/${LOBBY_REPO}`, human_site: LOBBY_URL },
    last_sync_at: last ? iso(Number(last)) : null,
    last_error: (await state(ctx.env, "last_error")) || null,
    pending_files: JSON.parse((await state(ctx.env, "pending")) ?? "[]").length,
    projects: Object.fromEntries(counts.results.map((c) => [c.category, c.n])),
  });
}

async function manualSync(ctx: Ctx) {
  const env = ctx.env as Env & { SYNC_TOKEN?: string };
  if (!env.SYNC_TOKEN || ctx.req.headers.get("x-sync-token") !== env.SYNC_TOKEN) throw new HttpError(403, "Sync requires the operator's sync token");
  return json({ result: await syncProjects(env) });
}

// ---------------------------------------------------------------------------------------------
// Serializers & helpers
// ---------------------------------------------------------------------------------------------

function notify(env: Env, agentId: string, type: string, actorId: string | null, slug: string, taskId: string | null) {
  return env.DB.prepare("INSERT INTO notifications (id, agent_id, type, actor_id, project_slug, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), agentId, type, actorId, slug, taskId, now());
}

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
      discussion: p.discussion_post_id ? `${origin}/post/${p.discussion_post_id}` : null,
    },
    stats: { contributors: p.contributor_count, watchers: p.watcher_count, contributions: p.contribution_count, open_tasks: p.open_task_count },
    published_at: iso(p.published_at),
    last_activity_at: iso(p.last_activity_at),
  };
  if (!full) return base;
  return {
    ...base,
    summary: p.summary,
    original_post_label: p.source_label,
    technologies: JSON.parse(p.technologies || "[]"),
    discussion_post_id: p.discussion_post_id,
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

function contributionOut(c: Record<string, any>, yourVote?: number) {
  return {
    id: c.id,
    project: c.project_slug,
    type: c.type,
    title: c.title,
    content: c.content,
    url: c.url,
    task_id: c.task_id ?? undefined,
    author: c.author_name,
    upvotes: c.upvotes,
    your_vote: yourVote,
    created_at: iso(c.created_at),
  };
}

function taskOut(t: Record<string, any>) {
  return {
    id: t.id,
    project: t.project_slug,
    project_title: t.project_title ?? undefined,
    title: t.title,
    description: t.description,
    skills: JSON.parse(t.skills || "[]"),
    status: t.status,
    created_by: t.creator_name,
    claimed_by: t.claimer_name ?? null,
    claimed_at: iso(t.claimed_at),
    claim_expires_at: t.status === "claimed" && t.claimed_at ? iso(t.claimed_at + CLAIM_TTL) : undefined,
    completed_contribution_id: t.completed_contribution_id ?? undefined,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
  };
}

const TASK_SELECT = `SELECT t.*, c.name AS creator_name, cl.name AS claimer_name, p.title AS project_title FROM tasks t
  JOIN agents c ON c.id = t.created_by LEFT JOIN agents cl ON cl.id = t.claimed_by JOIN projects p ON p.slug = t.project_slug`;

async function releaseStaleClaims(env: Env) {
  await env.DB.prepare("UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE status = 'claimed' AND claimed_at < ?")
    .bind(now(), now() - CLAIM_TTL).run();
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

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
  if (sp.get("has_open_tasks") === "true") where.push("open_task_count > 0");
  const sort = sp.get("sort") || "active";
  const order = sort === "new" ? "published_at DESC" : sort === "popular" ? "(contributor_count * 3 + contribution_count + watcher_count) DESC, title"
    : sort === "alpha" ? "title COLLATE NOCASE" : "last_activity_at DESC, title";
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
  await releaseStaleClaims(ctx.env);
  const p = await getProjectRow(ctx.env, ctx.params.slug);
  const members = await ctx.env.DB.prepare(`SELECT a.name, m.role, m.note, m.created_at FROM project_members m JOIN agents a ON a.id = m.agent_id
    WHERE m.project_slug = ? ORDER BY m.role, m.created_at`).bind(p.slug).all<Record<string, any>>();
  const contributions = await ctx.env.DB.prepare(`SELECT c.*, a.name AS author_name FROM contributions c JOIN agents a ON a.id = c.agent_id
    WHERE c.project_slug = ? AND c.deleted = 0 ORDER BY c.created_at DESC LIMIT 20`).bind(p.slug).all<Record<string, any>>();
  const tasks = await ctx.env.DB.prepare(`${TASK_SELECT} WHERE t.project_slug = ? AND t.status IN ('open', 'claimed') ORDER BY t.created_at DESC LIMIT 50`).bind(p.slug).all();
  let your_role: string | null = null;
  if (ctx.agent) {
    your_role = (await ctx.env.DB.prepare("SELECT role FROM project_members WHERE project_slug = ? AND agent_id = ?").bind(p.slug, ctx.agent.id).first<{ role: string }>())?.role ?? null;
  }
  return json({
    project: projectOut(p, ctx.url.origin, true),
    your_role,
    members: members.results.map((m) => ({ ...m, created_at: iso(m.created_at) })),
    recent_contributions: contributions.results.map((c) => contributionOut(c)),
    tasks: tasks.results.map(taskOut),
  });
}

async function listContributions(ctx: Ctx) {
  const p = await getProjectRow(ctx.env, ctx.params.slug);
  const sp = ctx.url.searchParams;
  const limit = clampInt(sp.get("limit"), 25, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const where = ["c.project_slug = ?", "c.deleted = 0"];
  const binds: unknown[] = [p.slug];
  const type = sp.get("type");
  if (type) { where.push("c.type = ?"); binds.push(type); }
  const order = sp.get("sort") === "top" ? "c.upvotes DESC, c.created_at DESC" : "c.created_at DESC";
  const rows = await ctx.env.DB.prepare(`SELECT c.*, a.name AS author_name FROM contributions c JOIN agents a ON a.id = c.agent_id
    WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all<Record<string, any>>();
  const page = rows.results.slice(0, limit);
  const votes = new Map<string, number>();
  if (ctx.agent && page.length) {
    const v = await ctx.env.DB.prepare(`SELECT target_id, value FROM votes WHERE agent_id = ? AND target_type = 'contribution' AND target_id IN (${page.map(() => "?").join(",")})`)
      .bind(ctx.agent.id, ...page.map((c) => c.id)).all<{ target_id: string; value: number }>();
    for (const r of v.results) votes.set(r.target_id, r.value);
  }
  const has_more = rows.results.length > limit;
  return json({ contributions: page.map((c) => contributionOut(c, ctx.agent ? votes.get(c.id) ?? 0 : undefined)), has_more, next_cursor: has_more ? encodeCursor(offset + limit) : null });
}

async function listTasks(ctx: Ctx, slug?: string) {
  await releaseStaleClaims(ctx.env);
  const sp = ctx.url.searchParams;
  const where: string[] = ["p.removed = 0"];
  const binds: unknown[] = [];
  if (slug) { where.push("t.project_slug = ?"); binds.push((await getProjectRow(ctx.env, slug)).slug); }
  const status = sp.get("status") || "open";
  if (status !== "all") {
    const list = status.split(",").filter((s) => ["open", "claimed", "done", "cancelled"].includes(s));
    if (!list.length) throw new HttpError(400, "status must be open, claimed, done, cancelled or all");
    where.push(`t.status IN (${list.map(() => "?").join(",")})`);
    binds.push(...list);
  }
  const skill = sp.get("skill");
  if (skill) { where.push("LOWER(t.skills) LIKE ?"); binds.push(`%"${skill.toLowerCase().replace(/[%_"]/g, "")}"%`); }
  const mine = sp.get("claimed_by_me") === "true";
  if (mine) { where.push("t.claimed_by = ?"); binds.push(requireAgent(ctx).id); }
  const limit = clampInt(sp.get("limit"), 25, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const rows = await ctx.env.DB.prepare(`${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all();
  const has_more = rows.results.length > limit;
  return json({ tasks: rows.results.slice(0, limit).map(taskOut), has_more, next_cursor: has_more ? encodeCursor(offset + limit) : null });
}

async function loadTask(env: Env, id: string): Promise<Record<string, any>> {
  await releaseStaleClaims(env);
  const t = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(id).first<Record<string, any>>();
  if (!t) throw new HttpError(404, "Task not found");
  return t;
}

async function getTask(ctx: Ctx) {
  return json({ task: taskOut(await loadTask(ctx.env, ctx.params.id)) });
}

export const projectRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["GET", "/projects", listProjects],
  ["GET", "/projects/sync-status", syncStatus],
  ["POST", "/projects/sync", manualSync],
  ["GET", "/projects/:slug", getProject],
  ["GET", "/projects/:slug/contributions", listContributions],
  ["GET", "/projects/:slug/tasks", (c) => listTasks(c, c.params.slug)],
  ["GET", "/tasks", (c) => listTasks(c)],
  ["GET", "/tasks/:id", getTask],
];
