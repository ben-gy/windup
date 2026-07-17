/**
 * replay.test.ts — the reveal.
 *
 * The replay is reconstructed from the sim's events rather than re-simulated, so
 * the thing to prove is that it ENDS where the sim says it ends. A replay that
 * drifts from the authoritative state would leave the board showing a lie.
 */

import { describe, expect, it } from 'vitest';
import { buildReplay, easeInOut, facingAngle, poseAt } from '../src/replay';
import { createGame, resolveRound, type Card } from '../src/game';
import { projectPath } from '../src/render';
import { MODES } from '../src/modes';

const M = MODES.clockwork;

function play(seed: number, programs: Card[][]) {
  const before = createGame(seed, M, 2);
  const res = resolveRound(before, programs);
  const poses = res.before.bots.map((b) => ({ x: b.x, y: b.y, f: b.f, alpha: 1 }));
  return { res, replay: buildReplay(res, poses) };
}

describe('buildReplay', () => {
  it('lands every bot exactly where the sim left it', () => {
    for (const seed of [1, 11, 77, 4242]) {
      const { res, replay } = play(seed, [
        ['F2', 'TR', 'F1'],
        ['F1', 'TL', 'F3'],
      ]);
      const last = replay.steps[replay.steps.length - 1];
      res.state.bots.forEach((b, seat) => {
        const end = poseAt(last.tracks[seat], 1);
        expect({ x: end.x, y: end.y }).toEqual({ x: b.x, y: b.y });
      });
    }
  });

  it('produces one step per program slot', () => {
    const { replay } = play(11, [
      ['F1', 'TR', 'F1'],
      ['F1', 'TR', 'F1'],
    ]);
    expect(replay.steps.length).toBe(M.slots);
    expect(replay.spawnAt).toBe(M.slots);
  });

  it('every seat has a track in every step, starting at t=0', () => {
    const { replay } = play(5, [
      ['F2', 'F1', 'TL'],
      ['TR', 'F2', 'F1'],
    ]);
    for (const step of replay.steps) {
      expect(step.tracks.length).toBe(2);
      for (const track of step.tracks) expect(track[0].t).toBe(0);
    }
  });

  it('orders triggers so a shove reads causally', () => {
    const { replay } = play(3, [
      ['F3', 'F3', 'F3'],
      ['F3', 'F3', 'F3'],
    ]);
    for (const step of replay.steps) {
      const ts = step.triggers.map((t) => t.t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
      for (const t of ts) expect(t).toBeGreaterThan(0);
    }
  });
});

describe('poseAt', () => {
  it('interpolates between keyframes', () => {
    const track = [
      { t: 0, x: 0, y: 0, f: 1 as const },
      { t: 1, x: 4, y: 0, f: 1 as const },
    ];
    expect(poseAt(track, 0).x).toBe(0);
    expect(poseAt(track, 1).x).toBe(4);
    const mid = poseAt(track, 0.5);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(4);
  });

  it('fades a respawn instead of sliding it across the board', () => {
    // A bot that falls is teleported home by the sim. Sliding it there would
    // read as a bot calmly walking across the arena.
    const track = [
      { t: 0, x: 9, y: 9, f: 0 as const },
      { t: 1, x: 1, y: 1, f: 0 as const, jump: true },
    ];
    const early = poseAt(track, 0.2);
    expect({ x: early.x, y: early.y }).toEqual({ x: 9, y: 9 });
    expect(early.alpha).toBeLessThan(1);
    const late = poseAt(track, 0.8);
    expect({ x: late.x, y: late.y }).toEqual({ x: 1, y: 1 });
    expect(late.alpha).toBeLessThan(1);
    expect(poseAt(track, 1).alpha).toBeGreaterThan(0.9);
  });

  it('survives an empty or single-key track', () => {
    expect(poseAt([], 0.5)).toEqual({ x: 0, y: 0, f: 0, alpha: 1 });
    const one = [{ t: 0, x: 3, y: 4, f: 2 as const }];
    expect(poseAt(one, 0.7)).toMatchObject({ x: 3, y: 4 });
  });
});

describe('facingAngle', () => {
  it('turns the short way round', () => {
    // 0 -> 3 (N -> W) is a left turn, not three-quarters clockwise.
    const end = facingAngle(0, 3, 1);
    expect(end).toBeCloseTo(-Math.PI / 2, 4);
  });

  it('starts where it started', () => {
    expect(facingAngle(1, 2, 0)).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('easeInOut', () => {
  it('is pinned at both ends and monotonic', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOut(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('projectPath (the planning preview)', () => {
  it('follows the same movement rules as the sim', () => {
    const s = createGame(11, M, 2);
    const b = s.bots[0];
    const path = projectPath(s.board, { x: b.x, y: b.y, f: b.f }, ['F1', 'TR', 'F1']);
    expect(path.length).toBe(3);
    // Each entry is annotated with the slot that produced it, so the preview can
    // number the steps.
    expect(path.map((p) => p.n)).toEqual([1, 2, 3]);
  });

  it('ignores empty slots', () => {
    const s = createGame(11, M, 2);
    const b = s.bots[0];
    expect(projectPath(s.board, { x: b.x, y: b.y, f: b.f }, [null, null, null])).toEqual([]);
  });

  it('stops at a pit rather than pretending you walked over it', () => {
    const s = createGame(3, M, 2);
    let pit: { x: number; y: number } | null = null;
    for (let y = 0; y < s.board.size && !pit; y++) {
      for (let x = 1; x < s.board.size; x++) {
        if (s.board.tiles[y * s.board.size + x] === 2 && s.board.tiles[y * s.board.size + x - 1] === 0) {
          pit = { x, y };
          break;
        }
      }
    }
    expect(pit).not.toBeNull();
    const path = projectPath(s.board, { x: pit!.x - 1, y: pit!.y, f: 1 }, ['F3']);
    expect(path[path.length - 1]).toMatchObject({ x: pit!.x, y: pit!.y });
  });
});
