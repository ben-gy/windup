// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the three shapes a round of Windup can take.
 *
 * A mode must change how the game PLAYS, not just a number. The spread here:
 *
 *  - Skirmish  9x9,  8 rounds, 3 slots — a 3-minute knife fight. The arena is
 *              small enough that every bot is always in shoving range, so it is
 *              mostly a collision-prediction game.
 *  - Clockwork 11x11, 12 rounds, 3 slots — the default. Enough room to actually
 *              plan a route, enough rounds for a centre cog to ripen to 5 and
 *              become worth crossing the board for.
 *  - Gauntlet  13x13, 16 rounds, 4 slots — FOUR program slots, not three. That
 *              is the real difference: a 4-step program is a materially harder
 *              thing to predict (and to survive), because the board has two more
 *              steps to diverge from your plan before it ends.
 *
 * Sizes are ODD on purpose. The board is generated with 90-degree rotational
 * symmetry, and only an odd board has a true centre tile — the rotation's fixed
 * point, which is where the contested centre cog sits.
 */

export interface Mode {
  id: string;
  name: string;
  /** One line, player-facing. */
  blurb: string;
  /** Board is size x size. Must be ODD (see above) and >= 7. */
  size: number;
  /** Rounds in a match. */
  rounds: number;
  /** Cards per program. */
  slots: number;
  /** Cards dealt each round. */
  hand: number;
  /** A cog stops ripening here. */
  ripeCap: number;
  /** Spawn a 4-cog symmetric orbit on rounds where (round % orbitEvery) === 1. */
  orbitEvery: number;
  /** Spawn a centre cog on rounds where (round % centreEvery) === 0. */
  centreEvery: number;
  /** Seconds to plan a round before the host resolves without you. */
  planSecs: number;
}

export const MODES: Record<string, Mode> = {
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    blurb: '9×9 · 8 rounds · 3 slots — close quarters, constant shoving.',
    size: 9,
    rounds: 8,
    slots: 3,
    hand: 5,
    ripeCap: 5,
    orbitEvery: 2,
    centreEvery: 3,
    planSecs: 30,
  },
  clockwork: {
    id: 'clockwork',
    name: 'Clockwork',
    blurb: '11×11 · 12 rounds · 3 slots — the classic. Room to plan a route.',
    size: 11,
    rounds: 12,
    slots: 3,
    hand: 5,
    ripeCap: 5,
    orbitEvery: 2,
    centreEvery: 3,
    planSecs: 35,
  },
  gauntlet: {
    id: 'gauntlet',
    name: 'Gauntlet',
    blurb: '13×13 · 16 rounds · 4 slots — longer programs, deeper chaos.',
    size: 13,
    rounds: 16,
    slots: 4,
    hand: 6,
    ripeCap: 6,
    orbitEvery: 2,
    centreEvery: 4,
    planSecs: 45,
  },
};

export const DEFAULT_MODE = MODES.clockwork;

export const MODE_LIST: Mode[] = [MODES.skirmish, MODES.clockwork, MODES.gauntlet];

/**
 * Resolve a mode id that arrived off the wire or out of storage.
 *
 * `MODES[id] || DEFAULT` is a trap: 'constructor' and 'toString' are truthy
 * inherited properties, so an untrusted id can hand the generator an object with
 * no `size`. Object.hasOwn is the guard, and an unknown id falls back rather
 * than reaching the board generator as undefined.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return DEFAULT_MODE;
}
