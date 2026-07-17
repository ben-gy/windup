/**
 * replay.ts — turn a resolved round into something you can watch.
 *
 * The reveal IS the product. You committed three cards blind; this is where you
 * find out what they did. So the timeline is reconstructed from the sim's
 * events rather than re-simulated: `resolveRound` already decided everything,
 * and re-deriving it here would be a second implementation to disagree with the
 * first.
 *
 * Events inside a step are ordered by seat priority, and that order is preserved
 * — you SEE the shove land before the shoved bot slides. Faking simultaneity
 * would hide the causality that makes a round make sense.
 */

import type { Ev, Facing, RoundResult } from './game';

export interface Key {
  /** 0..1 within the step. */
  t: number;
  x: number;
  y: number;
  f: Facing;
  /** A respawn — snap, never slide across the board. */
  jump?: boolean;
}

export interface Trigger {
  t: number;
  ev: Ev;
}

export interface ReplayStep {
  slot: number;
  /** Per seat, the keyframes to interpolate between. */
  tracks: Key[][];
  triggers: Trigger[];
}

export interface Replay {
  steps: ReplayStep[];
  /** Cogs that appear after the last step, as the round's closing beat. */
  spawnAt: number;
}

export interface BotPose {
  x: number;
  y: number;
  f: Facing;
  /** 0..1, for a fall's fade-out/in. */
  alpha: number;
}

/**
 * Build the timeline. `before` is the pose of each seat as the round opened.
 */
export function buildReplay(res: RoundResult, before: BotPose[]): Replay {
  const steps: ReplayStep[] = [];
  const cur = before.map((b) => ({ x: b.x, y: b.y, f: b.f }));

  for (const step of res.steps) {
    const tracks: Key[][] = cur.map((p) => [{ t: 0, x: p.x, y: p.y, f: p.f }]);
    const triggers: Trigger[] = [];
    const n = Math.max(1, step.events.length);

    step.events.forEach((ev, i) => {
      // Each event owns a slice of the step, so causality reads in order.
      const t = (i + 1) / n;
      triggers.push({ t, ev });
      if (ev.t === 'move') {
        cur[ev.seat].x = ev.to.x;
        cur[ev.seat].y = ev.to.y;
        tracks[ev.seat].push({ t, x: ev.to.x, y: ev.to.y, f: cur[ev.seat].f });
      } else if (ev.t === 'turn') {
        cur[ev.seat].f = ev.f;
        tracks[ev.seat].push({ t, x: cur[ev.seat].x, y: cur[ev.seat].y, f: ev.f });
      } else if (ev.t === 'fall') {
        // The sim already moved the bot home; reflect that as a jump so the
        // renderer fades rather than sliding it across the whole board.
        const last = tracks[ev.seat][tracks[ev.seat].length - 1];
        tracks[ev.seat].push({ t, x: last.x, y: last.y, f: last.f });
      }
    });

    steps.push({ slot: step.slot, tracks, triggers });
  }

  // After the last event of a fall, the bot is home. Reconcile the tracks'
  // final keys with where the sim actually left everyone.
  const final = res.state.bots;
  if (steps.length) {
    const lastStep = steps[steps.length - 1];
    final.forEach((b, seat) => {
      const track = lastStep.tracks[seat];
      const last = track[track.length - 1];
      if (last.x !== b.x || last.y !== b.y || last.f !== b.f) {
        track.push({ t: 1, x: b.x, y: b.y, f: b.f, jump: true });
      }
    });
  }

  return { steps, spawnAt: steps.length };
}

/** Interpolate a seat's pose at time `t` (0..1) within a step. */
export function poseAt(track: Key[], t: number): BotPose {
  if (!track.length) return { x: 0, y: 0, f: 0, alpha: 1 };
  let a = track[0];
  let b = track[0];
  for (let i = 0; i < track.length; i++) {
    if (track[i].t <= t) a = track[i];
    if (track[i].t >= t) {
      b = track[i];
      break;
    }
    b = track[i];
  }
  if (a === b || b.t <= a.t) return { x: a.x, y: a.y, f: a.f, alpha: 1 };

  const span = b.t - a.t;
  const k = Math.min(1, Math.max(0, (t - a.t) / span));
  if (b.jump) {
    // A respawn: fade out at the pit, fade in at home. Never a long slide.
    return k < 0.5
      ? { x: a.x, y: a.y, f: a.f, alpha: 1 - k * 2 }
      : { x: b.x, y: b.y, f: b.f, alpha: (k - 0.5) * 2 };
  }
  const e = easeInOut(k);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, f: b.f, alpha: 1 };
}

/** Rotation is short-way-round, so a u-turn never spins the long way. */
export function facingAngle(from: Facing, to: Facing, k: number): number {
  const a = (from * Math.PI) / 2;
  let d = ((to - from + 4) % 4) * (Math.PI / 2);
  if (d > Math.PI) d -= Math.PI * 2;
  return a + d * easeInOut(k);
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
