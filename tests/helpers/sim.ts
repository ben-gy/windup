/**
 * sim.ts — headless bot-vs-bot matches, for balance measurement.
 *
 * Deterministic: every match is a pure function of its seed. No Math.random, no
 * clock, no DOM. This is the referee — a balance change is only real if this
 * moves, and on this factory's past games nearly every confident story about
 * "why the leader compounds" turned out to be wrong when measured.
 */

import { chooseProgram, type Skill } from '../../src/bot';
import {
  cogsOnBoard,
  createGame,
  dealHand,
  resolveRound,
  startOf,
  standings,
  type Card,
  type GameState,
} from '../../src/game';
import { makeRng } from '../../src/engine/rng';
import type { Mode } from '../../src/modes';

export interface MatchResult {
  seed: number;
  players: number;
  /** Final score per seat. */
  scores: number[];
  /** Seats that tied for the win (usually one). */
  winners: number[];
  /**
   * Who led after each round, or -1 when the lead was tied. Index 0 = after
   * round 1. This is the raw material for the leader-predictiveness curve.
   */
  leaderAfter: number[];
  rounds: number;
  falls: number[];
  /**
   * The value of every cog collected, in order. This is the FEEL metric: if
   * every cog is eaten the round it spawns, they all read 1 and the ripening
   * mechanic — the entire point of the game — is decorative. A balance change
   * that fixes the win curve while flattening this has broken the game.
   */
  cogValues: number[];
  /** Value left uncollected at the final whistle. */
  leftOnBoard: number;
}

export function playMatch(
  seed: number,
  players: number,
  mode: Mode,
  skill: Skill = 'normal',
): MatchResult {
  let state: GameState = createGame(seed, mode, players);
  const rng = makeRng(seed ^ 0xbeef);
  const leaderAfter: number[] = [];
  const cogValues: number[] = [];
  let guard = 0;

  while (!state.over) {
    if (++guard > mode.rounds + 5) throw new Error('match failed to terminate');
    const programs: (Card | null)[][] = state.bots.map((b) => {
      const hand = dealHand(state.seed, state.round, b.seat, mode);
      const home = startOf(state, b.seat);
      return chooseProgram(state, b.seat, hand, home, { skill, rng });
    });
    const res = resolveRound(state, programs);
    for (const step of res.steps) {
      for (const ev of step.events) if (ev.t === 'cog') cogValues.push(ev.value);
    }
    state = res.state;

    const best = Math.max(...state.bots.map((b) => b.score));
    const leaders = state.bots.filter((b) => b.score === best);
    leaderAfter.push(leaders.length === 1 ? leaders[0].seat : -1);
  }

  const table = standings(state);
  return {
    seed,
    players,
    scores: state.bots.map((b) => b.score),
    winners: table.filter((s) => s.winner).map((s) => s.seat),
    leaderAfter,
    rounds: state.round - 1,
    falls: state.bots.map((b) => b.falls),
    cogValues,
    leftOnBoard: cogsOnBoard(state),
  };
}

export function runMatches(
  count: number,
  players: number,
  mode: Mode,
  skill: Skill = 'normal',
  seed0 = 1000,
): MatchResult[] {
  const out: MatchResult[] = [];
  for (let i = 0; i < count; i++) out.push(playMatch(seed0 + i * 2654435761, players, mode, skill));
  return out;
}

/**
 * P(the unique leader after round N is a winner). Ties for the lead are excluded
 * rather than counted as "behind" — bucketing tied positions as trailing is
 * exactly the artifact that produced a confidently wrong reading on hexbloom.
 */
export function leaderWinRate(results: MatchResult[], round: number): number | null {
  let sampled = 0;
  let won = 0;
  for (const r of results) {
    const leader = r.leaderAfter[round - 1];
    if (leader === undefined || leader < 0) continue;
    sampled++;
    if (r.winners.includes(leader)) won++;
  }
  return sampled === 0 ? null : won / sampled;
}

/** Win rate per seat, counting a shared win as a win for each tied seat. */
export function seatWinRates(results: MatchResult[], players: number): number[] {
  const wins = new Array(players).fill(0);
  for (const r of results) for (const w of r.winners) wins[w]++;
  return wins.map((w) => w / results.length);
}

/** A match where the winner more than doubled the runner-up. */
export function blowoutRate(results: MatchResult[]): number {
  let n = 0;
  for (const r of results) {
    const sorted = r.scores.slice().sort((a, b) => b - a);
    if (sorted.length < 2) continue;
    if (sorted[1] > 0 ? sorted[0] >= sorted[1] * 2 : sorted[0] > 0) n++;
  }
  return n / results.length;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}
