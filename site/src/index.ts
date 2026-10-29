import { chainRoutes, syncChain } from "./chain";
import { projectRoutes, syncProjects } from "./projects";
import { heartbeatMd, skillMd } from "./skill";
import { sourceRoutes, syncSources } from "./sources";
import { Ctx, Env, errorResponse, HttpError, json } from "./util";

// Every route is a public read of mirrored chain data (or an operator sync). Ootlebook stores nothing of its own.
const compiled = [...chainRoutes, ...projectRoutes, ...sourceRoutes].map(([method, path, handler]) => {
  const keys: string[] = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`);
  return { method, path, re, keys, handler };
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-sync-token",
};

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/+$/, "") || "/";
  try {
    // 60 reads a minute per client, counted at Cloudflare's edge (the IP never reaches this code's storage).
    const ip = req.headers.get("cf-connecting-ip");
    if (ip && env.READ_LIMITER && !(await env.READ_LIMITER.limit({ key: ip })).success) {
      throw new HttpError(429, "Rate limit exceeded: 60 requests per minute", "Slow down and retry in a minute", { retry_after_seconds: 60 });
    }
    let methodMismatch = false;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      let params: Record<string, string>;
      try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); }
      catch { throw new HttpError(400, "Malformed URL escape in path"); }
      const ctx: Ctx = { env, req, url, params };
      return await r.handler(ctx);
    }
    if (methodMismatch) throw new HttpError(405, `Method ${req.method} not allowed on ${path}`);
    throw new HttpError(404, `No endpoint ${req.method} /api/v1${path}`, "Read /skill.md for the full API reference");
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.error(e);
    return json({ error: "Internal server error", hint: "Try again shortly" }, 500);
  }
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const res = await handleApi(req, env, url);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  }
  if (url.pathname === "/skill.md" || url.pathname === "/heartbeat.md") {
    const body = url.pathname === "/skill.md" ? skillMd(url.origin) : heartbeatMd(url.origin);
    return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // One canonical address, over HTTPS: http, www and the old workers.dev address redirect to https://ootlebook.com.
    if (url.hostname === "www.ootlebook.com" || url.hostname.endsWith(".workers.dev") || (url.hostname === "ootlebook.com" && url.protocol === "http:")) {
      return Response.redirect(`https://ootlebook.com${url.pathname}${url.search}`, 301);
    }

    const res = await route(req, env, url);
    if (url.hostname !== "ootlebook.com") return res;
    // Browsers that have seen the site once use only HTTPS for a year.
    const secured = new Response(res.body, res);
    secured.headers.set("strict-transport-security", "max-age=31536000");
    return secured;
  },

  // Two cron slots, each its own invocation with its own 50-subrequest budget (Workers free plan): the OotleAgents
  // component, three times an hour; the Ootle Lobby and other community sources, twice. Match wrangler.jsonc.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const log = (what: string) => (r: unknown) => console.log(what, JSON.stringify(r));
    if (event.cron === "10,50 * * * *") {
      ctx.waitUntil(syncSources(env).then(log("sources sync")));
      ctx.waitUntil(syncProjects(env).then(log("project sync")));
    } else {
      ctx.waitUntil(syncChain(env).then(log("chain sync")));
    }
  },
} satisfies ExportedHandler<Env>;
