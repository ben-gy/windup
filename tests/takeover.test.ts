/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the game.
 *
 * rhythm-relay shipped broken because nobody wired onHostChange for its co-op
 * shape, and no test could have caught it because the takeover was not reachable
 * without a network. So `Match.setHost()` is deliberately a plain method: the
 * promotion is provable here, with no relay, no browser and no timing model.
 *
 * The assertions that matter, in order:
 *   1. Before promotion, a client does NOT advance shared state (it is not the
 *      host; if it did, two peers would both be authoritative).
 *   2. With the host gone, the match genuinely stalls — proving step 3 is not a
 *      false positive from something else driving the clock.
 *   3. After promotion, the survivor drives the match all the way to over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatch, type Chan, type Match, type Seat } from '../src/match';
import { MODES } from '../src/modes';
import type { Card } from '../src/game';

const M = MODES.skirmish; // the shortest mode — fewest rounds to reach game over

const SEATS = (): Seat[] => [
  { id: 'A', name: 'Ada', bot: null },
  { id: 'B', name: 'Baz', bot: null },
];

const PROGRAM: Card[] = ['F1', 'TR', 'F1'];

/** A two-peer bus. Each side's sends land on the other's receive. */
function makePair(): { host: Match; client: Match; killHost: () => void } {
  let host: Match;
  let client: Match;
  let hostDead = false;

  host = createMatch({
    seed: 4242,
    mode: M,
    seats: SEATS(),
    selfSeat: 0,
    isHost: true,
    transport: { send: (ch: Chan, d: unknown) => !hostDead && client?.receive(ch, d, 'A') },
  });

  client = createMatch({
    seed: 4242,
    mode: M,
    seats: SEATS(),
    selfSeat: 1,
    isHost: false,
    transport: { send: (ch: Chan, d: unknown) => !hostDead && host?.receive(ch, d, 'B') },
  });

  return {
    host,
    client,
    killHost() {
      hostDead = true;
      host.destroy();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('host-authoritative resolution', () => {
  it('both peers reach an identical state from the same programs', () => {
    const { host, client } = makePair();
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(600);

    expect(host.state().round).toBe(2);
    expect(client.state().round).toBe(2);
    // Determinism is the entire netcode: the host broadcast programs, not truth.
    expect(JSON.stringify(client.state().bots)).toBe(JSON.stringify(host.state().bots));
    expect(JSON.stringify(client.state().cogs)).toBe(JSON.stringify(host.state().cogs));
    host.destroy();
    client.destroy();
  });

  it('the host resolves on its clock even if a peer never answers', () => {
    const { host, client } = makePair();
    host.submit(PROGRAM); // client stays silent
    vi.advanceTimersByTime(M.planSecs * 1000 + 500);
    // The no-deadlock guarantee: one player wandering off costs a timer, not the
    // session. The absent seat gets played for them.
    expect(host.state().round).toBe(2);
    host.destroy();
    client.destroy();
  });
});

describe('host transfer', () => {
  it('a client does not advance shared state before promotion', () => {
    const { client, killHost } = makePair();
    killHost();
    client.submit(PROGRAM);
    vi.advanceTimersByTime(M.planSecs * 1000 + 2000);
    // Nobody is host, so nothing resolves. This is the control for the next test.
    expect(client.state().round).toBe(1);
    client.destroy();
  });

  it('the promoted survivor keeps the match running AND can finish it', () => {
    const { host, client, killHost } = makePair();

    // Play one round together so the client is mid-match, not at the start.
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(600);
    expect(client.state().round).toBe(2);

    // The host closes its tab.
    killHost();
    expect(client.isHost()).toBe(false);

    // net.ts elects the survivor; main.ts routes that into setHost.
    client.setHost(true);
    expect(client.isHost()).toBe(true);

    // It now drives the match on its own clock, all the way to game over — the
    // gate. A survivor stuck on a frozen board is the failure this catches.
    for (let i = 0; i < M.rounds + 2 && !client.state().over; i++) {
      client.submit(PROGRAM);
      vi.advanceTimersByTime(M.planSecs * 1000 + 1000);
    }

    expect(client.state().over).toBe(true);
    expect(client.state().round).toBeGreaterThan(M.rounds);
    client.destroy();
  });

  it('the promoted host re-anchors the room with a snapshot', () => {
    const sent: Chan[] = [];
    const m = createMatch({
      seed: 7,
      mode: M,
      seats: SEATS(),
      selfSeat: 1,
      isHost: false,
      transport: { send: (ch: Chan) => sent.push(ch) },
    });
    m.setHost(true);
    // Every peer already holds identical state (resolution is pure), but the
    // snapshot heals a late joiner and anyone who missed the last result.
    expect(sent).toContain('snap');
    m.destroy();
  });

  it('a demoted peer stops resolving', () => {
    const { host, client } = makePair();
    host.setHost(false); // e.g. it discovered an incumbent
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(M.planSecs * 1000 + 2000);
    expect(host.state().round).toBe(1);
    host.destroy();
    client.destroy();
  });
});

describe('the backgrounded-tab clock (solo only)', () => {
  /**
   * Found by playing it, not by reading it: the round clock is a setInterval and
   * keeps running in a hidden tab, while rAF — and so the replay — stops dead.
   * A solo player who glanced at another tab would be auto-played every round
   * and return to a finished match they never watched.
   *
   * The asymmetry is the whole point, and is why this is not just "pause on
   * blur": in a room the same behaviour would let one player stall everyone, so
   * multiplayer passes no pauseWhen at all and an absent peer gets played for.
   */
  it('freezes the solo clock while the tab is hidden', () => {
    let hidden = true;
    const m = createMatch({
      seed: 9,
      mode: M,
      seats: [{ id: 'self', name: 'Me', bot: null }, { id: 'bot:0', name: 'Bot', bot: 'normal' }],
      selfSeat: 0,
      isHost: true,
      pauseWhen: () => hidden,
    });

    // Away for ten times the planning window.
    vi.advanceTimersByTime(M.planSecs * 10_000);
    expect(m.state().round).toBe(1); // not a single round burned

    // Back at the desk: the clock resumes from where it left off.
    hidden = false;
    vi.advanceTimersByTime(M.planSecs * 1000 + 1000);
    expect(m.state().round).toBe(2);
    m.destroy();
  });

  it('does NOT pause a multiplayer match — an absent peer gets played for', () => {
    const { host, client } = makePair(); // built with no pauseWhen
    host.submit(PROGRAM);
    vi.advanceTimersByTime(M.planSecs * 1000 + 500);
    // The room moves on regardless of what any one tab is doing.
    expect(host.state().round).toBe(2);
    host.destroy();
    client.destroy();
  });
});

describe('a peer that leaves mid-match', () => {
  it('keeps its seat on the board, played on autopilot', () => {
    const { host, client } = makePair();
    host.seatGone('B');
    host.submit(PROGRAM);
    vi.advanceTimersByTime(600);
    // Resolves immediately — the host is not waiting on a peer that is gone.
    expect(host.state().round).toBe(2);
    expect(host.seats[1].gone).toBe(true);
    host.destroy();
    client.destroy();
  });
});

describe('message hygiene', () => {
  it('ignores a program for a round that has already resolved', () => {
    const { host, client } = makePair();
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(600);
    const before = JSON.stringify(host.state());
    host.receive('pg', { round: 1, seat: 1, program: PROGRAM }, 'B'); // stale
    expect(JSON.stringify(host.state())).toBe(before);
    host.destroy();
    client.destroy();
  });

  it('refuses a program submitted on someone else’s behalf', () => {
    const { host, client } = makePair();
    // Peer 'B' claiming to be seat 0 must not be able to play Ada's turn.
    host.receive('pg', { round: 1, seat: 0, program: PROGRAM }, 'B');
    expect(host.committed()).toBe(0);
    host.destroy();
    client.destroy();
  });

  it('ignores a duplicate result rather than replaying the round', () => {
    const { host, client } = makePair();
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(600);
    const at = JSON.stringify(client.state());
    // A late-delivered copy of round 1's result.
    client.receive('res', { round: 1, programs: [PROGRAM, PROGRAM] }, 'A');
    expect(JSON.stringify(client.state())).toBe(at);
    host.destroy();
    client.destroy();
  });

  it('does not rewind to an older snapshot', () => {
    const { host, client } = makePair();
    host.submit(PROGRAM);
    client.submit(PROGRAM);
    vi.advanceTimersByTime(600);
    expect(client.state().round).toBe(2);
    client.receive(
      'snap',
      { seed: 4242, modeId: M.id, round: 1, bots: [], cogs: [], seats: 2 },
      'A',
    );
    expect(client.state().round).toBe(2);
    host.destroy();
    client.destroy();
  });
});
