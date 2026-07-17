/**
 * game.ts — the entire Windup simulation, as pure functions.
 *
 * Nothing here touches the DOM, the network, the clock, or Math.random. That is
 * deliberate and load-bearing:
 *
 *  - It is what lets the netcode be a commit/resolve protocol instead of a
 *    snapshot stream. Every peer applies `resolveRound` to identical state with
 *    identical programs and gets identical bytes out, so there is nothing to
 *    reconcile. The host broadcasts the PROGRAMS; it does not broadcast truth.
 *  - It is what makes the balance sim (tests/balance.test.ts) possible at all.
 *    A few hundred bot-vs-bot games have to run in under a second, headless.
 *
 * Turn-0 fairness is structural rather than tuned. The board is generated with
 * 90-degree rotational symmetry and the start tiles are the four rotations of a
 * single point, so every seat's opening is identical up to rotation. Cogs spawn
 * in symmetric ORBITS (a seeded cell and its three rotations, all at once), plus
 * a contested centre cog on the rotation's fixed point. There is no board state
 * a seat can be lucky about.
 */

import { makeRng, type Rng } from './engine/rng';
import type { Mode } from './modes';

// ── types ───────────────────────────────────────────────────────────────────

/** N, E, S, W. Rotating the board 90 degrees clockwise adds 1 (mod 4). */
export type Facing = 0 | 1 | 2 | 3;

export type Card = 'F1' | 'F2' | 'F3' | 'B1' | 'TL' | 'TR' | 'UT';

export const ALL_CARDS: Card[] = ['F1', 'F2', 'F3', 'B1', 'TL', 'TR', 'UT'];

export const CARD_LABEL: Record<Card, string> = {
  F1: 'Forward 1',
  F2: 'Forward 2',
  F3: 'Forward 3',
  B1: 'Back up',
  TL: 'Turn left',
  TR: 'Turn right',
  UT: 'U-turn',
};

export const CARD_GLYPH: Record<Card, string> = {
  F1: '↑1',
  F2: '↑2',
  F3: '↑3',
  B1: '↓1',
  TL: '↰',
  TR: '↱',
  UT: '↻',
};

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;
export const TILE_PIT = 2;

export interface Pos {
  x: number;
  y: number;
}

export interface Start extends Pos {
  f: Facing;
}

export interface Board {
  size: number;
  /** size*size, row-major. TILE_FLOOR | TILE_WALL | TILE_PIT. */
  tiles: Uint8Array;
  /** The four rotationally-symmetric start tiles, seat order. */
  starts: Start[];
  /** Orbit representatives that are legal cog spawns (all 4 cells floor+free). */
  spawnReps: Pos[];
}

export interface Bot {
  seat: number;
  x: number;
  y: number;
  f: Facing;
  score: number;
  /** Cogs collected, for the results breakdown. */
  cogs: number;
  /** The fattest single cog taken — the story of the match, per player. */
  best: number;
  falls: number;
  /** True once this bot has fallen this round — the rest of its program is void. */
  down: boolean;
  /** Where this bot respawns. Fixed for the match, assigned by `seatSlots`. */
  home: Start;
}

export interface Cog {
  x: number;
  y: number;
  /** The round it appeared. Value ripens from here. */
  born: number;
  /** The centre cog sits on the rotation's fixed point and is worth chasing. */
  centre: boolean;
}

export interface GameState {
  seed: number;
  mode: Mode;
  board: Board;
  bots: Bot[];
  cogs: Cog[];
  /** 1-based. The round currently being planned. */
  round: number;
  over: boolean;
}

// ── events (the replay timeline + the juice) ────────────────────────────────

export type Ev =
  | { t: 'turn'; seat: number; f: Facing }
  | { t: 'move'; seat: number; from: Pos; to: Pos }
  | { t: 'push'; seat: number; by: number }
  | { t: 'bump'; seat: number }
  | { t: 'cog'; seat: number; x: number; y: number; value: number; centre: boolean }
  | { t: 'fall'; seat: number; x: number; y: number };

export interface Step {
  /** Which program slot this step ran. */
  slot: number;
  /** The card each seat played this step (null once a seat is down). */
  cards: (Card | null)[];
  events: Ev[];
}

export interface RoundResult {
  round: number;
  steps: Step[];
  /** Cogs that spawned at the END of this round, for the replay's final beat. */
  spawned: Cog[];
  /**
   * The board as the round OPENED. The replay needs it: it has to animate bots
   * across cogs that the round then removes, and drawing the after-state would
   * show them sliding over tiles that are already empty.
   */
  before: GameState;
  /** State after everything above. */
  state: GameState;
}

// ── geometry ────────────────────────────────────────────────────────────────

export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

/** Rotate a cell 90 degrees clockwise on a size x size board. */
export function rot(size: number, x: number, y: number): Pos {
  return { x: size - 1 - y, y: x };
}

export function centreOf(size: number): Pos {
  const c = (size - 1) / 2;
  return { x: c, y: c };
}

/** The 4 cells a cell maps to under repeated 90-degree rotation. */
export function orbit(size: number, x: number, y: number): Pos[] {
  const out: Pos[] = [{ x, y }];
  let p = { x, y };
  for (let i = 0; i < 3; i++) {
    p = rot(size, p.x, p.y);
    out.push(p);
  }
  return out;
}

const key = (p: Pos): number => p.y * 1000 + p.x;

export function tileAt(board: Board, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= board.size || y >= board.size) return TILE_WALL;
  return board.tiles[y * board.size + x];
}

// ── board generation ────────────────────────────────────────────────────────

/**
 * Which of the 4 symmetric start tiles each seat uses.
 *
 * Two players take OPPOSITE corners (0 and 2), not adjacent ones — adjacent
 * starts are symmetric to each other but not to the board's cog orbits, and a
 * head-to-head where one player starts nearer the action is exactly the turn-0
 * unfairness this whole design exists to rule out. Four players fill all four
 * corners. Both cases are perfectly symmetric and need no help.
 *
 * THREE players are the awkward case, and the sim caught it. The board's
 * symmetry group is rotation-only (a square grid has no 3-fold symmetry to
 * offer), so occupying 3 of 4 corners has NO symmetry mapping the first corner
 * onto the third: seat 2 measured a 38.1% win rate against an expected 33.3%
 * over 1200 matches — small, real, and impossible to tune away, because it is
 * geometry rather than a constant.
 *
 * So the seating is drawn from the shared seed, exactly like a dealer button:
 * each seat is equally likely to draw each corner, which equalises the seats in
 * expectation. It stays deterministic, so every peer computes the identical
 * assignment from the round's seed and nothing crosses the wire.
 */
export function seatSlots(players: number, seed: number): number[] {
  if (players <= 2) return [0, 2];
  if (players >= 4) return [0, 1, 2, 3];
  const rng = makeRng(seed ^ 0x5bf03635);
  const slots = [0, 1, 2, 3];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.slice(0, 3);
}

export function generateBoard(seed: number, mode: Mode): Board {
  const size = mode.size;
  const rng = makeRng(seed ^ 0x9e3779b9);
  const tiles = new Uint8Array(size * size).fill(TILE_FLOOR);

  // Starts: the orbit of one inset corner. Facing increments with the rotation
  // so the four openings are genuinely identical, not merely mirrored.
  const starts: Start[] = [];
  let sp: Pos = { x: 1, y: 1 };
  let sf: Facing = 1;
  for (let i = 0; i < 4; i++) {
    starts.push({ x: sp.x, y: sp.y, f: sf });
    sp = rot(size, sp.x, sp.y);
    sf = ((sf + 1) % 4) as Facing;
  }

  const centre = centreOf(size);
  // Tiles that must stay clear: the starts, the centre (the contested prize),
  // and a one-tile apron in front of each start so nobody opens facing a wall.
  const reserved = new Set<number>([key(centre)]);
  for (const s of starts) {
    reserved.add(key(s));
    reserved.add(key({ x: s.x + DX[s.f], y: s.y + DY[s.f] }));
  }

  // Features are placed one ORBIT at a time, so whatever one seat faces, all
  // four face. Density is tuned to leave the board open enough to route through.
  const cells = size * size;
  const featureOrbits = Math.floor((cells * 0.14) / 4);
  const reps = orbitReps(size);
  const shuffled = reps.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let placed = 0;
  for (const rep of shuffled) {
    if (placed >= featureOrbits) break;
    const cellsOfOrbit = orbit(size, rep.x, rep.y);
    if (cellsOfOrbit.some((c) => reserved.has(key(c)))) continue;
    const kind = rng() < 0.62 ? TILE_WALL : TILE_PIT;
    for (const c of cellsOfOrbit) tiles[c.y * size + c.x] = kind;
    placed++;
  }

  const board: Board = { size, tiles, starts, spawnReps: [] };
  board.spawnReps = legalSpawnReps(board, reserved);
  return board;
}

/** One canonical representative per rotation orbit (excluding the centre). */
function orbitReps(size: number): Pos[] {
  const seen = new Set<number>();
  const reps: Pos[] = [];
  const c = centreOf(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === c.x && y === c.y) continue;
      const k = key({ x, y });
      if (seen.has(k)) continue;
      const o = orbit(size, x, y);
      for (const p of o) seen.add(key(p));
      reps.push({ x, y });
    }
  }
  return reps;
}

/** Orbits whose four cells are all floor and none reserved — legal cog spawns. */
function legalSpawnReps(board: Board, reserved: Set<number>): Pos[] {
  const out: Pos[] = [];
  for (const rep of orbitReps(board.size)) {
    const o = orbit(board.size, rep.x, rep.y);
    if (o.every((p) => tileAt(board, p.x, p.y) === TILE_FLOOR && !reserved.has(key(p)))) {
      out.push(rep);
    }
  }
  return out;
}

// ── ripening ────────────────────────────────────────────────────────────────

/**
 * A cog nobody has taken gains +1 every round, capped.
 *
 * This is the whole balance lever, and it is a pure function of
 * (round - born) — no new state, so P2P sync is untouched. It makes the early
 * game small and the late game big: an early lead is worth ~1 point a cog, while
 * the board late is carpeted with 4s and 5s that can swing a match in one round.
 * That is the shape principle #18 asks for, achieved by making the late game
 * exciting rather than by capping the leader.
 */
export function cogValue(cog: Cog, round: number, cap: number): number {
  return Math.min(1 + Math.max(0, round - cog.born), cap);
}

// ── setup ───────────────────────────────────────────────────────────────────

export function createGame(seed: number, mode: Mode, players: number): GameState {
  const board = generateBoard(seed, mode);
  const slots = seatSlots(players, seed);
  const bots: Bot[] = slots.map((slot, seat) => {
    const s = board.starts[slot];
    return { seat, x: s.x, y: s.y, f: s.f, score: 0, cogs: 0, best: 0, falls: 0, down: false, home: s };
  });
  const state: GameState = { seed, mode, board, bots, cogs: [], round: 1, over: false };
  // Round 1 opens with cogs already on the board — an empty opening board would
  // be a dead first program.
  state.cogs.push(...spawnFor(state, 1));
  return state;
}

/** Where a bot respawns. Assigned at setup, so seating never has to be re-derived. */
export function startOf(state: GameState, seat: number): Start {
  return state.bots[seat].home;
}

/** The cogs that appear for a given round. Deterministic from (seed, round). */
export function spawnFor(state: GameState, round: number): Cog[] {
  const { board, mode } = state;
  const rng = makeRng(hash2(state.seed, round * 7919 + 13));
  const out: Cog[] = [];
  const taken = new Set<number>(state.cogs.map(key));

  if (round % mode.orbitEvery === 1 || mode.orbitEvery === 1) {
    const free = board.spawnReps.filter((rep) =>
      orbit(board.size, rep.x, rep.y).every((p) => !taken.has(key(p))),
    );
    if (free.length) {
      const rep = free[Math.floor(rng() * free.length)];
      for (const p of orbit(board.size, rep.x, rep.y)) {
        out.push({ x: p.x, y: p.y, born: round, centre: false });
      }
    }
  }

  if (round % mode.centreEvery === 0) {
    const c = centreOf(board.size);
    if (!taken.has(key(c)) && !out.some((g) => g.x === c.x && g.y === c.y)) {
      out.push({ x: c.x, y: c.y, born: round, centre: true });
    }
  }

  return out;
}

function hash2(a: number, b: number): number {
  let h = (a ^ 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ b, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}

// ── dealing ─────────────────────────────────────────────────────────────────

const DECK_WEIGHTS: [Card, number][] = [
  ['F1', 3],
  ['F2', 3],
  ['F3', 2],
  ['B1', 1],
  ['TL', 3],
  ['TR', 3],
  ['UT', 1],
];

const MOVES: Card[] = ['F1', 'F2', 'F3', 'B1'];
const isMove = (c: Card): boolean => MOVES.includes(c);

function drawCard(rng: Rng): Card {
  const total = DECK_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [card, w] of DECK_WEIGHTS) {
    r -= w;
    if (r < 0) return card;
  }
  return 'F1';
}

/**
 * Deal a seat's hand for a round. Deterministic from (seed, round, seat), so
 * every peer knows every hand without a byte crossing the wire.
 *
 * The floor of 2 move cards is not flavour: a hand of five turn cards is a round
 * spent spinning on the spot, which reads as the game being broken rather than
 * as bad luck.
 */
export function dealHand(seed: number, round: number, seat: number, mode: Mode): Card[] {
  const rng = makeRng(hash2(seed ^ 0x51ed270b, round * 131 + seat * 17));
  const hand: Card[] = [];
  for (let i = 0; i < mode.hand; i++) hand.push(drawCard(rng));
  for (let i = 0; hand.filter(isMove).length < 2 && i < hand.length; i++) {
    if (!isMove(hand[i])) hand[i] = MOVES[Math.floor(rng() * MOVES.length)];
  }
  return hand;
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * Seat priority for a given (round, slot).
 *
 * Priority matters — the bot that moves first in a step gets to do the shoving.
 * It rotates on every STEP, not every round, so over a match the advantage is
 * spread thin and evenly regardless of how many seats are filled. Seat win rate
 * is asserted in tests/balance.test.ts; if this ever drifts, that test is what
 * catches it.
 */
export function priorityOrder(round: number, slot: number, seats: number): number[] {
  const base = ((round - 1) * 31 + slot) % seats;
  const out: number[] = [];
  for (let i = 0; i < seats; i++) out.push((base + i) % seats);
  return out;
}

function botAt(bots: Bot[], x: number, y: number): Bot | undefined {
  return bots.find((b) => b.x === x && b.y === y);
}

/** Collect any cog on the tile a bot just entered. */
function collect(state: GameState, bot: Bot, events: Ev[]): void {
  const i = state.cogs.findIndex((c) => c.x === bot.x && c.y === bot.y);
  if (i < 0) return;
  const cog = state.cogs[i];
  const value = cogValue(cog, state.round, state.mode.ripeCap);
  bot.score += value;
  bot.cogs++;
  bot.best = Math.max(bot.best, value);
  state.cogs.splice(i, 1);
  events.push({ t: 'cog', seat: bot.seat, x: cog.x, y: cog.y, value, centre: cog.centre });
}

/** A bot that entered a pit: back to its start, and its round is over. */
function fall(state: GameState, bot: Bot, events: Ev[]): void {
  events.push({ t: 'fall', seat: bot.seat, x: bot.x, y: bot.y });
  const s = startOf(state, bot.seat);
  bot.falls++;
  bot.down = true;
  // The start tile can be occupied mid-round; the respawning bot shoves whoever
  // is loitering on its pad rather than stacking on top of them.
  const sitting = state.bots.find((b) => b !== bot && b.x === s.x && b.y === s.y);
  bot.x = s.x;
  bot.y = s.y;
  bot.f = s.f;
  if (sitting) shove(state, sitting, s.f, events, bot.seat);
  collect(state, bot, events);
}

/**
 * Move `bot` one tile in `dir`, pushing any chain of bots ahead of it.
 * Returns false (and moves nobody) if the chain is blocked by a wall or an edge.
 */
function shove(state: GameState, bot: Bot, dir: Facing, events: Ev[], by: number): boolean {
  const nx = bot.x + DX[dir];
  const ny = bot.y + DY[dir];
  if (tileAt(state.board, nx, ny) === TILE_WALL) return false;

  const blocker = botAt(state.bots, nx, ny);
  if (blocker && !shove(state, blocker, dir, events, by)) return false;

  const from = { x: bot.x, y: bot.y };
  bot.x = nx;
  bot.y = ny;
  events.push({ t: 'move', seat: bot.seat, from, to: { x: nx, y: ny } });
  if (by !== bot.seat) events.push({ t: 'push', seat: bot.seat, by });

  if (tileAt(state.board, nx, ny) === TILE_PIT) {
    fall(state, bot, events);
    return true;
  }
  collect(state, bot, events);
  return true;
}

/** Apply one card to one bot, generating events. */
export function applyCard(state: GameState, bot: Bot, card: Card, events: Ev[]): void {
  if (card === 'TL' || card === 'TR' || card === 'UT') {
    const delta = card === 'TL' ? 3 : card === 'TR' ? 1 : 2;
    bot.f = ((bot.f + delta) % 4) as Facing;
    events.push({ t: 'turn', seat: bot.seat, f: bot.f });
    return;
  }

  const steps = card === 'F1' ? 1 : card === 'F2' ? 2 : card === 'F3' ? 3 : 1;
  const dir = card === 'B1' ? (((bot.f + 2) % 4) as Facing) : bot.f;
  for (let i = 0; i < steps; i++) {
    if (bot.down) return;
    if (!shove(state, bot, dir, events, bot.seat)) {
      events.push({ t: 'bump', seat: bot.seat });
      return;
    }
  }
}

/** Deep-copy so resolution can be run speculatively (the bot AI does exactly that). */
export function cloneState(state: GameState): GameState {
  return {
    seed: state.seed,
    mode: state.mode,
    board: state.board, // immutable after generation
    bots: state.bots.map((b) => ({ ...b })),
    cogs: state.cogs.map((c) => ({ ...c })),
    round: state.round,
    over: state.over,
  };
}

/**
 * Resolve one round: every seat's program, executed simultaneously, one slot at
 * a time. THE function — the netcode's agreement, the bot's lookahead and the
 * balance sim all run through here.
 *
 * `programs[seat]` may be short or contain nulls; a missing card is simply a seat
 * standing still for that step, which is exactly what an absent player should do.
 */
export function resolveRound(prev: GameState, programs: (Card | null)[][]): RoundResult {
  const before = cloneState(prev);
  const state = cloneState(prev);
  for (const b of state.bots) b.down = false;

  const steps: Step[] = [];
  for (let slot = 0; slot < state.mode.slots; slot++) {
    const events: Ev[] = [];
    const cards: (Card | null)[] = state.bots.map(() => null);
    for (const seat of priorityOrder(state.round, slot, state.bots.length)) {
      const bot = state.bots[seat];
      if (bot.down) continue;
      const card = programs[seat]?.[slot] ?? null;
      if (!card) continue;
      cards[seat] = card;
      applyCard(state, bot, card, events);
    }
    steps.push({ slot, cards, events });
  }

  for (const b of state.bots) b.down = false;

  // Ripening happens implicitly (cogValue reads state.round), so advancing the
  // round is all it takes to make every cog on the board worth more.
  const spawned = spawnFor(state, state.round + 1);
  state.cogs.push(...spawned);
  state.round++;
  if (state.round > state.mode.rounds) state.over = true;

  return { round: prev.round, steps, spawned, before, state };
}

// ── outcome ─────────────────────────────────────────────────────────────────

export interface Standing {
  seat: number;
  score: number;
  cogs: number;
  best: number;
  falls: number;
  rank: number;
  winner: boolean;
}

/** Final table. Ties genuinely tie — both seats get rank 1 and winner: true. */
export function standings(state: GameState): Standing[] {
  const sorted = state.bots.slice().sort((a, b) => b.score - a.score || a.seat - b.seat);
  const best = sorted.length ? sorted[0].score : 0;
  const out: Standing[] = [];
  let rank = 0;
  let lastScore = Number.NaN;
  sorted.forEach((b, i) => {
    if (b.score !== lastScore) {
      rank = i + 1;
      lastScore = b.score;
    }
    out.push({
      seat: b.seat,
      score: b.score,
      cogs: b.cogs,
      best: b.best,
      falls: b.falls,
      rank,
      winner: b.score === best,
    });
  });
  return out;
}

/** Total value still sitting on the board — the "what everyone missed" number. */
export function cogsOnBoard(state: GameState): number {
  return state.cogs.reduce((s, c) => s + cogValue(c, state.round, state.mode.ripeCap), 0);
}
