/**
 * gen-icons.mjs — rasterise the Windup mark into the PNGs a home-screen install
 * needs. Run with `npm run icons`; the output is committed under public/.
 *
 *   node scripts/gen-icons.mjs
 *
 * Why this exists rather than a one-liner with sharp: the game ships one tiny
 * runtime dependency and sharp is a 30MB native binary we would be installing to
 * draw four small squares. So this carries its own rasteriser for the handful of
 * primitives public/favicon.svg actually uses — rounded rects (some rotated) and
 * filled circles — and its own PNG encoder on top of node's built-in zlib.
 * Nothing here is a general SVG renderer; ART below is the same mark as
 * favicon.svg, expressed as the shapes it is made of, so the icons and the
 * favicon cannot drift apart into two different logos.
 *
 * The mark is generated rather than drawn: the eight teeth are ONE rounded rect
 * rotated by i * 45 degrees about the centre, which is the same 90-degree
 * rotational symmetry the board generator uses. There is no artwork to check in.
 *
 * The four outputs are NOT interchangeable:
 *  - icon-192 / icon-512: the manifest's own icons. Rounded, "any" purpose.
 *  - icon-maskable-512: Android crops adaptive icons to a device-chosen shape
 *    (circle, squircle, teardrop). A non-maskable icon fed to that crop loses its
 *    corners. So this one is full-bleed with the art shrunk into the safe zone —
 *    the centre 80% — and it must NOT be rounded: the platform does the rounding.
 *  - apple-touch-icon: iOS ignores the manifest entirely, and composites any
 *    transparency onto BLACK. Full-bleed, fully opaque, no rounding (iOS masks).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The palette, straight from the game's slate-and-brass identity.
const SLATE = '#1b1f24'; // the ground the board is machined out of
const BRASS = '#d9a441'; // the cogs
const BRASS_DARK = '#a8752c'; // the shadowed face of a cog, for a little depth

// ── the mark ────────────────────────────────────────────────────────────────

const C = 32; // the centre of the 64x64 space favicon.svg uses
const TEETH = 8;

/**
 * A single tooth, at 12 o'clock: a stubby rounded rect straddling the rim.
 * Its inner end is buried under the body circle, so the two read as one part.
 */
function tooth(i) {
  return {
    t: 'rect',
    x: C - 4,
    y: 6,
    w: 8,
    h: 12,
    r: 1.8,
    fill: BRASS,
    rot: (360 / TEETH) * i,
    px: C,
    py: C,
  };
}

/**
 * The Windup mark: a brass cog on slate. Eight teeth, a solid body, a darker
 * inner face and a slate bore punched through the middle — the bore is the
 * background colour rather than a hole, because the rasteriser is a painter and
 * has no notion of subtraction.
 */
const ART = [
  ...Array.from({ length: TEETH }, (_, i) => tooth(i)),
  { t: 'circle', cx: C, cy: C, r: 17, fill: BRASS },
  { t: 'circle', cx: C, cy: C, r: 11, fill: BRASS_DARK },
  { t: 'circle', cx: C, cy: C, r: 5.5, fill: SLATE },
];

// ── colour ──────────────────────────────────────────────────────────────────

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── geometry: signed distance, so every edge antialiases the same way ────────

/** Negative inside. A rounded rect is a shrunken rect dilated by its radius. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Evaluate a shape's signed distance at a point.
 *
 * A rotated shape is not a new primitive: rotate the SAMPLE POINT into the
 * shape's own frame and the upright SDF answers unchanged. Distances survive
 * rotation, so the antialiasing stays exactly as accurate as it is elsewhere —
 * which is what lets eight rotated teeth be one shape evaluated eight times.
 */
function sdOf(shape, px, py) {
  let x = px;
  let y = py;
  if (shape.rot) {
    const a = (-shape.rot * Math.PI) / 180;
    const dx = px - shape.px;
    const dy = py - shape.py;
    x = shape.px + dx * Math.cos(a) - dy * Math.sin(a);
    y = shape.py + dx * Math.sin(a) + dy * Math.cos(a);
  }
  switch (shape.t) {
    case 'rect':
      return sdRoundRect(x, y, shape.x, shape.y, shape.w, shape.h, shape.r ?? 0);
    case 'circle':
      return Math.hypot(x - shape.cx, y - shape.cy) - shape.r;
    default:
      throw new Error(`unknown shape ${shape.t}`);
  }
}

// ── raster ──────────────────────────────────────────────────────────────────

const SS = 4; // 4x4 supersamples per pixel — enough that no edge stairsteps.

/**
 * Render `shapes` (in `space`x`space` user units) to a `size`x`size` RGBA buffer.
 * Shapes composite in order, painter's algorithm, straight (non-premultiplied)
 * alpha — which is what the PNG spec wants anyway.
 */
function render(shapes, size, space) {
  const px = new Uint8Array(size * size * 4);
  const prepared = shapes.map((s) => ({ ...s, rgb: rgb(s.fill), alpha: s.alpha ?? 1 }));
  const scale = space / size;
  const step = 1 / SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) * step) * scale;
          const uy = (y + (sy + 0.5) * step) * scale;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const s of prepared) {
            // Coverage across one device pixel's worth of distance: this is the
            // antialiasing, and it is why everything is an SDF above.
            const cov = Math.max(0, Math.min(1, 0.5 - sdOf(s, ux, uy) / scale));
            if (cov <= 0) continue;
            const sa = cov * s.alpha;
            const na = sa + ca * (1 - sa);
            if (na <= 0) continue;
            cr = (s.rgb[0] * sa + cr * ca * (1 - sa)) / na;
            cg = (s.rgb[1] * sa + cg * ca * (1 - sa)) / na;
            cb = (s.rgb[2] * sa + cb * ca * (1 - sa)) / na;
            ca = na;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Un-premultiply the averaged samples back to straight alpha.
      const aa = a / n;
      px[i] = aa > 0 ? Math.round(r / a) : 0;
      px[i + 1] = aa > 0 ? Math.round(g / a) : 0;
      px[i + 2] = aa > 0 ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(aa * 255);
    }
  }
  return px;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  // 10..12: deflate / adaptive filtering / no interlace — all zero.

  // One filter byte (0 = None) per scanline. Filtering would only buy us bytes
  // on artwork this flat; zlib already gets it to a few KB. tests/manifest
  // decodes these, and assumes filter 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the four icons ──────────────────────────────────────────────────────────

/** Place ART inside a `space`-unit square, scaled by `inset` about the centre. */
function art(space, inset) {
  const k = (space / 64) * inset;
  const off = (space - 64 * k) / 2;
  const m = (v) => v * k + off;
  return ART.map((s) => {
    const base = s.rot ? { ...s, px: m(s.px), py: m(s.py) } : { ...s };
    switch (s.t) {
      case 'rect':
        return { ...base, x: m(s.x), y: m(s.y), w: s.w * k, h: s.h * k, r: (s.r ?? 0) * k };
      default:
        return { ...base, cx: m(s.cx), cy: m(s.cy), r: s.r * k };
    }
  });
}

/** The manifest's "any" icon: the favicon at size, corners and all. */
const rounded = (space) => [
  { t: 'rect', x: 0, y: 0, w: space, h: space, r: space * (14 / 64), fill: SLATE },
  ...art(space, 1),
];

/**
 * Full-bleed square. `inset` shrinks the art into a crop's safe zone.
 *
 * The background is overshot past every edge on purpose. Flush against the
 * canvas the outer pixels only get ~50% coverage from the antialiaser, so the
 * icon ends up with a one-pixel semi-transparent border — invisible in a
 * previewer, and a black hairline once iOS composites it.
 */
const bleed = (space, inset) => [
  { t: 'rect', x: -2, y: -2, w: space + 4, h: space + 4, r: 0, fill: SLATE },
  ...art(space, inset),
];

const ICONS = [
  { file: 'icon-192.png', size: 192, shapes: rounded(64) },
  { file: 'icon-512.png', size: 512, shapes: rounded(64) },
  // Android's crop can eat everything outside the centre 80%; 0.62 keeps the
  // whole cog inside the inscribed safe circle rather than merely the box.
  { file: 'icon-maskable-512.png', size: 512, shapes: bleed(64, 0.62) },
  // iOS applies its own mask and squircle, so a rounded source would double up.
  { file: 'apple-touch-icon.png', size: 180, shapes: bleed(64, 0.86) },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, shapes } of ICONS) {
  const px = render(shapes, size, 64);
  // apple-touch-icon must be fully opaque: iOS composites transparency on BLACK,
  // which would ring the icon in a colour that is nowhere in the game.
  if (file === 'apple-touch-icon.png') {
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) throw new Error('apple-touch-icon has transparent pixels');
    }
  }
  writeFileSync(join(OUT, file), encodePng(px, size));
  console.log(`wrote public/${file} (${size}x${size})`);
}
