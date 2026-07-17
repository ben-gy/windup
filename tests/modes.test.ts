/**
 * modes.test.ts — the three shapes a round of Windup can take.
 *
 * A mode sets the BOARD SIZE and the PROGRAM LENGTH, which makes it the most
 * dangerous setting in the game: if two peers ever disagree about it they
 * generate different boards off the same seed, and nothing looks wrong until the
 * scores stop making sense. So the table is pinned hard here, and modeOf() is
 * required to swallow anything unknown rather than let it reach the board
 * generator.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODES, MODE_LIST, modeOf, type Mode } from '../src/modes';
import { createGame, generateBoard, centreOf, tileAt, TILE_FLOOR } from '../src/game';

const IDS = ['skirmish', 'clockwork', 'gauntlet'];

describe('the mode table', () => {
  it('offers exactly three modes, and Clockwork is the default', () => {
    expect(Object.keys(MODES).sort()).toEqual([...IDS].sort());
    expect(MODE_LIST.map((m) => m.id)).toEqual(IDS);
    expect(DEFAULT_MODE).toBe(MODES.clockwork);
    expect(DEFAULT_MODE.id).toBe('clockwork');
  });

  it('keys every mode by its own id', () => {
    // A table whose key and id disagree makes modeOf() return a mode the caller
    // did not ask for, and the desync is invisible from the id alone.
    for (const [key, mode] of Object.entries(MODES)) expect(mode.id).toBe(key);
  });

  it('gives every mode a real board, clock and blurb', () => {
    for (const m of MODE_LIST) {
      expect(m.rounds).toBeGreaterThan(0);
      expect(m.slots).toBeGreaterThan(0);
      expect(m.hand).toBeGreaterThanOrEqual(m.slots);
      expect(m.ripeCap).toBeGreaterThan(1);
      expect(m.orbitEvery).toBeGreaterThan(0);
      expect(m.centreEvery).toBeGreaterThan(0);
      expect(m.planSecs).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.blurb.length).toBeGreaterThan(20);
    }
  });

  it('makes no two modes the same game', () => {
    // A mode has to pull a real lever, or it is a label on the same game. Compare
    // the axes that actually change how a round plays.
    const shapes = MODE_LIST.map((m) => `${m.size}|${m.rounds}|${m.slots}`);
    expect(new Set(shapes).size).toBe(MODE_LIST.length);
    // And each axis genuinely spreads, rather than one mode carrying the whole
    // difference while the other two are twins on that axis.
    expect(new Set(MODE_LIST.map((m) => m.size)).size).toBe(3);
    expect(new Set(MODE_LIST.map((m) => m.rounds)).size).toBe(3);
    expect(new Set(MODE_LIST.map((m) => m.slots)).size).toBeGreaterThan(1);
  });

  it('gives Gauntlet the longer program that is its whole point', () => {
    expect(MODES.gauntlet.slots).toBeGreaterThan(MODES.clockwork.slots);
    expect(MODES.gauntlet.hand).toBeGreaterThanOrEqual(MODES.gauntlet.slots);
  });

  it('sizes every board ODD and at least 7', () => {
    // The generator lays the board out with 90-degree rotational symmetry, and
    // only an odd board has a true centre tile — the rotation's fixed point,
    // where the contested centre cog sits. An even board has no such cell, so
    // centreOf() would land between tiles and the symmetry would be a lie.
    for (const m of MODE_LIST) {
      expect(m.size % 2, `${m.id} is ${m.size}x${m.size} — must be odd`).toBe(1);
      expect(m.size).toBeGreaterThanOrEqual(7);
    }
  });

  it('gives every mode a centre tile that is a real, free cell', () => {
    for (const m of MODE_LIST) {
      const c = centreOf(m.size);
      expect(Number.isInteger(c.x)).toBe(true);
      expect(Number.isInteger(c.y)).toBe(true);
      // The centre is reserved: it is the prize, so it must never be built over.
      const board = generateBoard(4242, m);
      expect(tileAt(board, c.x, c.y)).toBe(TILE_FLOOR);
    }
  });
});

describe('modeOf — nothing unknown reaches the board generator', () => {
  it('resolves each real id to itself', () => {
    for (const id of IDS) expect(modeOf(id).id).toBe(id);
    for (const id of IDS) expect(modeOf(id)).toBe(MODES[id]);
  });

  it('falls back to the default for anything it does not recognise', () => {
    // These arrive from a snapshot, a URL and localStorage respectively.
    for (const bad of [undefined, null, '', 'CLOCKWORK', 'chess', 42, {}, [], true]) {
      expect(modeOf(bad)).toBe(DEFAULT_MODE);
    }
  });

  it('does NOT hand back inherited properties as modes', () => {
    // `MODES[id] || DEFAULT` is the trap this guards. 'constructor' and
    // 'toString' are truthy INHERITED properties of every object literal, so an
    // untrusted id off the wire sails past the `||` and hands the generator a
    // Function where a Mode should be — `size` is undefined, the board is
    // `new Uint8Array(NaN)`, and the room dies for everyone in it.
    for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const m: Mode = modeOf(key);
      expect(m, `modeOf(${JSON.stringify(key)}) leaked a prototype member`).toBe(DEFAULT_MODE);
      // Assert the SHAPE too, not just the identity: a Mode-shaped object with
      // undefined fields is the actual failure, and it is what would reach the
      // generator.
      expect(typeof m.size).toBe('number');
      expect(m.size % 2).toBe(1);
      expect(typeof m.rounds).toBe('number');
      expect(typeof m.slots).toBe('number');
      expect(typeof m.id).toBe('string');
    }
  });

  it('survives every leaked id all the way through a real board', () => {
    // The end-to-end version of the guard: whatever arrives, a playable game
    // comes out the other side rather than a NaN-sized Uint8Array.
    for (const bad of ['constructor', 'toString', '__proto__', null, undefined, 42]) {
      const mode = modeOf(bad);
      const g = createGame(7, mode, 2);
      expect(g.board.tiles.length).toBe(mode.size * mode.size);
      expect(g.board.starts).toHaveLength(4);
      expect(g.bots).toHaveLength(2);
      expect(g.over).toBe(false);
    }
  });

  it('is not fooled by a prototype that has been polluted', () => {
    // Object.hasOwn is the guard precisely because it reads the OWN table, not
    // the chain. Prove that: plant a fake mode on the prototype and it must stay
    // invisible.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.sabotage = { id: 'sabotage', size: 4, rounds: 1, slots: 1 };
    try {
      expect('sabotage' in MODES).toBe(true); // it IS reachable via the chain
      expect(modeOf('sabotage')).toBe(DEFAULT_MODE); // and modeOf still refuses it
    } finally {
      delete proto.sabotage;
    }
  });
});

describe('a match takes its shape from its mode', () => {
  it('builds the board the mode asked for', () => {
    for (const m of MODE_LIST) {
      const g = createGame(1, m, 2);
      expect(g.board.size).toBe(m.size);
      expect(g.board.tiles).toHaveLength(m.size * m.size);
      expect(g.mode).toBe(m);
    }
  });

  it('starts every seat inside the board it was given', () => {
    for (const m of MODE_LIST) {
      const g = createGame(3, m, 4);
      for (const b of g.bots) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x).toBeLessThan(m.size);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeLessThan(m.size);
      }
    }
  });
});
