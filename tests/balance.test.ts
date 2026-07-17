/**
 * balance.test.ts — is it still a game on round 4?
 *
 * Every other test in this suite asks "does it work". This one asks whether the
 * match is already over before the player has made a real decision. That is
 * invisible to unit tests and to the 90 seconds you spend playing it yourself,
 * so it gets measured: a few hundred fixed-seed bot-vs-bot matches, asserting on
 * the SHAPE of the outcome.
 *
 * These numbers were baselined BEFORE any tuning, and they refereed the design:
 *
 *  - The 3-player seat bias below is real and was found here, not by reasoning.
 *    Rotation-only board symmetry has no map from corner 0 to corner 2, so seat 2
 *    won 38.1% against an expected 33.3% over 1200 matches. Seeded seating fixed
 *    it (36.3/33.9/36.0). No constant could have.
 *  - Sweeping ripeCap (3/5/7/9) and cog density said the shipped values were
 *    already the best of the bunch: a bigger cap only bought blowouts (25% ->
 *    31%), and carpeting the board with cogs cut blowouts to 18% but left 128
 *    points of uncollected value lying around — a cog buffet, not a contest.
 *
 * Bounds are set with headroom over the measured values so this fails on a real
 * regression rather than on sampling noise. The measured figure is quoted beside
 * each one; if you move a constant and a bound trips, the design changed.
 */

import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { priorityOrder, seatSlots } from '../src/game';
import { blowoutRate, leaderWinRate, mean, runMatches, seatWinRates } from './helpers/sim';

/** Ties count as a win for each tied seat, so the rates sum above 1. Normalise
 *  before comparing to 100/players or every seat looks inflated. */
function normalisedSeatRates(rates: number[]): number[] {
  const total = rates.reduce((a, b) => a + b, 0);
  return rates.map((r) => r / total);
}

describe('2-player balance', () => {
  const rs = runMatches(600, 2, MODES.clockwork);

  it('the early lead is close to a coin flip', () => {
    // Measured: r1 51%, r3 57%, r4 58%. Chance is 50%.
    expect(leaderWinRate(rs, 1)!).toBeLessThan(0.6);
    expect(leaderWinRate(rs, 3)!).toBeLessThan(0.66);
    expect(leaderWinRate(rs, 4)!).toBeLessThan(0.68);
  });

  it('the lead only becomes decisive near the end', () => {
    // The drama IS this curve: flat early, steep late. Measured r10 82%, r12 100%.
    expect(leaderWinRate(rs, 10)!).toBeGreaterThan(0.7);
    expect(leaderWinRate(rs, MODES.clockwork.rounds)!).toBe(1);
    // And it must actually RISE — a flat-to-the-end curve is a coin flip, not a game.
    expect(leaderWinRate(rs, 10)! - leaderWinRate(rs, 3)!).toBeGreaterThan(0.15);
  });

  it('neither seat is favoured', () => {
    // Measured 50.1 / 53.6 raw => ~48.3 / 51.7 normalised.
    const seats = normalisedSeatRates(seatWinRates(rs, 2));
    for (const s of seats) expect(Math.abs(s - 0.5)).toBeLessThan(0.06);
  });

  it('bounds blowouts', () => {
    // Measured 24%. A head-to-head where someone doubles up is allowed to happen,
    // but it must not be the norm.
    expect(blowoutRate(rs)).toBeLessThan(0.35);
  });

  it('every match terminates in exactly the mode length', () => {
    for (const r of rs) expect(r.rounds).toBe(MODES.clockwork.rounds);
  });
});

describe('4-player balance', () => {
  const rs = runMatches(500, 4, MODES.clockwork);

  it('the early lead is near chance', () => {
    // Measured r1 30%, r3 34%, r4 36%. Chance is 25%.
    expect(leaderWinRate(rs, 1)!).toBeLessThan(0.42);
    expect(leaderWinRate(rs, 4)!).toBeLessThan(0.48);
  });

  it('spikes late', () => {
    // Measured r8 62%, r10 75%.
    expect(leaderWinRate(rs, 10)!).toBeGreaterThan(0.6);
    expect(leaderWinRate(rs, MODES.clockwork.rounds)!).toBe(1);
  });

  it('every seat wins its share', () => {
    // The check that would have caught hexbloom's 3P seats sitting at 54/33/10.
    // Measured 27.4 / 26.9 / 26.8 / 27.0 raw — flat, because the board is
    // generated with 90-degree rotational symmetry and the starts are the four
    // rotations of one point.
    const seats = normalisedSeatRates(seatWinRates(rs, 4));
    for (const s of seats) expect(Math.abs(s - 0.25)).toBeLessThan(0.05);
  });

  it('bounds blowouts', () => {
    expect(blowoutRate(rs)).toBeLessThan(0.2); // measured 8%
  });
});

describe('3-player balance', () => {
  const rs = runMatches(600, 3, MODES.clockwork);

  /**
   * THE regression guard for the one real bias the sim found — and it asserts
   * the MECHANISM, not the win rate, for a reason worth keeping.
   *
   * The obvious version of this test ("every seat wins ~1/3 of matches") was
   * written first and it was worthless: reverting the fix left it GREEN. The
   * bias is ~2.4 points, a 600-match sample carries ~1.9 points of standard
   * error, and normalising shrinks the gap further — so no threshold exists that
   * catches the bug without failing at random. The outcome was unmeasurable at
   * any sane sample size.
   *
   * The seating deal itself, though, is exact: each seat must draw each of the
   * four corners about a quarter of the time. Before the fix seat 0 drew corner
   * 0 in 100% of matches, so this reads 100/0/0/0 and fails on sight.
   */
  it('deals the four corners uniformly across the three seats', () => {
    const N = 4000;
    const counts = [0, 1, 2].map(() => [0, 0, 0, 0]);
    for (let i = 0; i < N; i++) {
      const slots = seatSlots(3, (i * 2654435761) >>> 0);
      expect(new Set(slots).size).toBe(3); // never seat two players on one corner
      slots.forEach((corner, seat) => counts[seat][corner]++);
    }
    for (const seat of counts) {
      for (const c of seat) expect(Math.abs(c / N - 0.25)).toBeLessThan(0.03);
    }
  });

  it('every seat still wins its share', () => {
    // A loose backstop. It cannot see a 2-point bias (see above), but it would
    // catch a hexbloom-scale disaster like 54/33/10.
    const seats = normalisedSeatRates(seatWinRates(rs, 3));
    for (const s of seats) expect(Math.abs(s - 1 / 3)).toBeLessThan(0.06);
  });

  it('terminates and stays competitive', () => {
    expect(leaderWinRate(rs, 3)!).toBeLessThan(0.55);
    expect(blowoutRate(rs)).toBeLessThan(0.25);
    for (const r of rs) expect(r.rounds).toBe(MODES.clockwork.rounds);
  });
});

describe('the other two modes are games too', () => {
  it('Skirmish holds up', () => {
    const rs = runMatches(300, 4, MODES.skirmish);
    const seats = normalisedSeatRates(seatWinRates(rs, 4));
    for (const s of seats) expect(Math.abs(s - 0.25)).toBeLessThan(0.06);
    expect(leaderWinRate(rs, 2)!).toBeLessThan(0.5);
    expect(blowoutRate(rs)).toBeLessThan(0.3);
    for (const r of rs) expect(r.rounds).toBe(MODES.skirmish.rounds);
  });

  it('Gauntlet holds up', () => {
    // Gauntlet's 4 slots mean a 6-choose-4 = 360-program search per bot per
    // round, which measured ~8ms a match against Clockwork's ~1ms. That is the
    // reason this runs 150 matches rather than 600 — measured before shipping the
    // bigger mode, not assumed.
    const rs = runMatches(150, 4, MODES.gauntlet);
    const seats = normalisedSeatRates(seatWinRates(rs, 4));
    for (const s of seats) expect(Math.abs(s - 0.25)).toBeLessThan(0.09);
    expect(leaderWinRate(rs, 4)!).toBeLessThan(0.5);
    for (const r of rs) expect(r.rounds).toBe(MODES.gauntlet.rounds);
  });
});

describe('the game still has a soul', () => {
  /**
   * A balance fix that flattens the joy out of the core verb is a failed run.
   * Windup's verb is "circle back for the fat cog" — if every cog were eaten the
   * round it spawned, they would all be worth 1 and ripening would be a lie told
   * by the UI. So the distribution of COLLECTED values is asserted, not just the
   * win curve.
   */
  it('cogs actually ripen and get fought over', () => {
    const rs = runMatches(400, 2, MODES.clockwork);
    const values = rs.flatMap((r) => r.cogValues);
    const fat = values.filter((v) => v >= 4).length / values.length;
    const capped = values.filter((v) => v === MODES.clockwork.ripeCap).length / values.length;
    expect(fat).toBeGreaterThan(0.3); // measured 46%
    expect(capped).toBeGreaterThan(0.2); // measured 33% — cogs reach FULL ripeness
    // ...but not everything is fat, or the early game would be pointless.
    expect(values.filter((v) => v === 1).length / values.length).toBeGreaterThan(0.1);
  });

  it('leaves real value uncollected — you cannot have it all', () => {
    const rs = runMatches(200, 2, MODES.clockwork);
    expect(mean(rs.map((r) => r.leftOnBoard))).toBeGreaterThan(20);
  });
});

describe('priority rotation', () => {
  /**
   * Moving first in a step means doing the shoving, so priority is a real edge.
   * The 31 in `priorityOrder` is prime and therefore coprime to 2, 3 and 4 —
   * every supported player count. This is pinned because hexbloom learned it the
   * hard way: an even period there silently restored a 63% first-player edge.
   */
  it('gives every seat the lead equally often, at every player count', () => {
    for (const seats of [2, 3, 4]) {
      const leads = new Array(seats).fill(0);
      const rounds = 12 * seats; // a whole number of cycles
      for (let round = 1; round <= rounds; round++) {
        for (let slot = 0; slot < 3; slot++) leads[priorityOrder(round, slot, seats)[0]]++;
      }
      const expected = (rounds * 3) / seats;
      for (const n of leads) expect(n).toBe(expected);
    }
  });

  it('is a full permutation of the seats', () => {
    for (const seats of [2, 3, 4]) {
      const order = priorityOrder(5, 1, seats);
      expect(order.slice().sort()).toEqual([...Array(seats).keys()]);
    }
  });
});
