/**
 * render.ts — the arena, on a canvas.
 *
 * Canvas rather than DOM because a round's reveal is continuous motion: four
 * bots tweening along paths, sparks, a screen shake. The HUD, cards and menus
 * stay in the DOM, where text is crisp and tap targets are honest.
 */

import { cogValue, DX, DY, TILE_PIT, TILE_WALL, tileAt, type Board, type GameState } from './game';
import { facingAngle, type BotPose, type ReplayStep } from './replay';
import type { Fx } from './fx';

/** Okabe–Ito. Colour-blind-safe, and each seat also carries a shape glyph. */
export const SEAT_COLOURS = ['#0072b2', '#d55e00', '#009e73', '#cc79a7'];
export const SEAT_GLYPHS = ['▲', '●', '■', '◆'];
export const SEAT_SHAPES: ('tri' | 'circle' | 'square' | 'diamond')[] = [
  'tri',
  'circle',
  'square',
  'diamond',
];

const BRASS = '#d9a441';
const SLATE = '#1b1f24';

export interface Viewport {
  /** Pixel size of one tile. */
  cell: number;
  /** Board origin in css pixels. */
  x: number;
  y: number;
}

export interface RenderInput {
  state: GameState;
  /** Live poses (during a replay) or null to draw the resting state. */
  poses: BotPose[] | null;
  /** Tiles the local player's program is projected to visit. */
  preview: { x: number; y: number; n: number }[] | null;
  fx: Fx;
  /** Seat of the local player, for the "you" ring. -1 for a spectator. */
  selfSeat: number;
  /** 3/2/1/0 during the count-in, else null. */
  countdown: number | null;
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let vp: Viewport = { cell: 32, x: 0, y: 0 };

  function resize(board: Board): void {
    const rect = canvas.getBoundingClientRect();
    // A transient 0-size measurement (a hidden tab, a mid-layout read) would
    // yield a NaN/Infinity scale and silently drop every pointer hit. Ignore it;
    // the next frame will measure properly.
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cell = Math.floor(Math.min(rect.width, rect.height) / board.size);
    vp = {
      cell,
      x: Math.round((rect.width - cell * board.size) / 2),
      y: Math.round((rect.height - cell * board.size) / 2),
    };
  }

  const px = (x: number): number => vp.x + x * vp.cell;
  const py = (y: number): number => vp.y + y * vp.cell;

  function drawCog(cx: number, cy: number, value: number, cap: number, centre: boolean, t: number): void {
    const ripe = (value - 1) / Math.max(1, cap - 1);
    const r = vp.cell * (0.16 + ripe * 0.16);
    const teeth = 6 + Math.round(ripe * 4);

    if (value >= 4) {
      // A fat cog advertises itself — this is the thing everyone converges on.
      const pulse = 0.28 + 0.16 * Math.sin(t * 3);
      const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.4);
      glow.addColorStop(0, `rgba(217,164,65,${pulse.toFixed(3)})`);
      glow.addColorStop(1, 'rgba(217,164,65,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const spin = centre ? t * 0.9 : t * 0.25 + value;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.fillStyle = centre ? '#f0c56b' : BRASS;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a0 = (i / teeth) * Math.PI * 2;
      const a1 = ((i + 0.5) / teeth) * Math.PI * 2;
      const a2 = ((i + 1) / teeth) * Math.PI * 2;
      ctx.lineTo(Math.cos(a0) * r * 1.32, Math.sin(a0) * r * 1.32);
      ctx.lineTo(Math.cos(a1) * r * 1.32, Math.sin(a1) * r * 1.32);
      ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
      ctx.lineTo(Math.cos(a2) * r, Math.sin(a2) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = SLATE;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // The value, always readable — colour alone never carries meaning.
    ctx.fillStyle = '#0f1216';
    ctx.font = `700 ${Math.round(vp.cell * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), cx, cy + vp.cell * 0.005);
  }

  function drawBot(seat: number, pose: BotPose, isSelf: boolean, angle: number): void {
    const cx = px(pose.x) + vp.cell / 2;
    const cy = py(pose.y) + vp.cell / 2;
    const r = vp.cell * 0.33;
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    ctx.translate(cx, cy);

    if (isSelf) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.rotate(angle);
    ctx.fillStyle = SEAT_COLOURS[seat % 4];
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;

    // Body: a rounded chassis with a clear nose, so facing is unmistakable.
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.15);
    ctx.lineTo(r * 0.8, r * 0.5);
    ctx.lineTo(0, r * 0.18);
    ctx.lineTo(-r * 0.8, r * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // The wind-up key on the back.
    ctx.rotate(-angle);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `700 ${Math.round(vp.cell * 0.26)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SEAT_GLYPHS[seat % 4], 0, r * 0.62);
    ctx.restore();
  }

  function draw(input: RenderInput, stepT: number, step: ReplayStep | null, time: number): void {
    const { state, fx } = input;
    const board = state.board;
    resize(board);
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2) return;

    const off = fx.offset();
    ctx.save();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.translate(off.x, off.y);

    // ── tiles ──
    for (let y = 0; y < board.size; y++) {
      for (let x = 0; x < board.size; x++) {
        const t = tileAt(board, x, y);
        const gx = px(x);
        const gy = py(y);
        const pad = 1;
        if (t === TILE_WALL) {
          ctx.fillStyle = '#39424c';
          ctx.fillRect(gx + pad, gy + pad, vp.cell - pad * 2, vp.cell - pad * 2);
          ctx.fillStyle = '#4b5765';
          ctx.fillRect(gx + pad, gy + pad, vp.cell - pad * 2, Math.max(2, vp.cell * 0.14));
        } else if (t === TILE_PIT) {
          ctx.fillStyle = '#0a0c0f';
          ctx.fillRect(gx + pad, gy + pad, vp.cell - pad * 2, vp.cell - pad * 2);
          ctx.strokeStyle = 'rgba(213,94,0,0.5)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(gx + 3, gy + 3, vp.cell - 6, vp.cell - 6);
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#232830' : '#1f242b';
          ctx.fillRect(gx, gy, vp.cell, vp.cell);
        }
      }
    }

    // ── start pads ──
    state.bots.forEach((b, seat) => {
      ctx.strokeStyle = SEAT_COLOURS[seat % 4];
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.strokeRect(px(b.home.x) + 3, py(b.home.y) + 3, vp.cell - 6, vp.cell - 6);
      ctx.globalAlpha = 1;
    });

    // ── projected path of the program being planned ──
    if (input.preview && input.preview.length) {
      const me = input.selfSeat;
      ctx.strokeStyle = SEAT_COLOURS[me % 4];
      ctx.fillStyle = SEAT_COLOURS[me % 4];
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(2, vp.cell * 0.08);
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const p0 = state.bots[me];
      ctx.moveTo(px(p0.x) + vp.cell / 2, py(p0.y) + vp.cell / 2);
      for (const p of input.preview) ctx.lineTo(px(p.x) + vp.cell / 2, py(p.y) + vp.cell / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const last = input.preview[input.preview.length - 1];
      ctx.beginPath();
      ctx.arc(px(last.x) + vp.cell / 2, py(last.y) + vp.cell / 2, vp.cell * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── cogs ──
    const t = time / 1000;
    for (const cog of state.cogs) {
      drawCog(
        px(cog.x) + vp.cell / 2,
        py(cog.y) + vp.cell / 2,
        cogValue(cog, state.round, state.mode.ripeCap),
        state.mode.ripeCap,
        cog.centre,
        t,
      );
    }

    // ── bots ──
    state.bots.forEach((b, seat) => {
      const pose = input.poses?.[seat] ?? { x: b.x, y: b.y, f: b.f, alpha: 1 };
      let angle = (pose.f * Math.PI) / 2;
      if (step) {
        const track = step.tracks[seat];
        const prev = track.filter((k) => k.t <= stepT).pop() ?? track[0];
        const next = track.find((k) => k.t > stepT) ?? prev;
        if (next.f !== prev.f && next.t > prev.t) {
          angle = facingAngle(prev.f, next.f, (stepT - prev.t) / (next.t - prev.t));
        }
      }
      drawBot(seat, pose, seat === input.selfSeat, angle);
    });

    // ── particles ──
    for (const p of fx.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      if (p.text) {
        ctx.fillStyle = p.colour;
        ctx.font = `800 ${Math.round(p.size)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = p.colour;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // ── count-in ──
    if (input.countdown !== null) {
      ctx.save();
      ctx.fillStyle = 'rgba(11,14,18,0.55)';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = input.countdown === 0 ? BRASS : '#f2f4f7';
      ctx.font = `900 ${Math.round(Math.min(rect.width, rect.height) * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(input.countdown === 0 ? 'GO' : String(input.countdown), rect.width / 2, rect.height / 2);
      ctx.restore();
    }
  }

  /** Board cell under a client point, or null. */
  function cellAt(clientX: number, clientY: number, board: Board): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2) return null;
    const x = Math.floor((clientX - rect.left - vp.x) / vp.cell);
    const y = Math.floor((clientY - rect.top - vp.y) / vp.cell);
    if (x < 0 || y < 0 || x >= board.size || y >= board.size) return null;
    return { x, y };
  }

  /** Pixel centre of a cell — fx spawn points. */
  function centreOfCell(x: number, y: number): { x: number; y: number } {
    return { x: px(x) + vp.cell / 2, y: py(y) + vp.cell / 2 };
  }

  return { draw, resize, cellAt, centreOfCell, viewport: () => vp };
}

/** Project a program from a pose, for the planning preview. Mirrors the sim's
 *  movement rules, minus other bots — which is exactly the uncertainty the game
 *  is about, so the preview must never pretend to know it. */
export function projectPath(
  board: Board,
  from: { x: number; y: number; f: number },
  program: (string | null)[],
): { x: number; y: number; n: number }[] {
  const out: { x: number; y: number; n: number }[] = [];
  let { x, y, f } = from;
  program.forEach((card, i) => {
    if (!card) return;
    if (card === 'TL' || card === 'TR' || card === 'UT') {
      f = (f + (card === 'TL' ? 3 : card === 'TR' ? 1 : 2)) % 4;
      out.push({ x, y, n: i + 1 });
      return;
    }
    const steps = card === 'F1' ? 1 : card === 'F2' ? 2 : card === 'F3' ? 3 : 1;
    const dir = card === 'B1' ? (f + 2) % 4 : f;
    for (let s = 0; s < steps; s++) {
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (tileAt(board, nx, ny) === TILE_WALL) break;
      x = nx;
      y = ny;
      if (tileAt(board, nx, ny) === TILE_PIT) {
        out.push({ x, y, n: i + 1 });
        return;
      }
    }
    out.push({ x, y, n: i + 1 });
  });
  return out;
}
