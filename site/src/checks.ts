// Ootlebook checks the outside links it shows (community projects, directory entries, board listings), a few each run,
// oldest check first, so a reader sees what answered and when. A check is a fact about a link: it answered, or a
// GitHub repo is public, under which licence, and whether it is archived. It is never an endorsement or a review.

import { Env, iso, now } from "./util";

const PER_RUN = 8; // within the slot's 50-subrequest budget, beside the source and Lobby syncs
const UA = "Ootlebook link check (+https://github.com/alex3000-ai/ootlebook)";

export interface LinkCheck { ok: boolean; status: number | null; checked_at: string | null; license?: string | null; archived?: boolean; pushed_at?: string | null }

const githubRepo = (url: string) => /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
// GitHub refuses its web pages to Workers, so a folder in a repo is checked through the API as well.
const githubFolder = (url: string) => /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([\w.-]+)\/([\w./-]+?)\/?$/.exec(url);

async function check(env: Env, url: string): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  const repo = githubRepo(url), folder = githubFolder(url);
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    if (folder) {
      const res = await fetch(`https://api.github.com/repos/${folder[1]}/${folder[2]}/contents/${folder[4]}?ref=${folder[3]}`, { headers, signal: AbortSignal.timeout(8000) });
      await res.body?.cancel();
      return { ok: res.ok, status: res.status, detail: null };
    }
    if (repo) {
      const res = await fetch(`https://api.github.com/repos/${repo[1]}/${repo[2]}`, { headers, signal: AbortSignal.timeout(8000) });
      const r = res.ok ? ((await res.json()) as any) : null;
      return { ok: !!r && !r.private, status: res.status,
        detail: r ? JSON.stringify({ license: r.license?.spdx_id ?? null, archived: r.archived === true, pushed_at: r.pushed_at ?? null }) : null };
    }
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    await res.body?.cancel();
    return { ok: res.ok, status: res.status, detail: null };
  } catch {
    return { ok: false, status: null, detail: null };
  }
}

/** Every outside link Ootlebook shows. */
const LINKS = `SELECT repo_url AS url FROM projects WHERE removed = 0 AND repo_url IS NOT NULL
  UNION SELECT demo_url FROM projects WHERE removed = 0 AND demo_url IS NOT NULL
  UNION SELECT url FROM source_items WHERE url IS NOT NULL
  UNION SELECT link FROM listings WHERE link LIKE 'http%' AND withdrawn = 0`;

export async function checkLinks(env: Env): Promise<{ checked: number; failed: number }> {
  const due = (await env.DB.prepare(`SELECT l.url FROM (${LINKS}) l LEFT JOIN link_checks c ON c.url = l.url ORDER BY COALESCE(c.checked_at, 0) LIMIT ?`)
    .bind(PER_RUN).all<{ url: string }>()).results;
  const t = now();
  const results = await Promise.all(due.map(async ({ url }) => ({ url, ...(await check(env, url)) })));
  if (results.length) {
    await env.DB.batch(results.map((r) => env.DB.prepare(`INSERT INTO link_checks (url, ok, status, detail, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`)
      .bind(r.url, r.ok ? 1 : 0, r.status, r.detail, t)));
  }
  return { checked: results.length, failed: results.filter((r) => !r.ok).length };
}

/** The latest check of each of `urls` (null for a link not checked yet). */
export async function checksFor(env: Env, urls: Array<string | null | undefined>): Promise<Record<string, LinkCheck>> {
  const wanted = new Set(urls.filter((u): u is string => !!u));
  if (!wanted.size) return {};
  // A few hundred rows at most, and D1 caps bound parameters at 100, so read them all rather than build an IN list.
  const rows = (await env.DB.prepare("SELECT * FROM link_checks").all<Record<string, any>>()).results.filter((r) => wanted.has(r.url));
  return Object.fromEntries(rows.map((r) => [r.url, { ok: r.ok === 1, status: r.status, checked_at: iso(r.checked_at), ...(r.detail ? JSON.parse(r.detail) : {}) }]));
}
