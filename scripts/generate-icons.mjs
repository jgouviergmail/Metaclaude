#!/usr/bin/env node
/**
 * Generate the PWA raster icons.
 *
 * The source of truth is `apps/web/public/icon.svg`, but iOS home-screen icons
 * and the Android maskable slot need real PNGs. Rather than add an image
 * toolchain (and a native dependency) to the build, this script draws the mark
 * directly into an RGBA buffer and encodes a PNG with Node's built-in zlib.
 *
 * Run it when the mark changes:
 *   node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/public');

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(rgba, width, height) {
  // Each scanline is prefixed with its filter type; 0 (None) keeps this simple
  // and compresses well enough for flat vector artwork.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

const BACKGROUND = [0x0f, 0x0f, 0x14];
const GRADIENT_START = [0x81, 0x8c, 0xf8];
const GRADIENT_END = [0xc0, 0x84, 0xfc];

const lerp = (a, b, t) => a + (b - a) * t;

/** Colour along the diagonal gradient used by the SVG. */
function gradientAt(x, y, size) {
  const t = Math.min(1, Math.max(0, (x / size + y / size) / 2));
  return [
    lerp(GRADIENT_START[0], GRADIENT_END[0], t),
    lerp(GRADIENT_START[1], GRADIENT_END[1], t),
    lerp(GRADIENT_START[2], GRADIENT_END[2], t),
  ];
}

/**
 * Draw the mark.
 *
 * @param size     Output edge length in pixels.
 * @param maskable When true, the artwork is inset to Android's 40% safe zone
 *                 and the background fills the whole square, so a circular or
 *                 squircle mask cannot clip the ring.
 */
function drawIcon(size, maskable) {
  // 3× supersampling, then a box downsample. Cheap, and enough to keep the
  // ring's edges clean without implementing proper analytic coverage.
  const SS = 3;
  const big = size * SS;
  const buffer = Buffer.alloc(big * big * 4);

  const centre = big / 2;
  // Non-maskable icons keep the SVG's rounded-square silhouette; maskable ones
  // fill the square and let the launcher apply its own shape.
  const cornerRadius = maskable ? 0 : big * 0.22;
  const scale = maskable ? 0.62 : 0.86;

  const ringRadius = (big * 0.293) * scale;
  const ringWidth = (big * 0.078) * scale;
  const dotRadius = (big * 0.098) * scale;

  // The ring is an arc with a gap, rotated -45°, matching the SVG's dasharray.
  const GAP_START = 1.02 * Math.PI;
  const GAP_END = 1.52 * Math.PI;
  const ROTATION = -Math.PI / 4;

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const index = (y * big + x) * 4;

      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.hypot(dx, dy);

      // Background, with rounded corners for the non-maskable variant.
      let inBackground = true;
      if (cornerRadius > 0) {
        const cx = Math.min(x, big - 1 - x);
        const cy = Math.min(y, big - 1 - y);
        if (cx < cornerRadius && cy < cornerRadius) {
          inBackground =
            Math.hypot(cornerRadius - cx, cornerRadius - cy) <= cornerRadius;
        }
      }

      if (!inBackground) {
        buffer[index + 3] = 0;
        continue;
      }

      buffer[index] = BACKGROUND[0];
      buffer[index + 1] = BACKGROUND[1];
      buffer[index + 2] = BACKGROUND[2];
      buffer[index + 3] = 255;

      // Centre dot.
      if (distance <= dotRadius) {
        const [r, g, b] = gradientAt(x, y, big);
        buffer[index] = r;
        buffer[index + 1] = g;
        buffer[index + 2] = b;
        continue;
      }

      // Ring band, minus the gap.
      const inBand =
        distance >= ringRadius - ringWidth / 2 && distance <= ringRadius + ringWidth / 2;
      if (!inBand) continue;

      let angle = Math.atan2(dy, dx) - ROTATION;
      angle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (angle >= GAP_START && angle <= GAP_END) continue;

      const [r, g, b] = gradientAt(x, y, big);
      buffer[index] = r;
      buffer[index + 1] = g;
      buffer[index + 2] = b;
    }
  }

  // Downsample by averaging each SS×SS block.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          r += buffer[i];
          g += buffer[i + 1];
          b += buffer[i + 2];
          a += buffer[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS ignores the manifest's icon list and uses this one.
  { file: 'icon-180.png', size: 180, maskable: false },
  { file: 'favicon-32.png', size: 32, maskable: false },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const target of TARGETS) {
  const pixels = drawIcon(target.size, target.maskable);
  const png = encodePng(pixels, target.size, target.size);
  writeFileSync(resolve(OUT_DIR, target.file), png);
  console.log(`wrote ${target.file} (${target.size}×${target.size}, ${png.length} bytes)`);
}
