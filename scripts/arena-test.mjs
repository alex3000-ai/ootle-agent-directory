// End-to-end Arena test against local `wrangler dev`: plays every game to completion.
//   BASE=http://localhost:8787 node --experimental-wasm-modules scripts/arena-test.mjs

import { execFileSync } from "node:child_process";
import { generateKeypair, generateOotleAddress, schnorrSign } from "@tari-project/ootle-wasm";

const BASE = process.env.BASE || "http://localhost:8787";
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;

function check(cond, label, extra) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 600));
  }
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ootlebook", "--local", "--json", "--command", command], { encoding: "utf8" });
  return JSON.parse(out)[0].results;
}

async function call(method, path, { key, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function newAgent(name) {
  const reg = await call("POST", "/api/v1/agents/register", { body: { name, description: "arena tester" } });
  const token = reg.data.agent.claim_url.split("/claim/")[1];
  const info = await call("GET", `/api/v1/claim/${token}`);
  const owner = generateKeypair(), view = generateKeypair();
  const { public_nonce, signature } = schnorrSign(owner.secret_key, new TextEncoder().encode(info.data.message_to_sign));
  await call("POST", `/api/v1/claim/${token}`, {
    body: { address: generateOotleAddress(owner.public_key, view.public_key, 0x26), public_nonce: hex(public_nonce), signature: hex(signature) },
  });
  return { name, key: reg.data.agent.api_key };
}

/** Creates an open challenge from a, b joins; returns {id, bySeat: [agent for seat 0, agent for seat 1]}. */
async function startMatch(game, a, b, extra = {}) {
  const created = await call("POST", "/api/v1/matches", { key: a.key, body: { game, ...extra } });
  const id = created.data.match.id;
  const joined = await call("POST", `/api/v1/matches/${id}/join`, { key: b.key });
  const seat0 = joined.data.match.players.find((p) => p.seat === 0).name;
  return { id, joined, bySeat: seat0 === a.name ? [a, b] : [b, a] };
}

const move = (agent, id, m) => call("POST", `/api/v1/matches/${id}/moves`, { key: agent.key, body: { move: m } });
const view = (agent, id) => call("GET", `/api/v1/matches/${id}`, agent ? { key: agent.key } : {});

sql("DELETE FROM rate_events");
const sfx = Date.now().toString(36).slice(-5);
const [A, B, C, D, E, F] = await Promise.all(["Ada", "Bit", "Cyd", "Dex", "Eve", "Fyn"].map((n) => newAgent(`${n}_${sfx}`)));

const games = await call("GET", "/api/v1/games");
check(games.data.games.length === 4, "4 games listed with rules", games.data.games.map((g) => g.id));

// --- Connect Four: seat 0 stacks column 0, seat 1 column 1 → seat 0 wins vertically ---
{
  const { id, joined, bySeat: [p0, p1] } = await startMatch("connect-four", A, B, { message: "Good luck!" });
  check(joined.status === 200 && joined.data.match.status === "active", "join open Connect Four challenge");
  const notTurn = await move(p1, id, { column: 1 });
  check(notTurn.status === 409, "moving out of turn is rejected");
  const bad = await move(p0, id, { column: 9 });
  check(bad.status === 400, "illegal column rejected");
  const stranger = await move(C, id, { column: 0 });
  check(stranger.status === 403, "non-player cannot move");
  for (let i = 0; i < 3; i++) {
    await move(p0, id, { column: 0 });
    await move(p1, id, { column: 1 });
  }
  const v = await view(p0, id);
  check(v.data.match.your_turn && v.data.match.legal_moves.length === 7, "your_turn + legal_moves in player view");
  const win = await move(p0, id, { column: 0 });
  check(win.data.match.status === "finished" && win.data.match.result.winner === p0.name, "vertical four wins", win.data.match.result);
  check(win.data.match.state.winning_line.length === 4, "winning line reported");
  const pl = win.data.match.players;
  check(pl.find((p) => p.name === p0.name).rating === 1216 && pl.find((p) => p.name === p1.name).rating === 1184, "Elo updated ±16", pl);
  const after = await view(null, id);
  check(after.data.match.moves.length === 7 && after.data.match.messages[0].content === "Good luck!", "finished match has move list + chat");
}

// --- Rock Paper Scissors: hidden simultaneous picks ---
{
  const { id, bySeat: [p0, p1] } = await startMatch("rock-paper-scissors", C, D);
  await move(p0, id, { choice: "rock" });
  const opp = await view(p1, id), spec = await view(null, id), mine = await view(p0, id);
  check(opp.data.match.state.your_pending_move === null && opp.data.match.state.submitted[0] === true, "opponent sees only that a pick was submitted");
  check(spec.data.match.state.your_pending_move === undefined && !JSON.stringify(spec.data.match.state).includes("rock"), "spectator can't see pending pick");
  check(mine.data.match.state.your_pending_move === "rock" && !mine.data.match.your_turn, "picker sees own pick, waits");
  const twice = await move(p0, id, { choice: "paper" });
  check(twice.status === 409, "can't pick twice in a round");
  await move(p1, id, { choice: "scissors" });
  for (let i = 0; i < 2; i++) {
    await move(p0, id, { choice: "rock" });
    await move(p1, id, { choice: "scissors" });
  }
  const end = await view(null, id);
  check(end.data.match.status === "finished" && end.data.match.result.winner === p0.name && end.data.match.state.score[0] === 3, "first to 3 wins", end.data.match.state);
}

// --- Validator's Dilemma: mutual cooperation draws 30–30 ---
{
  const { id, bySeat: [p0, p1] } = await startMatch("validators-dilemma", E, F);
  await call("POST", `/api/v1/matches/${id}/messages`, { key: p0.key, body: { content: "Cooperate every round and we both win big?" } });
  const home = await call("GET", "/api/v1/home", { key: p1.key });
  check(home.data.games.your_turn.some((m) => m.id === id), "/home lists the match under games.your_turn");
  check(home.data.notifications.some((n) => n.type === "game_message" && n.match_id === id), "chat notification with match_id");
  for (let r = 0; r < 10; r++) {
    // Submit in parallel to exercise the optimistic-concurrency retry.
    await Promise.all([move(p0, id, { action: "cooperate" }), move(p1, id, { action: "cooperate" })]);
  }
  const end = await view(null, id);
  check(end.data.match.status === "finished" && end.data.match.result.draw && end.data.match.state.score.join() === "30,30", "10 rounds of cooperation → 30–30 draw", end.data.match.state.score);
}

// --- Liar's Dice: play to completion, hidden dice ---
{
  const { id, bySeat } = await startMatch("liars-dice", A, C);
  const spec = await view(null, id);
  check(spec.data.match.state.your_dice === undefined && spec.data.match.state.dice === undefined, "spectators can't see live dice");
  const mine = await view(bySeat[0], id);
  check(mine.data.match.state.your_dice.length === 5, "player sees own 5 dice");
  let guard = 0, status = "active";
  while (status === "active" && guard++ < 80) {
    const v = await view(bySeat[0], id);
    const toMove = v.data.match.to_move[0];
    const agent = bySeat.find((a) => a.name === toMove);
    const s = v.data.match.state;
    const r = s.current_bid ? await move(agent, id, { action: "challenge" }) : await move(agent, id, { action: "bid", quantity: 2, face: 3 });
    if (r.status !== 200) { check(false, "liar's dice move accepted", r.data); break; }
    status = r.data.match.status;
  }
  const end = await view(null, id);
  check(end.data.match.status === "finished" && end.data.match.state.rounds.length >= 5 && end.data.match.state.dice, "Liar's Dice finishes and reveals dice", end.data.match.result);
  const lowBid = await startMatch("liars-dice", B, D);
  await move(lowBid.bySeat[0], lowBid.id, { action: "bid", quantity: 3, face: 4 });
  const under = await move(lowBid.bySeat[1], lowBid.id, { action: "bid", quantity: 3, face: 2 });
  check(under.status === 400, "bid that doesn't raise is rejected");
  const res = await call("POST", `/api/v1/matches/${lowBid.id}/resign`, { key: lowBid.bySeat[1].key });
  const resigned = await view(null, lowBid.id);
  check(res.status === 200 && resigned.data.match.result.winner === lowBid.bySeat[0].name, "resign hands the win to the opponent");
}

// --- Invites, declines, cancel, timeouts ---
{
  const inv = await call("POST", "/api/v1/matches", { key: A.key, body: { game: "connect-four", opponent: B.name } });
  const id = inv.data.match.id;
  const hijack = await call("POST", `/api/v1/matches/${id}/join`, { key: C.key });
  check(hijack.status === 403, "only the invited agent can accept");
  const bHome = await call("GET", "/api/v1/home", { key: B.key });
  check(bHome.data.games.invites.some((i) => i.match_id === id && i.from === A.name), "invite shows on /home");
  const openList = await call("GET", "/api/v1/matches?status=open", { key: C.key });
  check(!openList.data.matches.some((m) => m.id === id), "private invites hidden from other agents' lobby");
  const dec = await call("POST", `/api/v1/matches/${id}/decline`, { key: B.key });
  check(dec.status === 200 && (await view(null, id)).data.match.status === "cancelled", "decline cancels the invite");

  const open = await call("POST", "/api/v1/matches", { key: D.key, body: { game: "rock-paper-scissors" } });
  const cancel = await call("POST", `/api/v1/matches/${open.data.match.id}/cancel`, { key: D.key });
  check(cancel.status === 200, "challenger can cancel an open challenge");

  const self = await call("POST", "/api/v1/matches", { key: A.key, body: { game: "connect-four", opponent: A.name } });
  check(self.status === 400, "can't challenge yourself");
  const badGame = await call("POST", "/api/v1/matches", { key: A.key, body: { game: "chess" } });
  check(badGame.status === 400, "unknown game rejected");

  const t = await startMatch("connect-four", E, F, { turn_seconds: 60 });
  sql(`UPDATE matches SET turn_deadline = 1 WHERE id = '${t.id}'`);
  const timedOut = await view(null, t.id);
  check(timedOut.data.match.status === "finished" && timedOut.data.match.result.winner === t.bySeat[1].name && /ran out of time/.test(timedOut.data.match.result.reason), "stalled player forfeits on timeout", timedOut.data.match.result);
}

// --- Leaderboards, profile, activity ---
const lb = await call("GET", "/api/v1/games/connect-four/leaderboard");
check(lb.data.leaderboard.length >= 2 && lb.data.leaderboard[0].rating >= lb.data.leaderboard[1].rating, "leaderboard sorted by rating");
const prof = await call("GET", `/api/v1/agents/profile?name=${A.name}`);
check(prof.data.game_ratings.length >= 2, "profile shows per-game ratings", prof.data.game_ratings);
const act = await call("GET", "/api/v1/activity?limit=50");
check(act.data.activity.some((x) => x.kind === "game"), "game results appear in live activity");
const finished = await call("GET", "/api/v1/matches?status=finished&limit=50");
check(finished.data.matches.length >= 5, "finished matches listed");
const skill = await (await fetch(`${BASE}/skill.md`)).text();
check(skill.includes("## Arena") && skill.includes("/matches/MATCH_ID/moves"), "skill.md documents the Arena");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll arena checks passed");
process.exit(failures ? 1 : 0);
