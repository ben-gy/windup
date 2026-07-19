/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * Windup's netcode broadcasts PROGRAMS, not truth. The board, the seating, the
 * cog spawns and every player's hand are DERIVED from the shared seed on each
 * peer independently; not one byte of any of them crosses the wire. That is only
 * safe while two peers holding the same seed compute byte-identical results.
 *
 * If that ever stops being true the failure is silent and total: two players
 * look at different boards while agreeing on the score, and nothing appears
 * broken until someone collects a cog the other player never saw. So this proves
 * determinism at both levels — the shared RNG itself, and everything game.ts
 * builds on top of it, up to and including a full replayed match.
 */

import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, pick, randInt, shuffle } from '@ben-gy/game-engine/rng';
import {
  ALL_CARDS,
  createGame,
  dealHand,
  generateBoard,
  resolveRound,
  standings,
  type Card,
  type GameState,
} from '../src/game';
import { MODES, MODE_LIST, type Mode } from '../src/modes';

const CLOCKWORK: Mode = MODES.clockwork;

// ── the generator itself ────────────────────────────────────────────────────

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 200 }, () => a())).toEqual(Array.from({ length: 200 }, () => b()));
  });

  it('produces an identical stream for the same string seed', () => {
    const a = makeRng('room-AB12');
    const b = makeRng('room-AB12');
    expect(Array.from({ length: 50 }, () => a())).toEqual(Array.from({ length: 50 }, () => b()));
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 20 }, makeRng(1));
    const b = Array.from({ length: 20 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays within [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and unsigned 32-bit', () => {
    const h = hashSeed('WINDUP-K7QP');
    expect(h).toBe(hashSeed('WINDUP-K7QP'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});

describe('shuffle / randInt / pick are deterministic per seed', () => {
  it('shuffles identically across two peers, and leaves the input alone', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const p1 = shuffle(makeRng('seed'), deck);
    const p2 = shuffle(makeRng('seed'), deck);
    expect(p1).toEqual(p2);
    // A true permutation, not a no-op — and the source array is untouched.
    expect([...p1].sort((x, y) => x - y)).toEqual(deck);
    expect(p1).not.toEqual(deck);
    expect(deck).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });

  it('randInt stays in range and matches across peers', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const x = randInt(a, 1, 6);
      expect(randInt(b, 1, 6)).toBe(x);
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(6);
    }
  });

  it('pick agrees across peers', () => {
    const a = makeRng('x');
    const b = makeRng('x');
    expect(pick(a, ALL_CARDS)).toBe(pick(b, ALL_CARDS));
  });
});

// ── the board: the thing two peers must literally see the same of ───────────

describe('generateBoard is derived, never transmitted', () => {
  it('gives two peers on the same seed a byte-identical board', () => {
    for (const seed of [0, 1, 42, 65535, 0xffffffff]) {
      for (const mode of MODE_LIST) {
        const host = generateBoard(seed, mode);
        const peer = generateBoard(seed, mode);
        // Uint8Array equality is element-wise here, which is exactly the
        // "same bytes" claim the netcode rests on.
        expect(host.tiles).toEqual(peer.tiles);
        expect(host.starts).toEqual(peer.starts);
        expect(host.spawnReps).toEqual(peer.spawnReps);
        expect(host.size).toBe(mode.size);
      }
    }
  });

  it('gives different seeds different boards', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, s) =>
        Array.from(generateBoard(s * 7919 + 1, CLOCKWORK).tiles).join(''),
      ),
    );
    // Not a strict guarantee — but 40 identical boards would mean the seed is
    // being ignored, which is precisely the bug worth catching here.
    expect(seen.size).toBeGreaterThan(35);
  });

  it('gives the same seed different boards per mode, since the mode sizes it', () => {
    const a = generateBoard(555, MODES.skirmish);
    const b = generateBoard(555, MODES.gauntlet);
    expect(a.size).not.toBe(b.size);
  });

  it('re-derives an identical board on a second call much later', () => {
    // A peer that joins late builds its board from the seed alone, with a
    // different call history behind it. Nothing may be carried in a closure.
    const first = generateBoard(31337, CLOCKWORK);
    for (let i = 0; i < 50; i++) generateBoard(i, MODES.skirmish);
    const later = generateBoard(31337, CLOCKWORK);
    expect(later.tiles).toEqual(first.tiles);
    expect(later.spawnReps).toEqual(first.spawnReps);
  });
});

// ── the deal ────────────────────────────────────────────────────────────────

describe('dealHand is a pure function of (seed, round, seat)', () => {
  it('deals two peers the identical hand', () => {
    for (const seed of [0, 7, 4242, 0xffffffff]) {
      for (let round = 1; round <= 6; round++) {
        for (let seat = 0; seat < 4; seat++) {
          expect(dealHand(seed, round, seat, CLOCKWORK)).toEqual(
            dealHand(seed, round, seat, CLOCKWORK),
          );
        }
      }
    }
  });

  it('deals each seat a different hand', () => {
    // Every seat drawing the same five cards would make the game a mirror match
    // and would also mean the seat is not reaching the hash.
    const hands = [0, 1, 2, 3].map((seat) => dealHand(99, 3, seat, CLOCKWORK).join(''));
    expect(new Set(hands).size).toBeGreaterThan(1);
  });

  it('deals each round a different hand', () => {
    const rounds = Array.from({ length: 12 }, (_, i) => dealHand(99, i + 1, 0, CLOCKWORK).join(''));
    expect(new Set(rounds).size).toBeGreaterThan(8);
  });

  it('deals the mode its hand size, and never fewer than 2 move cards', () => {
    const moves: Card[] = ['F1', 'F2', 'F3', 'B1'];
    for (const mode of MODE_LIST) {
      for (let seed = 0; seed < 60; seed++) {
        const hand = dealHand(seed, 1, 0, mode);
        expect(hand).toHaveLength(mode.hand);
        for (const c of hand) expect(ALL_CARDS).toContain(c);
        // A hand of pure turn cards is a round spent spinning on the spot, which
        // reads as the game being broken rather than as bad luck.
        expect(hand.filter((c) => moves.includes(c)).length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ── setup ───────────────────────────────────────────────────────────────────

describe('createGame agrees on every seat and every cog', () => {
  it('places identical bots and identical cogs for the same seed', () => {
    for (const seed of [0, 5, 12345, 0xffffffff]) {
      for (const players of [2, 3, 4]) {
        const host = createGame(seed, CLOCKWORK, players);
        const peer = createGame(seed, CLOCKWORK, players);
        expect(host.bots).toEqual(peer.bots);
        expect(host.cogs).toEqual(peer.cogs);
        expect(host.round).toBe(1);
        expect(host.bots).toHaveLength(players);
      }
    }
  });

  it('agrees on the THREE-player seating, which is drawn from the seed', () => {
    // Three seats cannot be placed symmetrically on a rotation-only board, so the
    // corners are dealt like a dealer button. That draw must land the same way on
    // every peer or the players are standing in different places.
    for (let seed = 0; seed < 50; seed++) {
      const host = createGame(seed, CLOCKWORK, 3);
      const peer = createGame(seed, CLOCKWORK, 3);
      expect(host.bots.map((b) => b.home)).toEqual(peer.bots.map((b) => b.home));
    }
  });

  it('opens the board with cogs already on it', () => {
    // An empty opening board is a dead first program.
    const g = createGame(1, CLOCKWORK, 2);
    expect(g.cogs.length).toBeGreaterThan(0);
    for (const c of g.cogs) expect(c.born).toBe(1);
  });
});

// ── the whole match ─────────────────────────────────────────────────────────

/** Deal every seat a hand and program the first `slots` cards of it. */
function programsFor(state: GameState): (Card | null)[][] {
  return state.bots.map((b) => {
    const hand = dealHand(state.seed, state.round, b.seat, state.mode);
    return hand.slice(0, state.mode.slots);
  });
}

/** Replay a whole match from a seed, returning everything a peer could disagree about. */
function replay(seed: number, mode: Mode, players: number) {
  let state = createGame(seed, mode, players);
  const trace: string[] = [];
  while (!state.over) {
    const res = resolveRound(state, programsFor(state));
    for (const step of res.steps) trace.push(JSON.stringify(step));
    trace.push(JSON.stringify(res.spawned));
    state = res.state;
  }
  return { scores: state.bots.map((b) => b.score), trace, state };
}

describe('a full match replays identically on two peers', () => {
  it('yields identical final scores from the same seed and programs', () => {
    for (const seed of [1, 2, 99, 4242]) {
      for (const players of [2, 3, 4]) {
        const host = replay(seed, CLOCKWORK, players);
        const peer = replay(seed, CLOCKWORK, players);
        expect(host.scores).toEqual(peer.scores);
        // Scores agreeing is not enough: two peers must agree on every EVENT,
        // or one of them watched a different animation of the same number.
        expect(host.trace).toEqual(peer.trace);
        expect(standings(host.state)).toEqual(standings(peer.state));
      }
    }
  });

  it('replays every mode identically', () => {
    for (const mode of MODE_LIST) {
      const a = replay(777, mode, 4);
      const b = replay(777, mode, 4);
      expect(a.trace).toEqual(b.trace);
      expect(a.scores).toEqual(b.scores);
    }
  });

  it('gives different seeds different matches', () => {
    const seen = new Set(
      Array.from({ length: 30 }, (_, s) => replay(s * 2654435761 + 1, CLOCKWORK, 4).trace.join('|')),
    );
    expect(seen.size).toBeGreaterThan(25);
  });

  it('leaves the previous state untouched, so a replay is repeatable', () => {
    // resolveRound clones. If it ever mutated in place, a peer re-resolving a
    // round (a rejoin, a rewind, the bot's lookahead) would diverge silently.
    const state = createGame(11, CLOCKWORK, 2);
    const before = JSON.stringify({ bots: state.bots, cogs: state.cogs, round: state.round });
    const first = resolveRound(state, programsFor(state));
    expect(JSON.stringify({ bots: state.bots, cogs: state.cogs, round: state.round })).toBe(before);
    const second = resolveRound(state, programsFor(state));
    expect(JSON.stringify(second.steps)).toBe(JSON.stringify(first.steps));
    expect(second.state.bots).toEqual(first.state.bots);
  });
});
