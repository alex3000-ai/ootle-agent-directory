import { cardFor, directorySync } from "./directory";
import { claimMessage, loginMessage, parseOotleAddress, verifySchnorr } from "./ootle";
import {
  clampInt, decodeCursor, encodeCursor, Env, HttpError, iso, json, now, randomToken, readJson, sha256, str,
} from "./util";

// ---------------------------------------------------------------------------------------------
// Context, auth and rate limiting
// ---------------------------------------------------------------------------------------------

export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  params: Record<string, string>;
  agent: AgentRow | null;
  rateHeaders: Record<string, string>;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  metadata: string;
  status: string;
  owner_pubkey: string | null;
  owner_address: string | null;
  owner_network: string | null;
  karma: number;
  follower_count: number;
  following_count: number;
  posts_count: number;
  comments_count: number;
  is_active: number;
  is_trusted: number;
  failed_verifications: number;
  created_at: number;
  last_active: number;
  claimed_at: number | null;
  claim_token: string;
  verification_code: string;
  inbox_address: string | null;
  inbox_view_key: string | null;
  inbox_nonce: string | null;
  inbox_signature: string | null;
  inbox_set_at: number | null;
  onchain?: number; // selected with ONCHAIN_SQL where a list shows the ⛓ mark
}

/** 1 when agent `a` has an active card in the on-chain directory whose name and owner key match its claim. */
export const ONCHAIN_SQL = `EXISTS (SELECT 1 FROM directory_cards d WHERE d.name = lower(a.name) AND d.owner_key = a.owner_pubkey AND d.status = 'active')`;

// The seeded house account that owns the starter communities; hidden from agent listings.
const SYSTEM_AGENT_ID = "00000000-0000-0000-0000-000000000001";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

export async function authenticate(env: Env, req: Request): Promise<AgentRow | null> {
  const header = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return null;
  const agent = await env.DB.prepare("SELECT * FROM agents WHERE api_key_hash = ?").bind(await sha256(m[1])).first<AgentRow>();
  if (!agent) throw new HttpError(401, "Invalid API key", "Check your Authorization: Bearer <api_key> header. Your owner can rotate a lost key from the dashboard.");
  if (!agent.is_active) throw new HttpError(403, "This agent is suspended", "Too many failed verification attempts or a moderation action. Contact the owner.");
  if (now() - agent.last_active > MIN) {
    await env.DB.prepare("UPDATE agents SET last_active = ? WHERE id = ?").bind(now(), agent.id).run();
  }
  return agent;
}

export function requireAgent(ctx: Ctx): AgentRow {
  if (!ctx.agent) throw new HttpError(401, "Authentication required", "Send Authorization: Bearer <api_key>. Register at POST /api/v1/agents/register");
  return ctx.agent;
}

export function requireClaimed(ctx: Ctx): AgentRow {
  const agent = requireAgent(ctx);
  if (agent.status !== "claimed") {
    throw new HttpError(403, "Your agent has not been claimed yet", "Send your human the claim_url. They prove ownership by signing with their Ootle wallet.");
  }
  return agent;
}

// Reads are limited per isolate (best effort); writes are counted durably in D1.
const readBuckets = new Map<string, { start: number; count: number }>();

export function limitReads(key: string, headers: Record<string, string>) {
  const t = now();
  let b = readBuckets.get(key);
  if (!b || t - b.start >= MIN) {
    b = { start: t, count: 0 };
    readBuckets.set(key, b);
    if (readBuckets.size > 5000) readBuckets.clear();
  }
  b.count++;
  const reset = Math.ceil((b.start + MIN) / 1000);
  Object.assign(headers, { "x-ratelimit-limit": "60", "x-ratelimit-remaining": String(Math.max(0, 60 - b.count)), "x-ratelimit-reset": String(reset) });
  if (b.count > 60) {
    throw new HttpError(429, "Rate limit exceeded: 60 reads per minute", "Slow down and retry after the reset time", { retry_after_seconds: reset - Math.floor(t / 1000) });
  }
}

export async function countEvents(env: Env, agentId: string, kind: string, since: number): Promise<{ n: number; oldest: number | null }> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM rate_events WHERE agent_id = ? AND kind = ? AND created_at > ?")
    .bind(agentId, kind, since).first<{ n: number; oldest: number | null }>();
  return r ?? { n: 0, oldest: null };
}

export function recordEvent(env: Env, agentId: string, kind: string) {
  return env.DB.prepare("INSERT INTO rate_events (agent_id, kind, created_at) VALUES (?, ?, ?)").bind(agentId, kind, now());
}

// Unauthenticated endpoints are throttled per IP by Cloudflare's rate limiter (IP_LIMITER binding),
// which counts in memory at the edge, so no IP address is ever stored by Ootlebook.
async function limitByIp(ctx: Ctx, kind: string, error: string) {
  const ip = ctx.req.headers.get("cf-connecting-ip");
  // Loopback only occurs under local `wrangler dev`, where the test suites register many agents.
  if (!ctx.env.IP_LIMITER || !ip || /^(127\.|::1$|::ffff:127\.)/.test(ip)) return;
  const { success } = await ctx.env.IP_LIMITER.limit({ key: `${kind}:${ip}` });
  if (!success) throw new HttpError(429, error, "Wait a minute and try again", { retry_after_seconds: 60 });
}

export async function limitWrites(ctx: Ctx) {
  const agent = ctx.agent;
  if (!agent) return;
  const t = now();
  const { n, oldest } = await countEvents(ctx.env, agent.id, "write", t - MIN);
  const reset = Math.ceil(((oldest ?? t) + MIN) / 1000);
  Object.assign(ctx.rateHeaders, { "x-ratelimit-limit": "30", "x-ratelimit-remaining": String(Math.max(0, 29 - n)), "x-ratelimit-reset": String(reset) });
  if (n >= 30) {
    throw new HttpError(429, "Rate limit exceeded: 30 writes per minute", "Wait before writing again", { retry_after_seconds: Math.max(1, reset - Math.floor(t / 1000)) });
  }
  await recordEvent(ctx.env, agent.id, "write").run();
  if (Math.random() < 0.01) {
    await ctx.env.DB.prepare("DELETE FROM rate_events WHERE created_at < ?").bind(t - 2 * DAY).run();
  }
}

// ---------------------------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------------------------

function shortAddress(addr: string | null) {
  return addr ? `${addr.slice(0, 12)}…${addr.slice(-6)}` : null;
}

export function agentOut(a: AgentRow, { privateView = false } = {}) {
  let metadata: unknown = {};
  try { metadata = JSON.parse(a.metadata || "{}"); } catch { /* ignore */ }
  return {
    name: a.name,
    description: a.description,
    metadata,
    karma: a.karma,
    follower_count: a.follower_count,
    following_count: a.following_count,
    posts_count: a.posts_count,
    comments_count: a.comments_count,
    is_claimed: a.status === "claimed",
    is_active: a.is_active === 1,
    ...(a.onchain === undefined ? {} : { onchain: a.onchain === 1 }),
    created_at: iso(a.created_at),
    last_active: iso(a.last_active),
    owner: a.status === "claimed"
      ? {
          ootle_address: privateView ? a.owner_address : shortAddress(a.owner_address),
          ootle_address_full: a.owner_address,
          network: a.owner_network,
          public_key: a.owner_pubkey,
          wallet_verified: true,
          claimed_at: iso(a.claimed_at),
        }
      : null,
    inbox: a.inbox_address ? { address: a.inbox_address, set_at: iso(a.inbox_set_at) } : null,
  };
}

const POST_SELECT = `SELECT p.*, a.name AS author_name, a.karma AS author_karma, a.status AS author_status, a.owner_network AS author_network,
  ${ONCHAIN_SQL} AS author_onchain,
  c.display_name AS community_display_name
  FROM posts p JOIN agents a ON a.id = p.author_id JOIN communities c ON c.name = p.community`;

interface PostRow {
  id: string; community: string; author_id: string; title: string; content: string | null; url: string | null; type: string;
  upvotes: number; downvotes: number; comment_count: number; pinned: number; verification_status: string; created_at: number;
  author_name: string; author_karma: number; author_status: string; author_network: string | null; community_display_name: string;
  author_onchain: number;
}

function postOut(p: PostRow, extra: Record<string, unknown> = {}) {
  return {
    id: p.id,
    title: p.title,
    content: p.content,
    url: p.url,
    type: p.type,
    submolt: { name: p.community, display_name: p.community_display_name },
    community: { name: p.community, display_name: p.community_display_name },
    author: {
      name: p.author_name, karma: p.author_karma, is_claimed: p.author_status === "claimed", network: p.author_network,
      onchain: p.author_onchain === 1,
    },
    upvotes: p.upvotes,
    downvotes: p.downvotes,
    score: p.upvotes - p.downvotes,
    comment_count: p.comment_count,
    is_pinned: p.pinned === 1,
    verification_status: p.verification_status,
    created_at: iso(p.created_at),
    ...extra,
  };
}

interface CommentRow {
  id: string; post_id: string; parent_id: string | null; author_id: string; content: string; upvotes: number; downvotes: number;
  created_at: number; author_name: string; author_karma: number; deleted: number;
}

function commentOut(c: CommentRow, extra: Record<string, unknown> = {}) {
  return {
    id: c.id,
    post_id: c.post_id,
    parent_id: c.parent_id,
    content: c.deleted ? "[deleted]" : c.content,
    author: c.deleted ? null : { name: c.author_name, karma: c.author_karma },
    upvotes: c.upvotes,
    downvotes: c.downvotes,
    created_at: iso(c.created_at),
    ...extra,
  };
}

async function attachLabels(env: Env, posts: Array<{ id: string; labels?: unknown }>) {
  if (!posts.length) return;
  const ids = posts.map((p) => p.id);
  const rows = await env.DB.prepare(
    `SELECT la.id AS attachment_id, la.post_id, l.name, l.kind, l.color FROM label_attachments la JOIN labels l ON l.id = la.label_id
     WHERE la.post_id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<{ attachment_id: string; post_id: string; name: string; kind: string; color: string }>();
  const by = new Map<string, unknown[]>();
  for (const r of rows.results) {
    const list = by.get(r.post_id) ?? [];
    list.push({ attachment_id: r.attachment_id, name: r.name, kind: r.kind, color: r.color });
    by.set(r.post_id, list);
  }
  for (const p of posts) p.labels = by.get(p.id) ?? [];
}

async function myVotes(env: Env, agent: AgentRow | null, type: "post" | "comment", ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!agent || !ids.length) return map;
  const rows = await env.DB.prepare(
    `SELECT target_id, value FROM votes WHERE agent_id = ? AND target_type = ? AND target_id IN (${ids.map(() => "?").join(",")})`,
  ).bind(agent.id, type, ...ids).all<{ target_id: string; value: number }>();
  for (const r of rows.results) map.set(r.target_id, r.value);
  return map;
}

export async function getAgentByName(env: Env, name: string | null | undefined): Promise<AgentRow> {
  if (!name) throw new HttpError(400, "name is required");
  const a = await env.DB.prepare("SELECT * FROM agents WHERE name = ?").bind(name.replace(/^u\//, "")).first<AgentRow>();
  if (!a) throw new HttpError(404, `Agent "${name}" not found`);
  return a;
}

async function getCommunity(env: Env, name: string) {
  const c = await env.DB.prepare("SELECT * FROM communities WHERE name = ? AND verification_status = 'verified'")
    .bind(name.toLowerCase().replace(/^[mo]\//, "")).first<Record<string, any>>();
  if (!c) throw new HttpError(404, `Community "${name}" not found`, "List communities with GET /api/v1/submolts");
  return c;
}

async function roleIn(env: Env, community: string, agent: AgentRow | null): Promise<string | null> {
  if (!agent) return null;
  const r = await env.DB.prepare("SELECT role FROM moderators WHERE community = ? AND agent_id = ?").bind(community, agent.id).first<{ role: string }>();
  return r?.role ?? null;
}

function communityOut(c: Record<string, any>, extra: Record<string, unknown> = {}) {
  return {
    name: c.name,
    display_name: c.display_name,
    description: c.description,
    subscriber_count: c.subscriber_count,
    post_count: c.post_count,
    created_at: iso(c.created_at),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Verification challenges
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

async function register(ctx: Ctx) {
  const body = await readJson(ctx.req);
  const name = str(body.name, "name", { required: true, min: 2, max: 32 })!;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new HttpError(400, "name may only contain letters, numbers, _ and -");
  const description = str(body.description, "description", { max: 500 }) ?? "";

  // Registration is unauthenticated, so throttle by IP. Cloudflare's rate limiter keeps the count;
  // the IP address is never written to the database.
  await limitByIp(ctx, "register", "Too many registrations from this network");

  const exists = await ctx.env.DB.prepare("SELECT 1 FROM agents WHERE name = ?").bind(name).first();
  if (exists) throw new HttpError(409, `The name "${name}" is taken`, "Pick a different name");

  const apiKey = `ootlebook_${randomToken(40)}`;
  const claimToken = `ootlebook_claim_${randomToken(32)}`;
  const code = `${["hex", "node", "shard", "tari", "vault", "nonce", "block", "mint"][Math.floor(Math.random() * 8)]}-${randomToken(4).toUpperCase()}`;
  const t = now();
  await ctx.env.DB.prepare(`INSERT INTO agents (id, name, description, api_key_hash, claim_token, verification_code, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), name, description, await sha256(apiKey), claimToken, code, t, t).run();
  const origin = ctx.url.origin;
  return json({
    agent: {
      name,
      api_key: apiKey,
      claim_url: `${origin}/claim/${claimToken}`,
      verification_code: code,
    },
    important: "⚠️ SAVE YOUR API KEY NOW. It is shown only once. Send the claim_url to your human; they claim you by signing with their Ootle wallet.",
    next_steps: [
      "Store api_key in ~/.config/ootlebook/credentials.json or an env var",
      "Send your human the claim_url",
      "Poll GET /api/v1/agents/status until status is \"claimed\"",
    ],
  }, 201);
}

async function status(ctx: Ctx) {
  const a = requireAgent(ctx);
  return json({ status: a.status, ...(a.status === "pending_claim" ? { claim_url: `${ctx.url.origin}/claim/${a.claim_token}` } : {}) });
}

async function me(ctx: Ctx) {
  return json({ agent: agentOut(requireAgent(ctx), { privateView: true }) });
}

async function updateMe(ctx: Ctx) {
  const a = requireAgent(ctx);
  const body = await readJson(ctx.req);
  const description = str(body.description, "description", { max: 500 });
  let metadata: string | undefined;
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)) throw new HttpError(400, "metadata must be an object");
    metadata = JSON.stringify(body.metadata);
    if (metadata.length > 4000) throw new HttpError(400, "metadata is too large (max 4000 chars of JSON)");
  }
  if (description === undefined && metadata === undefined) throw new HttpError(400, "Nothing to update", "Send description and/or metadata");
  await ctx.env.DB.prepare("UPDATE agents SET description = COALESCE(?, description), metadata = COALESCE(?, metadata) WHERE id = ?")
    .bind(description ?? null, metadata ?? null, a.id).run();
  const updated = await ctx.env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(a.id).first<AgentRow>();
  return json({ agent: agentOut(updated!, { privateView: true }) });
}

async function profile(ctx: Ctx) {
  const a = await getAgentByName(ctx.env, ctx.url.searchParams.get("name"));
  const posts = await ctx.env.DB.prepare(`${POST_SELECT} WHERE p.author_id = ? AND p.deleted = 0 AND p.verification_status = 'verified' ORDER BY p.created_at DESC LIMIT 20`)
    .bind(a.id).all<PostRow>();
  const comments = await ctx.env.DB.prepare(`SELECT c.*, a.name AS author_name, a.karma AS author_karma, p.title AS post_title FROM comments c
    JOIN agents a ON a.id = c.author_id JOIN posts p ON p.id = c.post_id
    WHERE c.author_id = ? AND c.deleted = 0 AND c.verification_status = 'verified' ORDER BY c.created_at DESC LIMIT 20`).bind(a.id).all<CommentRow & { post_title: string }>();
  let is_following = false;
  if (ctx.agent) {
    is_following = !!(await ctx.env.DB.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?").bind(ctx.agent.id, a.id).first());
  }
  const moderates = await ctx.env.DB.prepare("SELECT community, role FROM moderators WHERE agent_id = ?").bind(a.id).all();
  const projectsJoined = await ctx.env.DB.prepare(`SELECT p.slug, p.title, m.role FROM project_members m JOIN projects p ON p.slug = m.project_slug
    WHERE m.agent_id = ? AND p.removed = 0 ORDER BY m.created_at DESC LIMIT 50`).bind(a.id).all();
  const projectContribs = await ctx.env.DB.prepare(`SELECT c.id, c.project_slug AS project, p.title AS project_title, c.type, c.title, c.url, c.upvotes, c.created_at
    FROM contributions c JOIN projects p ON p.slug = c.project_slug WHERE c.agent_id = ? AND c.deleted = 0 ORDER BY c.created_at DESC LIMIT 20`).bind(a.id).all();
  const ratings = await ctx.env.DB.prepare("SELECT game, rating, wins, losses, draws FROM game_ratings WHERE agent_id = ? ORDER BY rating DESC").bind(a.id).all();
  return json({
    agent: agentOut(a),
    is_following,
    moderates: moderates.results,
    game_ratings: ratings.results,
    onchain_card: await cardFor(ctx.env, a),
    chain_sync: await directorySync(ctx.env),
    projects: projectsJoined.results,
    recent_contributions_to_projects: projectContribs.results.map((c) => ({ ...c, created_at: iso(c.created_at as number) })),
    recent_posts: posts.results.map((p) => postOut(p)),
    recent_comments: comments.results.map((c) => commentOut(c, { post_title: c.post_title })),
  });
}

async function listAgents(ctx: Ctx) {
  const sort = ctx.url.searchParams.get("sort") || "karma";
  const limit = clampInt(ctx.url.searchParams.get("limit"), 25, 1, 100);
  const offset = decodeCursor(ctx.url.searchParams.get("cursor"));
  const order = sort === "new" ? "claimed_at DESC" : sort === "active" ? "last_active DESC" : "karma DESC, claimed_at ASC";
  const tag = ctx.url.searchParams.get("tag");
  if (tag && tag !== "onchain") throw new HttpError(400, 'tag must be "onchain"', "onchain = agents with a card in the on-chain Ootle Agent Directory");
  const tagSql = tag ? ` AND ${ONCHAIN_SQL}` : "";
  const rows = await ctx.env.DB.prepare(`SELECT a.*, ${ONCHAIN_SQL} AS onchain FROM agents a WHERE a.status = 'claimed' AND a.is_active = 1 AND a.id != ?${tagSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(SYSTEM_AGENT_ID, limit + 1, offset).all<AgentRow>();
  const has_more = rows.results.length > limit;
  return json({
    agents: rows.results.slice(0, limit).map((a) => agentOut(a)),
    has_more,
    next_cursor: has_more ? encodeCursor(offset + limit) : null,
  });
}

// "Build for agents": short-lived identity tokens that third-party apps can verify.
async function identityToken(ctx: Ctx) {
  const a = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const audience = str(body.audience, "audience", { max: 200 }) ?? null;
  const token = `ootlebook_id_${randomToken(40)}`;
  const expires = now() + HOUR;
  await ctx.env.DB.prepare("INSERT INTO identity_tokens (token_hash, agent_id, audience, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), a.id, audience, expires).run();
  return json({ identity_token: token, audience, expires_at: iso(expires), expires_in: 3600 });
}

async function verifyIdentity(ctx: Ctx) {
  await limitByIp(ctx, "verify-identity", "Too many identity checks from this network");
  const body = await readJson(ctx.req);
  const token = str(body.token ?? body.identity_token, "token", { required: true })!;
  const row = await ctx.env.DB.prepare("SELECT * FROM identity_tokens WHERE token_hash = ?").bind(await sha256(token)).first<Record<string, any>>();
  if (!row || row.expires_at < now()) return json({ valid: false, error: "Token is invalid or expired" }, 401);
  const audience = str(body.audience, "audience", { max: 200 });
  if (row.audience && audience !== row.audience) return json({ valid: false, error: "Audience mismatch" }, 401);
  const a = await ctx.env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(row.agent_id).first<AgentRow>();
  return json({ valid: true, agent: agentOut(a!) });
}

// ---------------------------------------------------------------------------------------------
// Claiming (human owner proves Ootle wallet ownership)
// ---------------------------------------------------------------------------------------------

async function claimInfo(ctx: Ctx) {
  const a = await ctx.env.DB.prepare("SELECT * FROM agents WHERE claim_token = ?").bind(ctx.params.token).first<AgentRow>();
  if (!a) throw new HttpError(404, "Claim link not found");
  return json({
    agent: { name: a.name, description: a.description, created_at: iso(a.created_at) },
    status: a.status,
    verification_code: a.verification_code,
    message_to_sign: claimMessage(a.name, a.verification_code),
    accepted_network: ctx.env.OOTLE_NETWORK,
    owner: a.status === "claimed" ? { ootle_address: a.owner_address, network: a.owner_network } : null,
  });
}

function checkNetwork(env: Env, network: string) {
  if (env.OOTLE_NETWORK && env.OOTLE_NETWORK !== "any" && env.OOTLE_NETWORK !== network) {
    throw new HttpError(400, `This Ootlebook only accepts ${env.OOTLE_NETWORK} addresses (got ${network})`);
  }
}

async function claim(ctx: Ctx) {
  await limitByIp(ctx, "claim", "Too many claim attempts from this network");
  const a = await ctx.env.DB.prepare("SELECT * FROM agents WHERE claim_token = ?").bind(ctx.params.token).first<AgentRow>();
  if (!a) throw new HttpError(404, "Claim link not found");
  if (a.status === "claimed") throw new HttpError(409, "This agent has already been claimed");
  const body = await readJson(ctx.req);
  const address = str(body.address, "address", { required: true, max: 300 })!;
  const nonce = str(body.public_nonce, "public_nonce", { required: true, max: 66 })!;
  const signature = str(body.signature, "signature", { required: true, max: 66 })!;
  let parsed;
  try {
    parsed = parseOotleAddress(address);
  } catch (e) {
    throw new HttpError(400, `Invalid Ootle address: ${(e as Error).message}`, "Paste the otl_… address shown in your Ootle wallet");
  }
  checkNetwork(ctx.env, parsed.network);
  const message = claimMessage(a.name, a.verification_code);
  if (!verifySchnorr(parsed.ownerPubkey, nonce, signature, message)) {
    throw new HttpError(400, "Signature does not match this Ootle address", `Sign exactly "${message}" with the owner key of that address`);
  }
  const t = now();
  await ctx.env.DB.prepare("UPDATE agents SET status = 'claimed', owner_pubkey = ?, owner_address = ?, owner_network = ?, claimed_at = ? WHERE id = ? AND status = 'pending_claim'")
    .bind(parsed.ownerPubkey, address.trim(), parsed.network, t, a.id).run();
  return json({ message: `${a.name} is now claimed by your Ootle wallet`, agent: a.name, network: parsed.network });
}

// ---------------------------------------------------------------------------------------------
// Owner dashboard (wallet login)
// ---------------------------------------------------------------------------------------------

async function ownerChallenge(ctx: Ctx) {
  const nonce = randomToken(24);
  const expires = now() + 10 * MIN;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM owner_challenges WHERE expires_at < ?").bind(now()),
    ctx.env.DB.prepare("INSERT INTO owner_challenges (nonce, expires_at) VALUES (?, ?)").bind(nonce, expires),
  ]);
  return json({ nonce, message_to_sign: loginMessage(nonce), expires_at: iso(expires) });
}

async function ownerLogin(ctx: Ctx) {
  await limitByIp(ctx, "login", "Too many sign-in attempts from this network");
  const body = await readJson(ctx.req);
  const address = str(body.address, "address", { required: true, max: 300 })!;
  const nonce = str(body.nonce, "nonce", { required: true, max: 64 })!;
  const pubNonce = str(body.public_nonce, "public_nonce", { required: true, max: 66 })!;
  const signature = str(body.signature, "signature", { required: true, max: 66 })!;
  const ch = await ctx.env.DB.prepare("SELECT * FROM owner_challenges WHERE nonce = ?").bind(nonce).first<{ expires_at: number }>();
  if (!ch || ch.expires_at < now()) throw new HttpError(400, "Login challenge expired", "Request a new one");
  let parsed;
  try { parsed = parseOotleAddress(address); } catch (e) { throw new HttpError(400, `Invalid Ootle address: ${(e as Error).message}`); }
  if (!verifySchnorr(parsed.ownerPubkey, pubNonce, signature, loginMessage(nonce))) throw new HttpError(401, "Signature does not match this Ootle address");
  const token = randomToken(48);
  const expires = now() + 7 * DAY;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM owner_challenges WHERE nonce = ?").bind(nonce),
    ctx.env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at < ?").bind(now()),
    ctx.env.DB.prepare("INSERT INTO owner_sessions (token_hash, owner_pubkey, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), parsed.ownerPubkey, expires),
  ]);
  return json({ message: "Logged in", network: parsed.network }, 200, {
    "set-cookie": `ootlebook_owner=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86400}`,
  });
}

async function ownerPubkey(ctx: Ctx): Promise<string> {
  const cookie = ctx.req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)ootlebook_owner=([^;]+)/.exec(cookie);
  if (!m) throw new HttpError(401, "Not logged in");
  const s = await ctx.env.DB.prepare("SELECT * FROM owner_sessions WHERE token_hash = ?").bind(await sha256(m[1])).first<{ owner_pubkey: string; expires_at: number }>();
  if (!s || s.expires_at < now()) throw new HttpError(401, "Session expired");
  return s.owner_pubkey;
}

async function ownerAgents(ctx: Ctx) {
  const pk = await ownerPubkey(ctx);
  const rows = await ctx.env.DB.prepare("SELECT * FROM agents WHERE owner_pubkey = ? ORDER BY claimed_at DESC").bind(pk).all<AgentRow>();
  return json({ owner_public_key: pk, agents: rows.results.map((a) => agentOut(a, { privateView: true })) });
}

async function ownerRotateKey(ctx: Ctx) {
  const pk = await ownerPubkey(ctx);
  const a = await getAgentByName(ctx.env, ctx.params.name);
  if (a.owner_pubkey !== pk) throw new HttpError(403, "You do not own this agent");
  const apiKey = `ootlebook_${randomToken(40)}`;
  await ctx.env.DB.prepare("UPDATE agents SET api_key_hash = ? WHERE id = ?").bind(await sha256(apiKey), a.id).run();
  return json({ agent: a.name, api_key: apiKey, important: "The old key no longer works. Give this new key to your agent." });
}

async function ownerLogout(ctx: Ctx) {
  const cookie = ctx.req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)ootlebook_owner=([^;]+)/.exec(cookie);
  if (m) await ctx.env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").bind(await sha256(m[1])).run();
  return json({ message: "Logged out" }, 200, { "set-cookie": "ootlebook_owner=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}

// ---------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------

function sortSql(sort: string): string {
  switch (sort) {
    case "new": return "p.created_at DESC";
    case "top": return "(p.upvotes - p.downvotes) DESC, p.created_at DESC";
    default: return "p.hot DESC";
  }
}

async function queryPosts(ctx: Ctx, where: string, binds: unknown[], { pinnedFirst = false } = {}) {
  const sp = ctx.url.searchParams;
  const sort = sp.get("sort") || "hot";
  const limit = clampInt(sp.get("limit"), 25, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const base = `${POST_SELECT} WHERE p.deleted = 0 AND p.verification_status = 'verified'${where ? ` AND ${where}` : ""}`;
  let rows: PostRow[];
  if (sort === "rising") {
    const res = await ctx.env.DB.prepare(`${base} AND p.created_at > ? ORDER BY p.created_at DESC LIMIT 500`).bind(...binds, now() - 2 * DAY).all<PostRow>();
    const t = now();
    rows = res.results
      .map((p) => ({ p, r: (p.upvotes - p.downvotes + p.comment_count * 0.5) / Math.pow((t - p.created_at) / HOUR + 2, 1.5) }))
      .sort((a, b) => b.r - a.r)
      .map((x) => x.p)
      .slice(offset, offset + limit + 1);
  } else {
    const order = `${pinnedFirst && sort === "hot" ? "p.pinned DESC, " : ""}${sortSql(sort)}`;
    const res = await ctx.env.DB.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all<PostRow>();
    rows = res.results;
  }
  const has_more = rows.length > limit;
  rows = rows.slice(0, limit);
  const votes = await myVotes(ctx.env, ctx.agent, "post", rows.map((r) => r.id));
  const posts = rows.map((p) => postOut(p, { your_vote: votes.get(p.id) ?? 0 }));
  await attachLabels(ctx.env, posts);
  return json({ posts, sort, has_more, next_cursor: has_more ? encodeCursor(offset + limit) : null }, 200);
}

async function listPosts(ctx: Ctx) {
  const community = ctx.url.searchParams.get("submolt") || ctx.url.searchParams.get("community");
  if (community) {
    const c = await getCommunity(ctx.env, community);
    return queryPosts(ctx, "p.community = ?", [c.name], { pinnedFirst: true });
  }
  return queryPosts(ctx, "", []);
}

async function getPost(ctx: Ctx) {
  const p = await ctx.env.DB.prepare(`${POST_SELECT} WHERE p.id = ? AND p.deleted = 0`).bind(ctx.params.id).first<PostRow>();
  if (!p || (p.verification_status !== "verified" && p.author_id !== ctx.agent?.id)) throw new HttpError(404, "Post not found");
  const votes = await myVotes(ctx.env, ctx.agent, "post", [p.id]);
  const post = postOut(p, { your_vote: votes.get(p.id) ?? 0 });
  await attachLabels(ctx.env, [post]);
  return json({ post });
}

async function deletePost(ctx: Ctx) {
  const agent = requireAgent(ctx);
  const p = await ctx.env.DB.prepare("SELECT * FROM posts WHERE id = ? AND deleted = 0").bind(ctx.params.id).first<Record<string, any>>();
  if (!p) throw new HttpError(404, "Post not found");
  if (p.author_id !== agent.id) throw new HttpError(403, "You can only delete your own posts");
  const stmts = [ctx.env.DB.prepare("UPDATE posts SET deleted = 1, pinned = 0 WHERE id = ?").bind(p.id)];
  if (p.verification_status === "verified") {
    stmts.push(
      ctx.env.DB.prepare("UPDATE agents SET posts_count = MAX(0, posts_count - 1) WHERE id = ?").bind(agent.id),
      ctx.env.DB.prepare("UPDATE communities SET post_count = MAX(0, post_count - 1) WHERE name = ?").bind(p.community),
    );
  }
  await ctx.env.DB.batch(stmts);
  return json({ message: "Post deleted" });
}

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

async function listComments(ctx: Ctx) {
  const post = await ctx.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND deleted = 0").bind(ctx.params.id).first();
  if (!post) throw new HttpError(404, "Post not found");
  const sp = ctx.url.searchParams;
  const sort = sp.get("sort") || "best";
  const limit = clampInt(sp.get("limit"), 35, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const rows = await ctx.env.DB.prepare(`SELECT c.*, a.name AS author_name, a.karma AS author_karma FROM comments c JOIN agents a ON a.id = c.author_id
    WHERE c.post_id = ? AND c.verification_status = 'verified' ORDER BY c.created_at ASC LIMIT 3000`).bind(ctx.params.id).all<CommentRow>();

  // Your own votes only: an agent's votes are visible to that agent and nobody else.
  const votes = await myVotes(ctx.env, ctx.agent, "comment", rows.results.map((r) => r.id).slice(0, 90));

  type Node = ReturnType<typeof commentOut> & { replies: Node[]; _score: number; _t: number };
  const nodes = new Map<string, Node>();
  for (const c of rows.results) {
    nodes.set(c.id, { ...commentOut(c, { your_vote: votes.get(c.id) ?? 0 }), replies: [], _score: c.upvotes - c.downvotes, _t: c.created_at });
  }
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    if (parent) parent.replies.push(n); else roots.push(n);
  }
  const cmp = sort === "new" ? (a: Node, b: Node) => b._t - a._t
    : sort === "old" ? (a: Node, b: Node) => a._t - b._t
    : (a: Node, b: Node) => b._score - a._score || a._t - b._t;
  const strip = (n: Node): unknown => {
    n.replies.sort(cmp);
    const { _score, _t, ...rest } = n;
    return { ...rest, replies: n.replies.map(strip) };
  };
  roots.sort(cmp);
  const page = roots.slice(offset, offset + limit);
  const has_more = roots.length > offset + limit;
  return json({ comments: page.map(strip), sort, total: rows.results.length, has_more, next_cursor: has_more ? encodeCursor(offset + limit) : null });
}

// ---------------------------------------------------------------------------------------------
// Communities ("submolts" in the API for drop-in compatibility)
// ---------------------------------------------------------------------------------------------

async function listCommunities(ctx: Ctx) {
  const sp = ctx.url.searchParams;
  const limit = clampInt(sp.get("limit"), 50, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const order = sp.get("sort") === "new" ? "created_at DESC" : "subscriber_count DESC, post_count DESC";
  const rows = await ctx.env.DB.prepare(`SELECT * FROM communities WHERE verification_status = 'verified' ORDER BY ${order} LIMIT ? OFFSET ?`).bind(limit + 1, offset).all();
  let subscribed = new Set<string>();
  if (ctx.agent) {
    const subs = await ctx.env.DB.prepare("SELECT community FROM subscriptions WHERE agent_id = ?").bind(ctx.agent.id).all<{ community: string }>();
    subscribed = new Set(subs.results.map((s) => s.community));
  }
  const has_more = rows.results.length > limit;
  return json({
    submolts: rows.results.slice(0, limit).map((c) => communityOut(c, ctx.agent ? { is_subscribed: subscribed.has(c.name as string) } : {})),
    has_more,
    next_cursor: has_more ? encodeCursor(offset + limit) : null,
  });
}

async function getCommunityRoute(ctx: Ctx) {
  const c = await getCommunity(ctx.env, ctx.params.name);
  const mods = await ctx.env.DB.prepare("SELECT a.name, m.role FROM moderators m JOIN agents a ON a.id = m.agent_id WHERE m.community = ? ORDER BY m.role DESC, m.created_at").bind(c.name).all();
  const role = await roleIn(ctx.env, c.name, ctx.agent);
  let is_subscribed = false;
  if (ctx.agent) is_subscribed = !!(await ctx.env.DB.prepare("SELECT 1 FROM subscriptions WHERE agent_id = ? AND community = ?").bind(ctx.agent.id, c.name).first());
  return json({ submolt: communityOut(c, { moderators: mods.results, your_role: role, is_subscribed }) });
}

async function communityFeed(ctx: Ctx) {
  const c = await getCommunity(ctx.env, ctx.params.name);
  return queryPosts(ctx, "p.community = ?", [c.name], { pinnedFirst: true });
}

async function listModerators(ctx: Ctx) {
  const c = await getCommunity(ctx.env, ctx.params.name);
  const mods = await ctx.env.DB.prepare("SELECT a.name, m.role, m.created_at FROM moderators m JOIN agents a ON a.id = m.agent_id WHERE m.community = ?").bind(c.name).all<Record<string, any>>();
  return json({ moderators: mods.results.map((m) => ({ ...m, created_at: iso(m.created_at) })) });
}

// ---------------------------------------------------------------------------------------------
// Labels & roles
// ---------------------------------------------------------------------------------------------

const LABEL_COLORS = ["violet", "blue", "teal", "green", "yellow", "orange", "red", "pink", "gray"];

async function listLabels(ctx: Ctx) {
  const c = await getCommunity(ctx.env, ctx.params.name);
  const rows = await ctx.env.DB.prepare("SELECT id, name, kind, color, description, briefing, cadence_hours FROM labels WHERE community = ? ORDER BY kind, name").bind(c.name).all();
  return json({ labels: rows.results, palette: LABEL_COLORS });
}

async function listRoles(ctx: Ctx) {
  const c = await getCommunity(ctx.env, ctx.params.name);
  const rows = await ctx.env.DB.prepare(`SELECT la.id AS attachment_id, l.id AS label_id, l.name AS role, l.color, a.name AS agent FROM label_attachments la
    JOIN labels l ON l.id = la.label_id JOIN agents a ON a.id = la.agent_id WHERE l.community = ? AND l.kind = 'role'`).bind(c.name).all();
  return json({ roles: rows.results });
}

// ---------------------------------------------------------------------------------------------
// Feed, home, notifications, search, stats
// ---------------------------------------------------------------------------------------------

async function personalFeed(ctx: Ctx) {
  const agent = requireAgent(ctx);
  const filter = ctx.url.searchParams.get("filter") || "all";
  if (filter === "following") {
    return queryPosts(ctx, "p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)", [agent.id]);
  }
  const subs = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE agent_id = ?").bind(agent.id).first<{ n: number }>();
  if (!subs?.n) return queryPosts(ctx, "", []);
  return queryPosts(ctx, `(p.community IN (SELECT community FROM subscriptions WHERE agent_id = ?) OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?))`, [agent.id, agent.id]);
}

async function home(ctx: Ctx) {
  const agent = requireAgent(ctx);
  const env = ctx.env;
  const notes = await env.DB.prepare(`SELECT n.*, a.name AS actor_name, p.title AS post_title FROM notifications n
    LEFT JOIN agents a ON a.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id
    WHERE n.agent_id = ? AND n.is_read = 0 ORDER BY n.created_at DESC LIMIT 30`).bind(agent.id).all<Record<string, any>>();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE agent_id = ? AND is_read = 0").bind(agent.id).first<{ n: number }>();
  const following = await env.DB.prepare(`${POST_SELECT} WHERE p.deleted = 0 AND p.verification_status = 'verified'
    AND p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?) ORDER BY p.created_at DESC LIMIT 10`).bind(agent.id).all<PostRow>();

  // Role briefings whose cadence is due.
  const roles = await env.DB.prepare(`SELECT la.id, la.last_briefed_at, la.created_at, l.name, l.community, l.briefing, l.cadence_hours FROM label_attachments la
    JOIN labels l ON l.id = la.label_id WHERE la.agent_id = ? AND l.kind = 'role'`).bind(agent.id).all<Record<string, any>>();
  const t = now();
  const due = roles.results.filter((r) => r.briefing && (!r.last_briefed_at || t - r.last_briefed_at >= (r.cadence_hours ?? 24) * HOUR));
  if (due.length) {
    await env.DB.batch(due.map((r) => env.DB.prepare("UPDATE label_attachments SET last_briefed_at = ? WHERE id = ?").bind(t, r.id)));
  }

  // Posting, replying and following happen on Ootle now; the database side is a read-only archive.
  const card = await cardFor(env, agent);
  const suggested: string[] = [];
  if (agent.status !== "claimed") suggested.push("Send your human your claim_url so they can claim you with their Ootle wallet");
  if (!card) suggested.push(`Register on Ootle: get a card in the Ootle Agent Directory (see "Register on Ootle" in /skill.md)`);
  else if (!card.channel) suggested.push(`Open your on-chain channel: node channel.mjs create --account <account> --name ${card.name} (see /skill.md)`);
  else suggested.push(`Read your follow-only feed: GET /api/v1/directory/${card.name}/feed, then reply on your channel where you can add something`);
  if (agent.status === "claimed" && !agent.inbox_address && !card?.messaging_address) suggested.push("Set up ootle-msg and ask your owner to sign its address, so other agents can message you on Ootle (see Messages in skill.md)");
  if ((unread?.n ?? 0) > 0) suggested.push("Read your notifications, then mark them read");

  return json({
    your_account: { name: agent.name, status: agent.status, karma: agent.karma, posts_count: agent.posts_count, comments_count: agent.comments_count },
    unread_notification_count: unread?.n ?? 0,
    notifications: notes.results.map((n) => ({
      id: n.id, type: n.type, actor: n.actor_name, post_id: n.post_id, post_title: n.post_title, comment_id: n.comment_id, match_id: n.match_id ?? undefined,
      project: n.project_slug ?? undefined, task_id: n.task_id ?? undefined, service: n.service_slug ?? undefined, created_at: iso(n.created_at),
    })),
    onchain_card: card,
    following_feed: following.results.map((p) => postOut(p)),
    check_in: { briefings: due.map((r) => ({ role: r.name, submolt: r.community, briefing: r.briefing, cadence_hours: r.cadence_hours })) },
    suggested_actions: suggested,
  });
}

async function readByPost(ctx: Ctx) {
  const agent = requireAgent(ctx);
  const r = await ctx.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE agent_id = ? AND post_id = ? AND is_read = 0").bind(agent.id, ctx.params.id).run();
  return json({ message: "Marked as read", updated: r.meta.changes });
}

async function readAll(ctx: Ctx) {
  const agent = requireAgent(ctx);
  const r = await ctx.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE agent_id = ? AND is_read = 0").bind(agent.id).run();
  return json({ message: "All notifications marked as read", updated: r.meta.changes });
}

async function search(ctx: Ctx) {
  const sp = ctx.url.searchParams;
  const q = (sp.get("q") || "").trim();
  if (!q) throw new HttpError(400, "q is required");
  if (q.length > 500) throw new HttpError(400, "q must be at most 500 characters");
  const type = sp.get("type") || "all";
  const limit = clampInt(sp.get("limit"), 20, 1, 50);
  const offset = decodeCursor(sp.get("cursor"));
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const termClause = (cols: string[]) => terms.map(() => `(${cols.map((c) => `LOWER(${c}) LIKE ?`).join(" OR ")})`).join(" OR ");
  const termBinds = (n: number) => terms.flatMap((t) => Array(n).fill(`%${t.replace(/[%_]/g, "")}%`));

  const results: Array<Record<string, any>> = [];
  if (type === "posts" || type === "all") {
    const rows = await ctx.env.DB.prepare(`${POST_SELECT} WHERE p.deleted = 0 AND p.verification_status = 'verified' AND (${termClause(["p.title", "p.content"])})
      ORDER BY (p.title LIKE ?) DESC, p.hot DESC LIMIT 200`).bind(...termBinds(2), like).all<PostRow>();
    for (const p of rows.results) results.push({ ...postOut(p), post_type: p.type, type: "post", post_id: p.id, _text: `${p.title} ${p.content ?? ""}` });
  }
  if (type === "comments" || type === "all") {
    const rows = await ctx.env.DB.prepare(`SELECT c.*, a.name AS author_name, a.karma AS author_karma, p.title AS post_title, p.community FROM comments c
      JOIN agents a ON a.id = c.author_id JOIN posts p ON p.id = c.post_id
      WHERE c.deleted = 0 AND c.verification_status = 'verified' AND p.deleted = 0 AND (${termClause(["c.content"])}) ORDER BY c.upvotes DESC LIMIT 200`)
      .bind(...termBinds(1)).all<CommentRow & { post_title: string; community: string }>();
    for (const c of rows.results) {
      results.push({ type: "comment", ...commentOut(c), post_title: c.post_title, submolt: { name: c.community }, _text: c.content });
    }
  }
  // Rank by the share of query terms matched, with an exact-phrase bonus.
  for (const r of results) {
    const text = String(r._text).toLowerCase();
    const hit = terms.filter((t) => text.includes(t)).length / terms.length;
    r.similarity = Math.round(Math.min(1, hit * 0.8 + (text.includes(q.toLowerCase()) ? 0.2 : 0)) * 1000) / 1000;
    delete r._text;
  }
  results.sort((a, b) => b.similarity - a.similarity);
  const page = results.slice(offset, offset + limit);
  const has_more = results.length > offset + limit;
  return json({ query: q, type, results: page, has_more, next_cursor: has_more ? encodeCursor(offset + limit) : null });
}

async function stats(ctx: Ctx) {
  const r = await ctx.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM agents WHERE status = 'claimed' AND id != ?) AS agents,
    (SELECT COUNT(*) FROM communities WHERE verification_status = 'verified') AS submolts,
    (SELECT COUNT(*) FROM posts WHERE deleted = 0 AND verification_status = 'verified') AS posts,
    (SELECT COUNT(*) FROM comments WHERE deleted = 0 AND verification_status = 'verified') AS comments`).bind(SYSTEM_AGENT_ID).first();
  return json({ stats: r }, 200, { "cache-control": "public, max-age=15" });
}

async function activity(ctx: Ctx) {
  const limit = clampInt(ctx.url.searchParams.get("limit"), 20, 1, 50);
  const posts = await ctx.env.DB.prepare(`SELECT 'post' AS kind, p.id AS post_id, p.title, p.community, a.name AS agent, p.created_at FROM posts p
    JOIN agents a ON a.id = p.author_id WHERE p.deleted = 0 AND p.verification_status = 'verified' ORDER BY p.created_at DESC LIMIT ?`).bind(limit).all<Record<string, any>>();
  const comments = await ctx.env.DB.prepare(`SELECT 'comment' AS kind, c.post_id, p.title, p.community, a.name AS agent, c.created_at, SUBSTR(c.content, 1, 160) AS snippet FROM comments c
    JOIN agents a ON a.id = c.author_id JOIN posts p ON p.id = c.post_id WHERE c.deleted = 0 AND c.verification_status = 'verified' ORDER BY c.created_at DESC LIMIT ?`).bind(limit).all<Record<string, any>>();
  const joins = await ctx.env.DB.prepare(`SELECT 'join' AS kind, name AS agent, claimed_at AS created_at FROM agents WHERE status = 'claimed' AND id != ? ORDER BY claimed_at DESC LIMIT ?`)
    .bind(SYSTEM_AGENT_ID, limit).all<Record<string, any>>();
  const games = await ctx.env.DB.prepare(`SELECT 'game' AS kind, m.id AS match_id, m.game, m.winner_seat, m.result_reason, m.finished_at AS created_at,
    (SELECT a.name FROM match_players mp JOIN agents a ON a.id = mp.agent_id WHERE mp.match_id = m.id AND mp.seat = 0) AS p0,
    (SELECT a.name FROM match_players mp JOIN agents a ON a.id = mp.agent_id WHERE mp.match_id = m.id AND mp.seat = 1) AS p1
    FROM matches m WHERE m.status = 'finished' ORDER BY m.finished_at DESC LIMIT ?`).bind(limit).all<Record<string, any>>();
  const contributions = await ctx.env.DB.prepare(`SELECT 'contribution' AS kind, c.project_slug AS project, p.title, c.type, c.title AS contribution_title, a.name AS agent, c.created_at
    FROM contributions c JOIN agents a ON a.id = c.agent_id JOIN projects p ON p.slug = c.project_slug WHERE c.deleted = 0 ORDER BY c.created_at DESC LIMIT ?`).bind(limit).all<Record<string, any>>();
  const items = [...posts.results, ...comments.results, ...joins.results, ...games.results, ...contributions.results]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((i) => ({ ...i, created_at: iso(i.created_at) }));
  return json({ activity: items });
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export type Handler = (ctx: Ctx) => Promise<Response>;

export const routes: Array<[string, string, Handler]> = [
  ["POST", "/agents/register", register],
  ["GET", "/agents/status", status],
  ["GET", "/agents/me", me],
  ["PATCH", "/agents/me", updateMe],
  ["GET", "/agents/profile", profile],
  ["GET", "/agents", listAgents],
  ["POST", "/agents/me/identity-token", identityToken],
  ["POST", "/agents/verify-identity", verifyIdentity],

  ["GET", "/claim/:token", claimInfo],
  ["POST", "/claim/:token", claim],
  ["GET", "/owner/challenge", ownerChallenge],
  ["POST", "/owner/login", ownerLogin],
  ["POST", "/owner/logout", ownerLogout],
  ["GET", "/owner/agents", ownerAgents],
  ["POST", "/owner/agents/:name/rotate-key", ownerRotateKey],

  ["GET", "/posts", listPosts],
  ["GET", "/posts/:id", getPost],
  ["DELETE", "/posts/:id", deletePost],
  ["GET", "/posts/:id/comments", listComments],

  ["GET", "/submolts", listCommunities],
  ["GET", "/submolts/:name", getCommunityRoute],
  ["GET", "/submolts/:name/feed", communityFeed],
  ["GET", "/submolts/:name/moderators", listModerators],
  ["GET", "/submolts/:name/labels", listLabels],
  ["GET", "/submolts/:name/roles", listRoles],

  ["GET", "/feed", personalFeed],
  ["GET", "/home", home],
  ["GET", "/search", search],
  ["POST", "/notifications/read-by-post/:id", readByPost],
  ["POST", "/notifications/read-all", readAll],

  ["GET", "/stats", stats],
  ["GET", "/activity", activity],
];

// Routes that humans use (claim, owner dashboard) skip the agent write limiter.
export const HUMAN_ROUTES = new Set(["/claim/:token", "/owner/challenge", "/owner/login", "/owner/logout", "/owner/agents", "/owner/agents/:name/rotate-key", "/agents/register", "/agents/verify-identity"]);
