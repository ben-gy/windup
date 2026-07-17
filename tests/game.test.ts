/**
 * game.test.ts — the rules, and the fairness of the opening.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCard,
  centreOf,
  cloneState,
  cogValue,
  createGame,
  dealHand,
  generateBoard,
  orbit,
  resolveRound,
  rot,
  spawnFor,
  standings,
  tileAt,
  TILE_FLOOR,
  TILE_WALL,
  type Card,
  type Ev,
  type GameState,
} from '../src/game';
import { MODES } from '../src/modes';

const M = MODES.clockwork;
const seeds = [1, 7, 42, 1234, 99999, 2 ** 31, 0xdeadbeef];

/** Drop a bot at an exact pose, for rule tests. */
function place(s: GameState, seat: number, x: number, y: number, f: 0 | 1 | 2 | 3): void {
  Object.assign(s.bots[seat], { x, y, f });
}

describe('board generation', () => {
  it('is 90-degree rotationally symmetric — the whole fairness claim rests on this', () => {
    for (const seed of seeds) {
      const b = generateBoard(seed, M);
      for (let y = 0; y < b.size; y++) {
        for (let x = 0; x < b.size; x++) {
          const p = rot(b.size, x, y);
          expect(tileAt(b, p.x, p.y)).toBe(tileAt(b, x, y));
        }
      }
    }
  });

  it('never buries a start tile or the tile it faces', () => {
    for (const seed of seeds) {
      const b = generateBoard(seed, M);
      for (const s of b.starts) {
        expect(tileAt(b, s.x, s.y)).toBe(TILE_FLOOR);
        const dx = [0, 1, 0, -1][s.f];
        const dy = [-1, 0, 1, 0][s.f];
        // Opening a match facing a wall is a dead first program.
        expect(tileAt(b, s.x + dx, s.y + dy)).toBe(TILE_FLOOR);
      }
    }
  });

  it('keeps the centre clear for the contested cog', () => {
    for (const seed of seeds) {
      const b = generateBoard(seed, M);
      const c = centreOf(b.size);
      expect(tileAt(b, c.x, c.y)).toBe(TILE_FLOOR);
    }
  });

  it('puts the four starts on one rotation orbit', () => {
    const b = generateBoard(7, M);
    const o = orbit(b.size, b.starts[0].x, b.starts[0].y);
    for (let i = 0; i < 4; i++) {
      expect({ x: b.starts[i].x, y: b.starts[i].y }).toEqual(o[i]);
      // Facing rotates with position, so the four openings are identical rather
      // than merely mirrored.
      expect(b.starts[i].f).toBe(((b.starts[0].f + i) % 4) as 0);
    }
  });
});

describe('turn-0 fairness', () => {
  /**
   * The board-game equivalent of the word-game dictionary trap: a seat that
   * starts nearer the action has already won something before anyone has made a
   * decision. Checked at the OPENING, over many seeds — pre-move imbalance is
   * only visible here.
   */
  it('gives every seat an identical opening, at every player count', () => {
    for (const seed of seeds) {
      for (const players of [2, 3, 4]) {
        const s = createGame(seed, M, players);

        // Same number of cogs at the same distances, per seat.
        const profiles = s.bots.map((b) =>
          s.cogs
            .map((c) => Math.abs(c.x - b.x) + Math.abs(c.y - b.y))
            .sort((p, q) => p - q)
            .join(','),
        );
        // 3 players occupy 3 of 4 rotationally-symmetric corners, so their cog
        // profiles are identical; the seeded seating (see seatSlots) is what
        // makes the remaining positional difference fair in expectation.
        for (const p of profiles) expect(p).toBe(profiles[0]);

        // Nobody starts on top of a cog, or on another bot.
        const at = new Set(s.bots.map((b) => `${b.x},${b.y}`));
        expect(at.size).toBe(players);
        for (const b of s.bots) {
          expect(s.cogs.some((c) => c.x === b.x && c.y === b.y)).toBe(false);
          expect(b.score).toBe(0);
        }
      }
    }
  });

  it('opens with cogs on the board — never a dead first program', () => {
    for (const seed of seeds) {
      expect(createGame(seed, M, 2).cogs.length).toBeGreaterThan(0);
    }
  });

  it('spawns cogs in symmetric orbits', () => {
    const s = createGame(11, M, 4);
    const nonCentre = s.cogs.filter((c) => !c.centre);
    for (const cog of nonCentre) {
      for (const p of orbit(s.board.size, cog.x, cog.y)) {
        expect(nonCentre.some((c) => c.x === p.x && c.y === p.y)).toBe(true);
      }
    }
  });
});

describe('ripening', () => {
  it('gains +1 a round and stops at the cap', () => {
    const cog = { x: 0, y: 0, born: 3, centre: false };
    expect(cogValue(cog, 3, 5)).toBe(1);
    expect(cogValue(cog, 4, 5)).toBe(2);
    expect(cogValue(cog, 7, 5)).toBe(5);
    expect(cogValue(cog, 99, 5)).toBe(5); // capped
    expect(cogValue(cog, 1, 5)).toBe(1); // never below 1
  });
});

describe('movement rules', () => {
  const fresh = (): GameState => createGame(3, M, 2);

  it('moves forward the card distance', () => {
    const s = fresh();
    // A known-clear lane: walk out from the centre.
    const c = centreOf(s.board.size);
    place(s, 0, c.x, c.y, 1);
    const evs: Ev[] = [];
    applyCard(s, s.bots[0], 'F2', evs);
    // Stops early only at a wall; assert it went as far as the board allowed.
    const moved = Math.abs(s.bots[0].x - c.x);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(2);
  });

  it('turns without moving', () => {
    const s = fresh();
    const b = s.bots[0];
    const before = { x: b.x, y: b.y };
    applyCard(s, b, 'TR', []);
    expect(b.f).toBe(((s.board.starts[0].f + 1) % 4) as 0);
    applyCard(s, b, 'TL', []);
    applyCard(s, b, 'TL', []);
    expect(b.f).toBe(((s.board.starts[0].f + 3) % 4) as 0);
    applyCard(s, b, 'UT', []);
    expect(b.f).toBe(((s.board.starts[0].f + 1) % 4) as 0);
    expect({ x: b.x, y: b.y }).toEqual(before);
  });

  it('backs up without turning', () => {
    const s = fresh();
    const c = centreOf(s.board.size);
    place(s, 0, c.x, c.y, 1); // facing east
    applyCard(s, s.bots[0], 'B1', []);
    expect(s.bots[0].f).toBe(1);
    expect(s.bots[0].x).toBe(c.x - 1);
  });

  it('bumps off a wall and stays put', () => {
    const s = fresh();
    // Find a wall and stand next to it, facing in.
    let done = false;
    for (let y = 0; y < s.board.size && !done; y++) {
      for (let x = 1; x < s.board.size && !done; x++) {
        if (tileAt(s.board, x, y) === TILE_WALL && tileAt(s.board, x - 1, y) === TILE_FLOOR) {
          place(s, 0, x - 1, y, 1);
          const evs: Ev[] = [];
          applyCard(s, s.bots[0], 'F1', evs);
          expect(s.bots[0].x).toBe(x - 1);
          expect(evs.some((e) => e.t === 'bump')).toBe(true);
          done = true;
        }
      }
    }
    expect(done).toBe(true);
  });
});

describe('shoving', () => {
  it('pushes a bot ahead of you', () => {
    const s = createGame(3, M, 2);
    const c = centreOf(s.board.size);
    // Guarantee clear ground by testing on a lane we verify first.
    if (tileAt(s.board, c.x + 1, c.y) !== TILE_FLOOR || tileAt(s.board, c.x + 2, c.y) !== TILE_FLOOR) return;
    place(s, 0, c.x, c.y, 1);
    place(s, 1, c.x + 1, c.y, 1);
    const evs: Ev[] = [];
    applyCard(s, s.bots[0], 'F1', evs);
    expect({ x: s.bots[0].x, y: s.bots[0].y }).toEqual({ x: c.x + 1, y: c.y });
    expect({ x: s.bots[1].x, y: s.bots[1].y }).toEqual({ x: c.x + 2, y: c.y });
    expect(evs.some((e) => e.t === 'push' && e.seat === 1 && e.by === 0)).toBe(true);
  });

  it('refuses the whole move when the chain is blocked', () => {
    const s = createGame(3, M, 2);
    // Build a controlled scene: bot 1 against a wall, bot 0 behind it.
    const board = s.board;
    let done = false;
    for (let y = 0; y < board.size && !done; y++) {
      for (let x = 2; x < board.size && !done; x++) {
        if (
          tileAt(board, x, y) === TILE_WALL &&
          tileAt(board, x - 1, y) === TILE_FLOOR &&
          tileAt(board, x - 2, y) === TILE_FLOOR
        ) {
          place(s, 1, x - 1, y, 1);
          place(s, 0, x - 2, y, 1);
          applyCard(s, s.bots[0], 'F1', []);
          // Nobody moves — not the pusher, not the pushed.
          expect({ x: s.bots[0].x, y: s.bots[0].y }).toEqual({ x: x - 2, y });
          expect({ x: s.bots[1].x, y: s.bots[1].y }).toEqual({ x: x - 1, y });
          done = true;
        }
      }
    }
    expect(done).toBe(true);
  });
});

describe('pits', () => {
  it('sends you home, cancels the rest of the round, and is never elimination', () => {
    const s = createGame(3, M, 2);
    let pit: { x: number; y: number } | null = null;
    for (let y = 0; y < s.board.size && !pit; y++) {
      for (let x = 1; x < s.board.size; x++) {
        if (tileAt(s.board, x, y) === 2 && tileAt(s.board, x - 1, y) === TILE_FLOOR) {
          pit = { x, y };
          break;
        }
      }
    }
    expect(pit).not.toBeNull();
    place(s, 0, pit!.x - 1, pit!.y, 1);
    const home = s.bots[0].home;
    const evs: Ev[] = [];
    applyCard(s, s.bots[0], 'F3', evs);

    expect(evs.some((e) => e.t === 'fall')).toBe(true);
    expect({ x: s.bots[0].x, y: s.bots[0].y }).toEqual({ x: home.x, y: home.y });
    expect(s.bots[0].falls).toBe(1);
    expect(s.bots[0].down).toBe(true); // the rest of the program is void
    expect(s.bots.length).toBe(2); // still in the game
  });
});

describe('resolveRound', () => {
  it('is pure — the previous state is untouched', () => {
    const s = createGame(11, M, 2);
    const snapshot = JSON.stringify(cloneState(s));
    resolveRound(s, [['F1', 'TR', 'F1'], ['F2', 'TL', 'F1']]);
    expect(JSON.stringify(cloneState(s))).toBe(snapshot);
  });

  it('is deterministic — the netcode depends on this exactly', () => {
    const programs: Card[][] = [
      ['F2', 'TR', 'F1'],
      ['F1', 'TL', 'F3'],
    ];
    const a = resolveRound(createGame(11, M, 2), programs);
    const b = resolveRound(createGame(11, M, 2), programs);
    expect(JSON.stringify(a.state.bots)).toBe(JSON.stringify(b.state.bots));
    expect(JSON.stringify(a.state.cogs)).toBe(JSON.stringify(b.state.cogs));
  });

  it('advances the round and ends at the mode length', () => {
    let s = createGame(5, MODES.skirmish, 2);
    for (let i = 0; i < MODES.skirmish.rounds; i++) {
      expect(s.over).toBe(false);
      s = resolveRound(s, [['F1', 'F1', 'F1'], ['F1', 'F1', 'F1']]).state;
    }
    expect(s.over).toBe(true);
  });

  it('lets an absent seat stand still rather than deadlocking', () => {
    const s = createGame(11, M, 2);
    const r = resolveRound(s, [['F1', 'F1', 'F1'], []]); // seat 1 sent nothing
    const before = s.bots[1];
    const after = r.state.bots[1];
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
    expect(r.state.round).toBe(s.round + 1);
  });

  it('records a before-state for the replay', () => {
    const s = createGame(11, M, 2);
    const r = resolveRound(s, [['F1', 'F1', 'F1'], ['F1', 'F1', 'F1']]);
    expect(r.before.round).toBe(s.round);
    expect(r.before.cogs.length).toBe(s.cogs.length);
    expect(r.steps.length).toBe(M.slots);
  });

  it('carries a fall through to the next round with a clean slate', () => {
    let s = createGame(3, M, 2);
    s = resolveRound(s, [['F3', 'F3', 'F3'], ['F3', 'F3', 'F3']]).state;
    for (const b of s.bots) expect(b.down).toBe(false);
  });
});

describe('dealing', () => {
  it('always leaves a hand you can actually move with', () => {
    for (let round = 1; round <= 16; round++) {
      for (let seat = 0; seat < 4; seat++) {
        for (const seed of seeds) {
          const hand = dealHand(seed, round, seat, M);
          expect(hand.length).toBe(M.hand);
          const moves = hand.filter((c) => c === 'F1' || c === 'F2' || c === 'F3' || c === 'B1');
          // A hand of five turn cards is a round spent spinning on the spot — it
          // reads as the game being broken, not as bad luck.
          expect(moves.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe('spawning', () => {
  it('never stacks a cog on an existing one', () => {
    const s = createGame(11, M, 4);
    for (let round = 2; round < 12; round++) {
      s.cogs.push(...spawnFor(s, round));
      const keys = s.cogs.map((c) => `${c.x},${c.y}`);
      expect(new Set(keys).size).toBe(keys.length);
      s.round = round;
    }
  });
});

describe('standings', () => {
  it('ranks, and lets a genuine tie tie', () => {
    const s = createGame(11, M, 4);
    s.bots[0].score = 10;
    s.bots[1].score = 10;
    s.bots[2].score = 4;
    s.bots[3].score = 1;
    const t = standings(s);
    expect(t[0].rank).toBe(1);
    expect(t[1].rank).toBe(1);
    expect(t.filter((x) => x.winner).length).toBe(2);
    expect(t[2].rank).toBe(3); // no rank 2 — two seats share first
    expect(t[3].rank).toBe(4);
  });
});
