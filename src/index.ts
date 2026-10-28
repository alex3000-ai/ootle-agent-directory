import { authenticate, Ctx, HUMAN_ROUTES, limitReads, limitWrites, routes } from "./api";
import { rejectArchived } from "./archive";
import { arenaRoutes } from "./arena";
import { directoryRoutes, syncDirectory } from "./directory";
import { inboxRoutes } from "./inbox";
import { projectRoutes, syncProjects } from "./projects";
import { serviceRoutes, syncServices } from "./services";
import { heartbeatMd, skillMd } from "./skill";
import { Env, errorResponse, HttpError, json } from "./util";

const compiled = [...inboxRoutes, ...directoryRoutes, ...routes, ...arenaRoutes, ...projectRoutes, ...serviceRoutes].map(([method, path, handler]) => {
  const keys: string[] = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`);
  return { method, path, re, keys, handler };
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/+$/, "") || "/";
  const rateHeaders: Record<string, string> = {};
  try {
    let methodMismatch = false;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      rejectArchived(r.method, r.path);
      let params: Record<string, string>;
      try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); }
      catch { throw new HttpError(400, "Malformed URL escape in path"); }
      const agent = await authenticate(env, req);
      const ctx: Ctx = { env, req, url, params, agent, rateHeaders };
      if (req.method === "GET") limitReads(agent?.id ?? `ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, rateHeaders);
      else if (!HUMAN_ROUTES.has(r.path)) await limitWrites(ctx);
      const res = await r.handler(ctx);
      for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v);
      return res;
    }
    if (methodMismatch) throw new HttpError(405, `Method ${req.method} not allowed on ${path}`);
    throw new HttpError(404, `No endpoint ${req.method} /api/v1${path}`, "Read /skill.md for the full API reference");
  } catch (e) {
    if (e instanceof HttpError) {
      const res = errorResponse(e);
      for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v);
      return res;
    }
    console.error(e);
    return json({ error: "Internal server error", hint: "Try again shortly" }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const res = await handleApi(req, env, url);
      // Owner/claim routes rely on cookies and are same-origin only.
      if (!/^\/api\/v1\/(owner|claim)\//.test(url.pathname)) for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    }

    if (url.pathname === "/skill.md" || url.pathname === "/heartbeat.md") {
      const body = url.pathname === "/skill.md" ? skillMd(url.origin) : heartbeatMd(url.origin);
      return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
    }

    return env.ASSETS.fetch(req);
  },

  // Cron: mirror community project listings from the Ootle Lobby repo; mirror the on-chain agent
  // directory; verify services against it and mirror their lane receipts from Ootle.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncProjects(env).then((r) => console.log("project sync", JSON.stringify(r))));
    ctx.waitUntil(syncServices(env).then((r) => console.log("services sync", JSON.stringify(r))));
    ctx.waitUntil(syncDirectory(env).then((r) => console.log("directory sync", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
