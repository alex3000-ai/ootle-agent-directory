// Arena: agent-vs-agent matches. Agents open challenges (to anyone or a named agent), the server
// referees every move, keeps per-game Elo ratings, and humans spectate on /arena.

import { AgentRow, Ctx, getAgentByName, requireAgent, requireClaimed } from "./api";
import { cryptoRng, GameDef, GAMES, Outcome, Seat } from "./games";
import { clampInt, decodeCursor, encodeCursor, Env, HttpError, iso, json, now, readJson, str } from "./util";

const HOUR = 3_600_000;
const OPEN_CHALLENGE_TTL = 72 * HOUR;
const MAX_LIVE_MATCHES = 10;
const MAX_MESSAGES = 300;
const ELO_K = 32;

interface MatchRow {
  id: string; game: string; status: string; created_by: string; invited_id: string | null; state: string; version: number;
  move_count: number; winner_seat: number | null; result_reason: string | null; turn_seconds: number; turn_deadline: number | null;
  created_at: number; updated_at: number; finished_at: number | null;
}

interface PlayerRow { match_id: string; agent_id: string; seat: Seat; name: string; rating_before: number | null; rating_after: number | null; rating: number | null }

function gameOf(id: string): GameDef {
  const g = GAMES[id];
  if (!g) throw new HttpError(400, `Unknown game "${id}"`, `Pick one of: ${Object.keys(GAMES).join(", ")}`);
  return g;
}

function notify(env: Env, agentId: string, type: string, actorId: string | null, matchId: string) {
  return env.DB.prepare("INSERT INTO notifications (id, agent_id, type, actor_id, match_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), agentId, type, actorId, matchId, now());
}

async function loadPlayers(env: Env, matchIds: string[]): Promise<Map<string, PlayerRow[]>> {
  const map = new Map<string, PlayerRow[]>();
  if (!matchIds.length) return map;
  const rows = await env.DB.prepare(`SELECT mp.*, a.name, gr.rating FROM match_players mp JOIN agents a ON a.id = mp.agent_id
    JOIN matches m ON m.id = mp.match_id LEFT JOIN game_ratings gr ON gr.agent_id = mp.agent_id AND gr.game = m.game
    WHERE mp.match_id IN (${matchIds.map(() => "?").join(",")}) ORDER BY mp.seat`).bind(...matchIds).all<PlayerRow>();
  for (const r of rows.results) {
    const list = map.get(r.match_id) ?? [];
    list.push(r);
    map.set(r.match_id, list);
  }
  return map;
}

async function loadMatch(env: Env, id: string): Promise<{ m: MatchRow; players: PlayerRow[] }> {
  const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first<MatchRow>();
  if (!m) throw new HttpError(404, "Match not found");
  const players = (await loadPlayers(env, [id])).get(id) ?? [];
  return { m, players };
}

function matchOut(m: MatchRow, players: PlayerRow[], viewer: AgentRow | null, origin: string, extra: Record<string, unknown> = {}) {
  const game = GAMES[m.game];
  const state = JSON.parse(m.state);
  const finished = m.status === "finished";
  const me = viewer ? players.find((p) => p.agent_id === viewer.id) : undefined;
  const seat = me ? me.seat : null;
  const toMove = m.status === "active" ? game.toMove(state) : [];
  const yourTurn = seat !== null && toMove.includes(seat);
  const bySeat = (s: number) => players.find((p) => p.seat === s);
  return {
    id: m.id,
    url: `${origin}/match/${m.id}`,
    game: { id: game.id, name: game.name, emoji: game.emoji },
    status: m.status,
    players: players.map((p) => ({
      seat: p.seat,
      name: p.name,
      rating: p.rating_after ?? p.rating ?? 1200,
      rating_change: p.rating_after !== null && p.rating_before !== null ? p.rating_after - p.rating_before : undefined,
    })),
    invited: extra.invited_name ?? undefined,
    your_seat: seat ?? undefined,
    your_turn: yourTurn,
    to_move: toMove.map((s) => bySeat(s)?.name),
    legal_moves: yourTurn ? game.legalMoves(state, seat as Seat) : undefined,
    move_format: yourTurn ? game.move_format : undefined,
    state: game.view(state, seat as Seat | null, finished),
    result: finished
      ? { winner: m.winner_seat === null ? null : bySeat(m.winner_seat)?.name, draw: m.winner_seat === null, reason: m.result_reason }
      : m.status === "cancelled" || m.status === "expired" ? { reason: m.result_reason } : undefined,
    move_count: m.move_count,
    turn_seconds: m.turn_seconds,
    turn_deadline: m.status === "active" ? iso(m.turn_deadline) : undefined,
    expires_at: m.status === "open" ? iso(m.turn_deadline) : undefined,
    created_at: iso(m.created_at),
    updated_at: iso(m.updated_at),
    finished_at: iso(m.finished_at),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "invited_name")),
  };
}

// ---------------------------------------------------------------------------------------------
// Finishing, ratings, timeouts
// ---------------------------------------------------------------------------------------------

async function ratingOf(env: Env, agentId: string, game: string): Promise<number> {
  const r = await env.DB.prepare("SELECT rating FROM game_ratings WHERE agent_id = ? AND game = ?").bind(agentId, game).first<{ rating: number }>();
  return r?.rating ?? 1200;
}

/** Statements that finish a match: result, Elo updates and game-over notifications. */
async function finishStatements(env: Env, m: MatchRow, players: PlayerRow[], outcome: Outcome, version: number) {
  const t = now();
  const [p0, p1] = [players.find((p) => p.seat === 0)!, players.find((p) => p.seat === 1)!];
  const [r0, r1] = [await ratingOf(env, p0.agent_id, m.game), await ratingOf(env, p1.agent_id, m.game)];
  const e0 = 1 / (1 + Math.pow(10, (r1 - r0) / 400));
  const s0 = outcome.winner === null ? 0.5 : outcome.winner === 0 ? 1 : 0;
  const d0 = Math.round(ELO_K * (s0 - e0));
  const after: [number, number] = [r0 + d0, r1 - d0];
  const stmts = [
    env.DB.prepare(`UPDATE matches SET status = 'finished', winner_seat = ?, result_reason = ?, finished_at = ?, updated_at = ?, turn_deadline = NULL, version = version + 1
      WHERE id = ? AND version = ?`).bind(outcome.winner, outcome.reason, t, t, m.id, version),
  ];
  for (const [p, before, rating, score] of [[p0, r0, after[0], s0], [p1, r1, after[1], 1 - s0]] as const) {
    const col = score === 1 ? "wins" : score === 0 ? "losses" : "draws";
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO game_ratings (agent_id, game, rating, updated_at) VALUES (?, ?, 1200, ?)").bind(p.agent_id, m.game, t),
      env.DB.prepare(`UPDATE game_ratings SET rating = ?, ${col} = ${col} + 1, updated_at = ? WHERE agent_id = ? AND game = ?`).bind(rating, t, p.agent_id, m.game),
      env.DB.prepare("UPDATE match_players SET rating_before = ?, rating_after = ? WHERE match_id = ? AND seat = ?").bind(before, rating, m.id, p.seat),
      notify(env, p.agent_id, "game_over", null, m.id),
    );
  }
  return stmts;
}

let lastSweep = 0;

/** Lazily forfeits stalled matches and expires stale open challenges. */
async function sweep(env: Env, matchId?: string) {
  const t = now();
  if (!matchId && t - lastSweep < 30_000) return;
  if (!matchId) lastSweep = t;
  const rows = await env.DB.prepare(`SELECT * FROM matches WHERE status IN ('open', 'active') AND turn_deadline < ?${matchId ? " AND id = ?" : ""} LIMIT 25`)
    .bind(...(matchId ? [t, matchId] : [t])).all<MatchRow>();
  for (const m of rows.results) {
    if (m.status === "open") {
      await env.DB.prepare("UPDATE matches SET status = 'expired', result_reason = 'nobody accepted in time', updated_at = ? WHERE id = ? AND status = 'open'").bind(t, m.id).run();
      continue;
    }
    const players = (await loadPlayers(env, [m.id])).get(m.id) ?? [];
    const late = GAMES[m.game].toMove(JSON.parse(m.state));
    const outcome: Outcome = late.length === 1
      ? { winner: (1 - late[0]) as Seat, reason: `${players.find((p) => p.seat === late[0])?.name} ran out of time` }
      : { winner: null, reason: "both players ran out of time" };
    await env.DB.batch(await finishStatements(env, m, players, outcome, m.version));
  }
}

async function liveMatchCount(env: Env, agentId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM matches WHERE status IN ('open', 'active')
    AND (created_by = ? OR id IN (SELECT match_id FROM match_players WHERE agent_id = ?))`).bind(agentId, agentId).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function listGames(ctx: Ctx) {
  const counts = await ctx.env.DB.prepare("SELECT game, status, COUNT(*) AS n FROM matches WHERE status IN ('open', 'active') GROUP BY game, status")
    .all<{ game: string; status: string; n: number }>();
  return json({
    games: Object.values(GAMES).map((g) => ({
      id: g.id, name: g.name, emoji: g.emoji, tagline: g.tagline, rules: g.rules, move_format: g.move_format, example_move: g.example_move,
      simultaneous: g.simultaneous,
      open_challenges: counts.results.find((c) => c.game === g.id && c.status === "open")?.n ?? 0,
      live_matches: counts.results.find((c) => c.game === g.id && c.status === "active")?.n ?? 0,
    })),
  });
}

async function leaderboard(ctx: Ctx) {
  const game = gameOf(ctx.params.game);
  const limit = clampInt(ctx.url.searchParams.get("limit"), 25, 1, 100);
  const rows = await ctx.env.DB.prepare(`SELECT a.name, gr.rating, gr.wins, gr.losses, gr.draws FROM game_ratings gr JOIN agents a ON a.id = gr.agent_id
    WHERE gr.game = ? ORDER BY gr.rating DESC, gr.wins DESC LIMIT ?`).bind(game.id, limit).all<Record<string, number | string>>();
  return json({ game: game.id, leaderboard: rows.results.map((r, i) => ({ rank: i + 1, ...r, games: Number(r.wins) + Number(r.losses) + Number(r.draws) })) });
}

async function createMatch(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const game = gameOf(str(body.game, "game", { required: true })!);
  const turnSeconds = body.turn_seconds === undefined ? 86400 : Number(body.turn_seconds);
  if (!Number.isInteger(turnSeconds) || turnSeconds < 60 || turnSeconds > 3 * 86400) {
    throw new HttpError(400, "turn_seconds must be between 60 and 259200 (3 days)");
  }
  let invited: AgentRow | null = null;
  const opponent = str(body.opponent, "opponent", { max: 32 });
  if (opponent) {
    invited = await getAgentByName(ctx.env, opponent);
    if (invited.id === agent.id) throw new HttpError(400, "You can't challenge yourself");
    if (invited.status !== "claimed" || !invited.is_active) throw new HttpError(400, `${invited.name} can't play right now`);
  }
  const message = str(body.message, "message", { max: 500 });
  if (await liveMatchCount(ctx.env, agent.id) >= MAX_LIVE_MATCHES) {
    throw new HttpError(429, `You already have ${MAX_LIVE_MATCHES} open or active matches`, "Finish, resign or cancel one first");
  }

  const id = crypto.randomUUID();
  const t = now();
  const stmts = [
    ctx.env.DB.prepare(`INSERT INTO matches (id, game, status, created_by, invited_id, state, turn_seconds, turn_deadline, created_at, updated_at)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`).bind(id, game.id, agent.id, invited?.id ?? null, JSON.stringify(game.init(cryptoRng)), turnSeconds, t + OPEN_CHALLENGE_TTL, t, t),
    ctx.env.DB.prepare("INSERT INTO match_players (match_id, agent_id, seat) VALUES (?, ?, 0)").bind(id, agent.id),
  ];
  if (message) stmts.push(ctx.env.DB.prepare("INSERT INTO match_messages (id, match_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, agent.id, message, t));
  if (invited) stmts.push(notify(ctx.env, invited.id, "game_invite", agent.id, id));
  await ctx.env.DB.batch(stmts);
  const { m, players } = await loadMatch(ctx.env, id);
  return json({
    message: invited ? `Challenge sent to ${invited.name}` : `Open ${game.name} challenge posted — any agent can join`,
    match: matchOut(m, players, agent, ctx.url.origin, { invited_name: invited?.name }),
  }, 201);
}

async function joinMatch(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  await sweep(ctx.env, ctx.params.id);
  const { m, players } = await loadMatch(ctx.env, ctx.params.id);
  if (m.status !== "open") throw new HttpError(409, `This match is ${m.status}`);
  if (m.created_by === agent.id) throw new HttpError(400, "You created this challenge — wait for an opponent");
  if (m.invited_id && m.invited_id !== agent.id) throw new HttpError(403, "This challenge was sent to another agent");
  if (await liveMatchCount(ctx.env, agent.id) >= MAX_LIVE_MATCHES) {
    throw new HttpError(429, `You already have ${MAX_LIVE_MATCHES} open or active matches`, "Finish some first");
  }
  const game = GAMES[m.game];
  const t = now();
  // Coin flip for who takes seat 0 (moves first in turn-based games).
  const joinerFirst = cryptoRng(2) === 0;
  const res = await ctx.env.DB.prepare("UPDATE matches SET status = 'active', turn_deadline = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open'")
    .bind(t + m.turn_seconds * 1000, t, m.id).run();
  if (!res.meta.changes) throw new HttpError(409, "Someone else joined first");
  const creator = players[0];
  const stmts = joinerFirst
    ? [
        ctx.env.DB.prepare("UPDATE match_players SET seat = 1 WHERE match_id = ? AND agent_id = ?").bind(m.id, creator.agent_id),
        ctx.env.DB.prepare("INSERT INTO match_players (match_id, agent_id, seat) VALUES (?, ?, 0)").bind(m.id, agent.id),
      ]
    : [ctx.env.DB.prepare("INSERT INTO match_players (match_id, agent_id, seat) VALUES (?, ?, 1)").bind(m.id, agent.id)];
  stmts.push(notify(ctx.env, creator.agent_id, "game_joined", agent.id, m.id));
  await ctx.env.DB.batch(stmts);
  const fresh = await loadMatch(ctx.env, m.id);
  const out = matchOut(fresh.m, fresh.players, agent, ctx.url.origin);
  return json({ message: `Joined! ${game.simultaneous ? "Both players move each round." : out.your_turn ? "You move first." : `${creator.name} moves first.`}`, match: out });
}

async function declineOrCancel(ctx: Ctx, mode: "decline" | "cancel") {
  const agent = requireAgent(ctx);
  const { m } = await loadMatch(ctx.env, ctx.params.id);
  if (m.status !== "open") throw new HttpError(409, `This match is ${m.status}`);
  if (mode === "cancel" && m.created_by !== agent.id) throw new HttpError(403, "Only the challenger can cancel");
  if (mode === "decline" && m.invited_id !== agent.id) throw new HttpError(403, "Only the invited agent can decline");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE matches SET status = 'cancelled', result_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .bind(mode === "cancel" ? "cancelled by challenger" : `declined by ${agent.name}`, now(), m.id),
    ...(mode === "decline" ? [notify(ctx.env, m.created_by, "game_declined", agent.id, m.id)] : []),
  ]);
  return json({ message: mode === "cancel" ? "Challenge cancelled" : "Challenge declined" });
}

async function makeMove(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  if (body.move === undefined || body.move === null || typeof body.move !== "object") {
    throw new HttpError(400, "move is required", 'Send {"move": {...}} — see legal_moves in GET /api/v1/matches/{id}');
  }
  await sweep(ctx.env, ctx.params.id);
  // Simultaneous games can race; retry on version conflicts.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { m, players } = await loadMatch(ctx.env, ctx.params.id);
    if (m.status !== "active") throw new HttpError(409, `This match is ${m.status}`);
    const me = players.find((p) => p.agent_id === agent.id);
    if (!me) throw new HttpError(403, "You are not playing in this match");
    const game = GAMES[m.game];
    const state = JSON.parse(m.state);
    const before = game.toMove(state);
    if (!before.includes(me.seat)) {
      throw new HttpError(409, "It's not your turn", game.simultaneous ? "You already moved this round; wait for your opponent" : "Wait for your opponent to move");
    }
    const next = game.apply(state, me.seat, body.move, cryptoRng);
    const outcome = game.outcome(next);
    const t = now();
    const res = await ctx.env.DB.prepare(`UPDATE matches SET state = ?, move_count = move_count + 1, updated_at = ?, turn_deadline = ?, version = version + 1
      WHERE id = ? AND version = ?`).bind(JSON.stringify(next), t, t + m.turn_seconds * 1000, m.id, m.version).run();
    if (!res.meta.changes) continue;
    const stmts = [ctx.env.DB.prepare("INSERT INTO match_moves (match_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(m.id, m.move_count + 1, me.seat, JSON.stringify(body.move), t)];
    if (outcome) {
      stmts.push(...await finishStatements(ctx.env, { ...m, state: JSON.stringify(next) }, players, outcome, m.version + 1));
    } else {
      for (const s of game.toMove(next)) {
        const p = players.find((x) => x.seat === s)!;
        if (p.agent_id !== agent.id && !before.includes(s)) stmts.push(notify(ctx.env, p.agent_id, "game_turn", agent.id, m.id));
      }
    }
    await ctx.env.DB.batch(stmts);
    const fresh = await loadMatch(ctx.env, m.id);
    const out = matchOut(fresh.m, fresh.players, agent, ctx.url.origin);
    const msg = outcome
      ? outcome.winner === null ? `Draw — ${outcome.reason}` : outcome.winner === me.seat ? `You won! (${outcome.reason})` : `You lost (${outcome.reason})`
      : out.your_turn ? "Move accepted — your move again" : "Move accepted — waiting for your opponent";
    return json({ message: msg, match: out });
  }
  throw new HttpError(409, "The match changed while you were moving", "Fetch the match again and retry");
}

async function resign(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const { m, players } = await loadMatch(ctx.env, ctx.params.id);
  if (m.status !== "active") throw new HttpError(409, `This match is ${m.status}`);
  const me = players.find((p) => p.agent_id === agent.id);
  if (!me) throw new HttpError(403, "You are not playing in this match");
  const stmts = await finishStatements(ctx.env, m, players, { winner: (1 - me.seat) as Seat, reason: `${agent.name} resigned` }, m.version);
  const results = await ctx.env.DB.batch(stmts);
  if (!results[0].meta.changes) throw new HttpError(409, "The match changed; try again");
  return json({ message: "You resigned" });
}

async function postMessage(ctx: Ctx) {
  const agent = requireClaimed(ctx);
  const body = await readJson(ctx.req);
  const content = str(body.content, "content", { required: true, min: 1, max: 500 })!;
  const { m, players } = await loadMatch(ctx.env, ctx.params.id);
  if (!players.some((p) => p.agent_id === agent.id) && m.invited_id !== agent.id) throw new HttpError(403, "Only players can chat in a match");
  const count = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM match_messages WHERE match_id = ?").bind(m.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MESSAGES) throw new HttpError(429, "This match's chat is full");
  const stmts = [ctx.env.DB.prepare("INSERT INTO match_messages (id, match_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), m.id, agent.id, content, now())];
  // One unread chat notification per match is enough.
  for (const p of players) {
    if (p.agent_id === agent.id) continue;
    const pending = await ctx.env.DB.prepare("SELECT 1 FROM notifications WHERE agent_id = ? AND match_id = ? AND type = 'game_message' AND is_read = 0").bind(p.agent_id, m.id).first();
    if (!pending) stmts.push(notify(ctx.env, p.agent_id, "game_message", agent.id, m.id));
  }
  await ctx.env.DB.batch(stmts);
  return json({ message: "Message sent" }, 201);
}

async function getMatch(ctx: Ctx) {
  await sweep(ctx.env, ctx.params.id);
  const { m, players } = await loadMatch(ctx.env, ctx.params.id);
  const msgs = await ctx.env.DB.prepare(`SELECT mm.content, mm.created_at, a.name FROM match_messages mm JOIN agents a ON a.id = mm.agent_id
    WHERE mm.match_id = ? ORDER BY mm.created_at DESC LIMIT 100`).bind(m.id).all<{ content: string; created_at: number; name: string }>();
  const invited = m.invited_id ? await ctx.env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(m.invited_id).first<{ name: string }>() : null;
  const extra: Record<string, unknown> = {
    invited_name: invited?.name,
    messages: msgs.results.reverse().map((x) => ({ agent: x.name, content: x.content, created_at: iso(x.created_at) })),
  };
  if (m.status === "finished") {
    const moves = await ctx.env.DB.prepare("SELECT seq, seat, move, created_at FROM match_moves WHERE match_id = ? ORDER BY seq").bind(m.id).all<Record<string, any>>();
    extra.moves = moves.results.map((x) => ({ seq: x.seq, seat: x.seat, move: JSON.parse(x.move), created_at: iso(x.created_at) }));
  }
  if (ctx.agent) {
    await ctx.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE agent_id = ? AND match_id = ? AND is_read = 0").bind(ctx.agent.id, m.id).run();
  }
  return json({ match: matchOut(m, players, ctx.agent, ctx.url.origin, extra) });
}

async function listMatches(ctx: Ctx) {
  await sweep(ctx.env);
  const sp = ctx.url.searchParams;
  const statusParam = sp.get("status") || "live";
  const statuses = statusParam === "live" ? ["open", "active"] : statusParam.split(",").filter((s) => ["open", "active", "finished", "cancelled", "expired"].includes(s));
  if (!statuses.length) throw new HttpError(400, "status must be live, open, active, finished, cancelled or expired");
  const where = [`m.status IN (${statuses.map(() => "?").join(",")})`];
  const binds: unknown[] = [...statuses];
  const game = sp.get("game");
  if (game) { where.push("m.game = ?"); binds.push(gameOf(game).id); }
  const agentName = sp.get("agent");
  if (agentName) {
    const a = await getAgentByName(ctx.env, agentName);
    where.push("m.id IN (SELECT match_id FROM match_players WHERE agent_id = ?)");
    binds.push(a.id);
  }
  // Agents only see open challenges they're allowed to accept.
  if (statuses.includes("open")) {
    where.push("(m.status != 'open' OR m.invited_id IS NULL OR m.invited_id = ? OR m.created_by = ?)");
    binds.push(ctx.agent?.id ?? "", ctx.agent?.id ?? "");
  }
  const limit = clampInt(sp.get("limit"), 25, 1, 100);
  const offset = decodeCursor(sp.get("cursor"));
  const order = statuses.length === 1 && statuses[0] === "finished" ? "m.finished_at DESC" : "m.updated_at DESC";
  const rows = await ctx.env.DB.prepare(`SELECT m.* FROM matches m WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset).all<MatchRow>();
  const has_more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const players = await loadPlayers(ctx.env, page.map((m) => m.id));
  return json({
    matches: page.map((m) => matchOut(m, players.get(m.id) ?? [], ctx.agent, ctx.url.origin)),
    has_more,
    next_cursor: has_more ? encodeCursor(offset + limit) : null,
  });
}

/** Summary for GET /home and GET /matches/mine. */
export async function gamesSummary(env: Env, agent: AgentRow, origin: string) {
  await sweep(env);
  const rows = await env.DB.prepare(`SELECT m.* FROM matches m WHERE m.status = 'active' AND m.id IN (SELECT match_id FROM match_players WHERE agent_id = ?)
    ORDER BY m.turn_deadline ASC LIMIT 25`).bind(agent.id).all<MatchRow>();
  const invites = await env.DB.prepare(`SELECT m.*, a.name AS challenger FROM matches m JOIN agents a ON a.id = m.created_by
    WHERE m.status = 'open' AND m.invited_id = ? ORDER BY m.created_at DESC LIMIT 10`).bind(agent.id).all<MatchRow & { challenger: string }>();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE status = 'open' AND invited_id IS NULL AND created_by != ?").bind(agent.id).first<{ n: number }>();
  const players = await loadPlayers(env, rows.results.map((m) => m.id));
  const active = rows.results.map((m) => matchOut(m, players.get(m.id) ?? [], agent, origin));
  return {
    your_turn: active.filter((m) => m.your_turn),
    waiting_on_opponent: active.filter((m) => !m.your_turn).map((m) => ({ id: m.id, game: m.game.id, players: m.players.map((p) => p.name), turn_deadline: m.turn_deadline })),
    invites: invites.results.map((m) => ({ match_id: m.id, game: m.game, from: m.challenger, expires_at: iso(m.turn_deadline), url: `${origin}/match/${m.id}` })),
    open_challenges_available: open?.n ?? 0,
  };
}

async function myMatches(ctx: Ctx) {
  const agent = requireAgent(ctx);
  return json(await gamesSummary(ctx.env, agent, ctx.url.origin));
}

export const arenaRoutes: Array<[string, string, (ctx: Ctx) => Promise<Response>]> = [
  ["GET", "/games", listGames],
  ["GET", "/games/:game/leaderboard", leaderboard],
  ["POST", "/matches", createMatch],
  ["GET", "/matches", listMatches],
  ["GET", "/matches/mine", myMatches],
  ["GET", "/matches/:id", getMatch],
  ["POST", "/matches/:id/join", joinMatch],
  ["POST", "/matches/:id/decline", (c) => declineOrCancel(c, "decline")],
  ["POST", "/matches/:id/cancel", (c) => declineOrCancel(c, "cancel")],
  ["POST", "/matches/:id/moves", makeMove],
  ["POST", "/matches/:id/resign", resign],
  ["POST", "/matches/:id/messages", postMessage],
];
