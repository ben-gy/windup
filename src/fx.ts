/**
 * fx.ts — particles, screen shake and hit-stop.
 *
 * Everything here asks `reduced` first. Under prefers-reduced-motion the shake
 * and hit-stop are dropped entirely and particles are thinned — but never
 * removed, because a cog burst is FEEDBACK (it tells you that you scored), not
 * decoration. Motion sensitivity is a reason to stop shaking the camera, not a
 * reason to stop telling the player what happened.
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  colour: string;
  /** Score pops and the like draw text instead of a dot. */
  text?: string;
}

export interface Fx {
  particles: Particle[];
  burst(x: number, y: number, colour: string, count: number, speed?: number): void;
  pop(x: number, y: number, text: string, colour: string): void;
  shake(amount: number): void;
  /** Freeze the replay briefly on an impact. Returns ms to hold. */
  stop(ms: number): void;
  update(dt: number): void;
  /** Current camera offset, in pixels. */
  offset(): { x: number; y: number };
  /** Ms of hit-stop still owed. */
  held(): number;
  clear(): void;
  reduced: boolean;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createFx(reduced = prefersReducedMotion()): Fx {
  const particles: Particle[] = [];
  let shakeAmt = 0;
  let hold = 0;
  let ox = 0;
  let oy = 0;
  let seed = 1;

  // A tiny deterministic jitter — Math.random here would be harmless (it never
  // touches gameplay) but keeping the whole game free of it means "no
  // Math.random outside fx" is a rule with no exceptions to remember.
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  return {
    particles,
    reduced,

    burst(x, y, colour, count, speed = 90) {
      const n = reduced ? Math.min(count, 4) : count;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
        const s = speed * (0.4 + rnd() * 0.8);
        particles.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0.45 + rnd() * 0.35,
          max: 0.8,
          size: 2 + rnd() * 2.5,
          colour,
        });
      }
    },

    pop(x, y, text, colour) {
      particles.push({
        x,
        y,
        vx: 0,
        vy: -46,
        life: 0.9,
        max: 0.9,
        size: 16,
        colour,
        text,
      });
    },

    shake(amount) {
      if (reduced) return;
      shakeAmt = Math.min(14, shakeAmt + amount);
    },

    stop(ms) {
      if (reduced) return;
      hold = Math.max(hold, ms);
    },

    update(dt) {
      if (hold > 0) hold = Math.max(0, hold - dt * 1000);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (!p.text) {
          p.vy += 220 * dt; // a little gravity so sparks fall
          p.vx *= 0.96;
        }
      }
      if (shakeAmt > 0.05) {
        shakeAmt *= Math.pow(0.0016, dt); // decays fast
        ox = (rnd() * 2 - 1) * shakeAmt;
        oy = (rnd() * 2 - 1) * shakeAmt;
      } else {
        shakeAmt = 0;
        ox = 0;
        oy = 0;
      }
    },

    offset: () => ({ x: ox, y: oy }),
    held: () => hold,

    clear() {
      particles.length = 0;
      shakeAmt = 0;
      hold = 0;
      ox = 0;
      oy = 0;
    },
  };
}
