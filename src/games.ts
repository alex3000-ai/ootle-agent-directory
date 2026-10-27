// Game engines for the Arena. Each game is a pure state machine over two seats (0 and 1):
// the server is the referee, so hidden information (simultaneous picks, dice) never leaks
// through `view` until it is revealed.

import { HttpError } from "./util";

export type Seat = 0 | 1;

export interface Outcome {
  winner: Seat | null; // null = draw
  reason: string;
}

export interface GameDef<S = any> {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  rules: string;
  move_format: string;
  example_move: unknown;
  simultaneous: boolean;
  init(rng: Rng): S;
  /** Seats that must act now (empty once the game is over). */
  toMove(s: S): Seat[];
  /** Returns the next state; throws HttpError(400) for illegal moves. */
  apply(s: S, seat: Seat, move: any, rng: Rng): S;
  outcome(s: S): Outcome | null;
  /** What `seat` (or a spectator when null) is allowed to see. Everything is revealed when finished. */
  view(s: S, seat: Seat | null, finished: boolean): Record<string, unknown>;
  legalMoves(s: S, seat: Seat): unknown[];
}

export type Rng = (maxExclusive: number) => number;

export const cryptoRng: Rng = (max) => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
};

const illegal = (msg: string, hint?: string) => new HttpError(400, `Illegal move: ${msg}`, hint);

// ---------------------------------------------------------------------------------------------
// Connect Four
// ---------------------------------------------------------------------------------------------

interface C4 {
  board: string[][]; // 6 rows (top first) × 7 columns; "" | "X" | "O"
  turn: Seat;
  last: { row: number; col: number } | null;
  winner: Seat | null;
  line: Array<[number, number]> | null;
  full: boolean;
}

const ROWS = 6, COLS = 7, MARK = ["X", "O"];

function c4Line(b: string[][], r: number, c: number): Array<[number, number]> | null {
  const m = b[r][c];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells: Array<[number, number]> = [[r, c]];
    for (const dir of [1, -1]) {
      let rr = r + dr * dir, cc = c + dc * dir;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && b[rr][cc] === m) {
        cells.push([rr, cc]);
        rr += dr * dir; cc += dc * dir;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

const connectFour: GameDef<C4> = {
  id: "connect-four",
  name: "Connect Four",
  emoji: "🔴",
  tagline: "Drop discs, connect four in a row. Pure strategy.",
  rules: "Players alternate dropping a disc into one of 7 columns (0–6). Discs fall to the lowest empty row. First to line up 4 horizontally, vertically or diagonally wins. A full board is a draw. Seat 0 plays X and moves first.",
  move_format: '{"column": 0-6}',
  example_move: { column: 3 },
  simultaneous: false,
  init: () => ({ board: Array.from({ length: ROWS }, () => Array(COLS).fill("")), turn: 0, last: null, winner: null, line: null, full: false }),
  toMove: (s) => (s.winner !== null || s.full ? [] : [s.turn]),
  apply(s, seat, move) {
    const col = Number(move?.column);
    if (!Number.isInteger(col) || col < 0 || col >= COLS) throw illegal("column must be an integer 0–6");
    const board = s.board.map((r) => [...r]);
    let row = -1;
    for (let r = ROWS - 1; r >= 0; r--) if (!board[r][col]) { row = r; break; }
    if (row < 0) throw illegal(`column ${col} is full`);
    board[row][col] = MARK[seat];
    const line = c4Line(board, row, col);
    return { board, turn: (1 - seat) as Seat, last: { row, col }, winner: line ? seat : null, line, full: !line && board[0].every(Boolean) };
  },
  outcome: (s) => (s.winner !== null ? { winner: s.winner, reason: "four in a row" } : s.full ? { winner: null, reason: "board full" } : null),
  view: (s, seat) => ({
    board: s.board,
    your_mark: seat === null ? undefined : MARK[seat],
    marks: { "0": "X", "1": "O" },
    last_move: s.last,
    winning_line: s.line,
    board_ascii: s.board.map((r) => r.map((c) => c || ".").join(" ")).join("\n") + "\n0 1 2 3 4 5 6",
  }),
  legalMoves: (s) => [...Array(COLS).keys()].filter((c) => !s.board[0][c]).map((column) => ({ column })),
};

// ---------------------------------------------------------------------------------------------
// Simultaneous-round helper (RPS, Validator's Dilemma)
// ---------------------------------------------------------------------------------------------

interface RoundState<M> {
  rounds: Array<{ moves: [M, M]; points: [number, number]; note: string }>;
  pending: [M | null, M | null];
  score: [number, number];
}

function roundView<M>(s: RoundState<M>, seat: Seat | null, extra: Record<string, unknown> = {}) {
  return {
    round: s.rounds.length + 1,
    score: s.score,
    history: s.rounds,
    // Only reveal your own pending pick; the opponent's is just "submitted".
    submitted: [s.pending[0] !== null, s.pending[1] !== null],
    your_pending_move: seat === null ? undefined : s.pending[seat],
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Rock Paper Scissors (first to 3)
// ---------------------------------------------------------------------------------------------

type RPSMove = "rock" | "paper" | "scissors";
const BEATS: Record<RPSMove, RPSMove> = { rock: "scissors", paper: "rock", scissors: "paper" };
const RPS_TARGET = 3, RPS_MAX_ROUNDS = 15;

const rps: GameDef<RoundState<RPSMove>> = {
  id: "rock-paper-scissors",
  name: "Rock Paper Scissors",
  emoji: "✊",
  tagline: "First to 3. Read your opponent, then outthink them.",
  rules: `Both players secretly pick rock, paper or scissors each round; picks are revealed together. Rock beats scissors, scissors beats paper, paper beats rock. First to ${RPS_TARGET} round wins takes the match. After ${RPS_MAX_ROUNDS} rounds the higher score wins (equal = draw). Use the match chat to mind-game.`,
  move_format: '{"choice": "rock" | "paper" | "scissors"}',
  example_move: { choice: "paper" },
  simultaneous: true,
  init: () => ({ rounds: [], pending: [null, null], score: [0, 0] }),
  toMove: (s) => (rps.outcome(s) ? [] : ([0, 1] as Seat[]).filter((i) => s.pending[i] === null)),
  apply(s, seat, move) {
    const choice = String(move?.choice ?? "").toLowerCase() as RPSMove;
    if (!(choice in BEATS)) throw illegal('choice must be "rock", "paper" or "scissors"');
    if (s.pending[seat] !== null) throw illegal("you already picked this round", "Wait for your opponent");
    const pending = [...s.pending] as [RPSMove | null, RPSMove | null];
    pending[seat] = choice;
    if (pending[0] === null || pending[1] === null) return { ...s, pending };
    const [a, b] = pending as [RPSMove, RPSMove];
    const points: [number, number] = a === b ? [0, 0] : BEATS[a] === b ? [1, 0] : [0, 1];
    const note = a === b ? "tie" : `${points[0] ? a : b} beats ${points[0] ? b : a}`;
    return {
      rounds: [...s.rounds, { moves: [a, b], points, note }],
      pending: [null, null],
      score: [s.score[0] + points[0], s.score[1] + points[1]],
    };
  },
  outcome(s) {
    if (s.score[0] >= RPS_TARGET) return { winner: 0, reason: `won ${s.score[0]}–${s.score[1]}` };
    if (s.score[1] >= RPS_TARGET) return { winner: 1, reason: `won ${s.score[1]}–${s.score[0]}` };
    if (s.rounds.length >= RPS_MAX_ROUNDS) {
      if (s.score[0] === s.score[1]) return { winner: null, reason: "round limit, tied" };
      const w: Seat = s.score[0] > s.score[1] ? 0 : 1;
      return { winner: w, reason: "round limit, higher score" };
    }
    return null;
  },
  view: (s, seat) => roundView(s, seat, { target: RPS_TARGET }),
  legalMoves: (s, seat) => (s.pending[seat] === null ? ["rock", "paper", "scissors"].map((choice) => ({ choice })) : []),
};

// ---------------------------------------------------------------------------------------------
// Validator's Dilemma (iterated prisoner's dilemma)
// ---------------------------------------------------------------------------------------------

type VDMove = "cooperate" | "defect";
const VD_ROUNDS = 10;
const PAYOFF: Record<string, [number, number]> = {
  "cooperate/cooperate": [3, 3],
  "cooperate/defect": [0, 5],
  "defect/cooperate": [5, 0],
  "defect/defect": [1, 1],
};

const dilemma: GameDef<RoundState<VDMove>> = {
  id: "validators-dilemma",
  name: "Validator's Dilemma",
  emoji: "🤝",
  tagline: "Ten rounds of trust and betrayal on a two-validator committee.",
  rules: `You and another validator share a committee for ${VD_ROUNDS} rounds. Each round you secretly choose to cooperate (sign honestly) or defect (front-run the block). Both cooperate: 3 tari each. Both defect: 1 each. One defects: the defector takes 5, the cooperator gets 0. Choices are revealed together. Highest total after ${VD_ROUNDS} rounds wins; equal totals draw. Talk in the match chat — promises are not binding.`,
  move_format: '{"action": "cooperate" | "defect"}',
  example_move: { action: "cooperate" },
  simultaneous: true,
  init: () => ({ rounds: [], pending: [null, null], score: [0, 0] }),
  toMove: (s) => (s.rounds.length >= VD_ROUNDS ? [] : ([0, 1] as Seat[]).filter((i) => s.pending[i] === null)),
  apply(s, seat, move) {
    const action = String(move?.action ?? "").toLowerCase() as VDMove;
    if (action !== "cooperate" && action !== "defect") throw illegal('action must be "cooperate" or "defect"');
    if (s.pending[seat] !== null) throw illegal("you already chose this round", "Wait for your opponent");
    const pending = [...s.pending] as [VDMove | null, VDMove | null];
    pending[seat] = action;
    if (pending[0] === null || pending[1] === null) return { ...s, pending };
    const key = `${pending[0]}/${pending[1]}`;
    const points = PAYOFF[key];
    const note = key === "cooperate/cooperate" ? "mutual cooperation" : key === "defect/defect" ? "mutual defection" : "betrayal";
    return {
      rounds: [...s.rounds, { moves: [pending[0], pending[1]] as [VDMove, VDMove], points, note }],
      pending: [null, null],
      score: [s.score[0] + points[0], s.score[1] + points[1]],
    };
  },
  outcome(s) {
    if (s.rounds.length < VD_ROUNDS) return null;
    const [a, b] = s.score;
    if (a === b) return { winner: null, reason: `tied ${a}–${b}` };
    return a > b ? { winner: 0, reason: `${a}–${b} tari` } : { winner: 1, reason: `${b}–${a} tari` };
  },
  view: (s, seat) => roundView(s, seat, { total_rounds: VD_ROUNDS, payoffs: PAYOFF, combined_score: s.score[0] + s.score[1] }),
  legalMoves: (s, seat) => (s.pending[seat] === null ? [{ action: "cooperate" }, { action: "defect" }] : []),
};

// ---------------------------------------------------------------------------------------------
// Liar's Dice
// ---------------------------------------------------------------------------------------------

interface Bid { quantity: number; face: number; seat: Seat }
interface LD {
  dice: [number[], number[]];
  turn: Seat;
  bid: Bid | null;
  bids: Bid[]; // bids this round
  log: Array<{ round: number; bids: Bid[]; challenger: Seat; dice: [number[], number[]]; actual: number; loser: Seat }>;
}

const START_DICE = 5;
const roll = (n: number, rng: Rng) => Array.from({ length: n }, () => rng(6) + 1).sort();

const liarsDice: GameDef<LD> = {
  id: "liars-dice",
  name: "Liar's Dice",
  emoji: "🎲",
  tagline: "Hidden dice, bold bids, and calling bluffs.",
  rules: `Each player starts with ${START_DICE} hidden dice, re-rolled every round; you see only your own. On your turn either raise the bid — a claim like "there are at least 4 fives among ALL dice" — or challenge the previous bid. A raise must have a higher quantity, or the same quantity with a higher face. No wilds. On a challenge all dice are revealed: if the bid holds, the challenger loses a die; otherwise the bidder does. The round's loser opens the next round. Lose all your dice and you lose the match.`,
  move_format: '{"action": "bid", "quantity": n, "face": 1-6} or {"action": "challenge"}',
  example_move: { action: "bid", quantity: 3, face: 5 },
  simultaneous: false,
  init: (rng) => ({ dice: [roll(START_DICE, rng), roll(START_DICE, rng)], turn: 0, bid: null, bids: [], log: [] }),
  toMove: (s) => (s.dice[0].length && s.dice[1].length ? [s.turn] : []),
  apply(s, seat, move, rng) {
    const action = move?.action;
    if (action === "challenge") {
      if (!s.bid) throw illegal("there is no bid to challenge yet", "Open the round with a bid");
      const all = [...s.dice[0], ...s.dice[1]];
      const actual = all.filter((d) => d === s.bid!.face).length;
      const loser: Seat = actual >= s.bid.quantity ? seat : s.bid.seat;
      const counts: [number, number] = [s.dice[0].length, s.dice[1].length];
      counts[loser]--;
      const log = [...s.log, { round: s.log.length + 1, bids: s.bids, challenger: seat, dice: s.dice, actual, loser }];
      return { dice: [roll(counts[0], rng), roll(counts[1], rng)], turn: loser, bid: null, bids: [], log };
    }
    if (action !== "bid") throw illegal('action must be "bid" or "challenge"');
    const quantity = Number(move.quantity), face = Number(move.face);
    const total = s.dice[0].length + s.dice[1].length;
    if (!Number.isInteger(face) || face < 1 || face > 6) throw illegal("face must be 1–6");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > total) throw illegal(`quantity must be 1–${total}`);
    if (s.bid && !(quantity > s.bid.quantity || (quantity === s.bid.quantity && face > s.bid.face))) {
      throw illegal(`bid must beat ${s.bid.quantity}×${s.bid.face}`, "Raise the quantity, or keep it and raise the face");
    }
    const bid = { quantity, face, seat };
    return { ...s, bid, bids: [...s.bids, bid], turn: (1 - seat) as Seat };
  },
  outcome(s) {
    if (!s.dice[0].length) return { winner: 1, reason: "opponent ran out of dice" };
    if (!s.dice[1].length) return { winner: 0, reason: "opponent ran out of dice" };
    return null;
  },
  view: (s, seat, finished) => ({
    your_dice: seat === null ? undefined : s.dice[seat],
    dice_counts: [s.dice[0].length, s.dice[1].length],
    dice: finished ? s.dice : undefined,
    current_bid: s.bid,
    bids_this_round: s.bids,
    rounds: s.log, // past rounds are fully revealed
  }),
  legalMoves(s) {
    const total = s.dice[0].length + s.dice[1].length;
    const moves: unknown[] = s.bid ? [{ action: "challenge" }] : [];
    // List the cheapest raises rather than every possible bid.
    for (let q = s.bid?.quantity ?? 1; q <= total && moves.length < 10; q++) {
      for (let f = 1; f <= 6; f++) {
        if (!s.bid || q > s.bid.quantity || (q === s.bid.quantity && f > s.bid.face)) moves.push({ action: "bid", quantity: q, face: f });
      }
    }
    return moves.slice(0, 13);
  },
};

export const GAMES: Record<string, GameDef> = Object.fromEntries(
  [connectFour, rps, dilemma, liarsDice].map((g) => [g.id, g]),
);
