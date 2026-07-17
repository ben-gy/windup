/**
 * countdown.test.ts — the count-in, which exists so nobody gets a free head
 * start and the board never jump-cuts into a live round.
 */

import { describe, expect, it, vi } from 'vitest';
import { startCountdown } from '../src/countdown';

describe('countdown', () => {
  it('beats 3, 2, 1, GO and then finishes', () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    let done = false;
    startCountdown({ onBeat: (n) => beats.push(n), onDone: () => (done = true), beatMs: 700 });

    // The first beat is immediate — a blank second before "3" reads as a hang.
    expect(beats).toEqual([3]);
    expect(done).toBe(false);

    vi.advanceTimersByTime(700);
    expect(beats).toEqual([3, 2]);
    vi.advanceTimersByTime(700);
    expect(beats).toEqual([3, 2, 1]);
    vi.advanceTimersByTime(700);
    expect(beats).toEqual([3, 2, 1, 0]); // 0 is GO
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it('stops beating once it is done', () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    const c = startCountdown({ onBeat: (n) => beats.push(n), onDone: () => {}, beatMs: 100 });
    vi.advanceTimersByTime(2000);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(c.done()).toBe(true);
    vi.useRealTimers();
  });

  it('cancels cleanly on teardown — a stray beat would fire into a dead screen', () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    let done = false;
    const c = startCountdown({
      onBeat: (n) => beats.push(n),
      onDone: () => (done = true),
      beatMs: 700,
    });
    c.cancel();
    vi.advanceTimersByTime(5000);
    expect(beats).toEqual([3]);
    expect(done).toBe(false);
    vi.useRealTimers();
  });

  it('is safe to cancel twice', () => {
    vi.useFakeTimers();
    const c = startCountdown({ onBeat: () => {}, onDone: () => {}, beatMs: 10 });
    c.cancel();
    expect(() => c.cancel()).not.toThrow();
    vi.useRealTimers();
  });

  it('drives off timers, not rAF — a backgrounded tab must still count in', () => {
    // rAF is paused in a hidden tab, so a countdown built on it freezes when the
    // player glances away, and cannot be verified headlessly at all.
    const calls: number[] = [];
    let fire: (() => void) | null = null;
    startCountdown({
      onBeat: (n) => calls.push(n),
      onDone: () => {},
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    expect(calls).toEqual([3]);
    fire!();
    expect(calls).toEqual([3, 2]);
  });
});
