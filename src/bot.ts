/**
 * bot.ts — the opponent AI, and the balance sim's stand-in for a human.
 *
 * It enumerates every ordered program it could build from its hand (5-choose-3 =
 * 60, or Gauntlet's 6-choose-4 = 360) and scores each one, then plays the best.
 *
 * The lookahead deliberately IGNORES the other bots. That is a design choice,
 * not a shortcut: where the others will be is exactly the thing no player can
 * know either, so a bot that planned around it would be playing a different,
 * clairvoyant game and would make the balance sim lie. It also keeps the search
 * allocation-free — `simSolo` walks integers over the cog list rather than
 * cloning GameState, which is what lets tests/balance.test.ts run a few hundred
 * full matches inside a second.
 */

import {
  cogValue,
  DX,
  DY,
  TILE_PIT,
  TILE_WALL,
  tileAt,
  type Board,
  type Card,
  type Cog,
  type Facing,
  type GameState,
} from './game';
import { makeRng, type Rng } from './engine/rng';
import type { Mode } from './modes';

export type Skill = 'easy' | 'normal' | 'hard';

export interface SoloResult {
  gained: number;
  falls: number;
  x: number;
  y: number;
  f: Facing;
}

/**
 * Run a program for ONE bot on an otherwise-empty board. No allocation beyond
 * the taken-cog bitmask; called ~100k times a second by the sim.
 */
export function simSolo(
  board: Board,
  cogs: Cog[],
  start: { x: number; y: number; f: Facing },
  home: { x: number; y: number; f: Facing },
  program: (Card | null)[],
  round: number,
  cap: number,
  taken: boolean[],
): SoloResult {
  let { x, y, f } = start;
  let gained = 0;
  let falls = 0;
  taken.fill(false);

  const eat = (): void => {
    for (let i = 0; i < cogs.length; i++) {
      if (taken[i]) continue;
      if (cogs[i].x === x && cogs[i].y === y) {
        taken[i] = true;
        gained += cogValue(cogs[i], round, cap);
        return;
      }
    }
  };

  for (const card of program) {
    if (!card) continue;
    if (card === 'TL' || card === 'TR' || card === 'UT') {
      f = ((f + (card === 'TL' ? 3 : card === 'TR' ? 1 : 2)) % 4) as Facing;
      continue;
    }
    const steps = card === 'F1' ? 1 : card === 'F2' ? 2 : card === 'F3' ? 3 : 1;
    const dir = card === 'B1' ? (((f + 2) % 4) as Facing) : f;
    let dead = false;
    for (let i = 0; i < steps && !dead; i++) {
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (tileAt(board, nx, ny) === TILE_WALL) break;
      x = nx;
      y = ny;
      if (tileAt(board, nx, ny) === TILE_PIT) {
        falls++;
        x = home.x;
        y = home.y;
        f = home.f;
        dead = true; // a fall voids the rest of the round
        break;
      }
      eat();
    }
    if (dead) break;
  }

  return { gained, falls, x, y, f };
}

/** Every ordered selection of `k` cards from `hand`, as index tuples. */
export function programs(hand: Card[], k: number): Card[][] {
  const out: Card[][] = [];
  const used: boolean[] = hand.map(() => false);
  const cur: Card[] = [];
  const walk = (): void => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < hand.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(hand[i]);
      walk();
      cur.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}

/** Manhattan distance, the board's natural metric (no diagonals). */
const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(ax - bx) + Math.abs(ay - by);

export interface ChooseOpts {
  skill?: Skill;
  /** Seeded — the balance sim must be reproducible. */
  rng?: Rng;
}

/**
 * Pick a program for `seat`. Deterministic given the same state and rng.
 */
export function chooseProgram(
  state: GameState,
  seat: number,
  hand: Card[],
  home: { x: number; y: number; f: Facing },
  opts: ChooseOpts = {},
): Card[] {
  const skill = opts.skill ?? 'normal';
  const rng = opts.rng ?? makeRng(state.seed + state.round * 977 + seat);
  const mode: Mode = state.mode;
  const bot = state.bots[seat];
  const cands = programs(hand, Math.min(mode.slots, hand.length));
  const taken: boolean[] = state.cogs.map(() => false);

  let best: Card[] = cands[0] ?? [];
  let bestScore = -Infinity;

  for (const prog of cands) {
    const r = simSolo(
      state.board,
      state.cogs,
      { x: bot.x, y: bot.y, f: bot.f },
      home,
      prog,
      state.round,
      mode.ripeCap,
      taken,
    );

    // Cogs banked dominate. A fall costs a whole round's tempo, so it is priced
    // near a fat cog. The tail term is positional: end the round NEAR something
    // valuable, weighted by what it will be worth, so a bot that cannot reach a
    // cog this round still walks toward the ripening ones.
    let near = 0;
    for (const c of state.cogs) {
      const v = cogValue(c, state.round + 1, mode.ripeCap);
      near = Math.max(near, v * 2 - dist(r.x, r.y, c.x, c.y));
    }

    let score = r.gained * 12 - r.falls * 9 + near;
    if (skill === 'easy') score += rng() * 14; // routinely fumbles the best line
    else if (skill === 'normal') score += rng() * 3; // occasional near-miss
    // 'hard' plays it straight.

    if (score > bestScore) {
      bestScore = score;
      best = prog;
    }
  }

  return best;
}

const BOT_NAMES = ['Sprocket', 'Ratchet', 'Cogsworth', 'Flywheel', 'Gearbox', 'Piston'];

export function botName(i: number): string {
  return BOT_NAMES[i % BOT_NAMES.length];
}
