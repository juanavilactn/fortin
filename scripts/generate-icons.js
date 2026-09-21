#!/usr/bin/env node
/**
 * Generates the application icon and the tray icons.
 *
 * Pure Node (node:zlib only, no npm dependency): a small RGBA rasterizer with
 * analytic supersampling plus a minimal PNG encoder.
 *
 *   node scripts/generate-icons.js
 *
 * Outputs, all with a transparent background and a flat design that stays
 * legible at 16 px:
 *   assets/tray-<state>.png          16  (base file, Electron resolves @2x/@3x)
 *   assets/tray-<state>@2x.png       32
 *   assets/tray-<state>@3x.png       48
 *   assets/tray-<state>-16.png       16
 *   assets/tray-<state>-32.png       32
 *   assets/tray-<state>-64.png       64
 * where <state> is disconnected, connected, connecting or error.
 *
 * The tray glyph is a filled shield in a saturated per-state colour with a
 * white glyph inside, so it stays visible on both light and dark menubars.
 *
 * assets/icon.png, the 1024x1024 image of the application, is not generated
 * here: it is a designed asset and this script never rewrites it.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ASSETS_DIR = path.join(import.meta.dirname, '..', 'assets');

/* --------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------------- shapes */

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inSuperEllipse(x, y, cx, cy, rx, ry, exp) {
  return Math.pow(Math.abs((x - cx) / rx), exp) + Math.pow(Math.abs((y - cy) / ry), exp) <= 1;
}

function inDisc(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inSegment(x, y, ax, ay, bx, by, half) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(Math.max((wx * vx + wy * vy) / len2, 0), 1);
  const dx = x - (ax + t * vx);
  const dy = y - (ay + t * vy);
  return dx * dx + dy * dy <= half * half;
}

/** Shield silhouette, drawn inside the unit square. */
function inShield(x, y) {
  if (inRoundedRect(x, y, 0.1, 0.1, 0.9, 0.7, 0.13)) return true;
  return y >= 0.6 && inSuperEllipse(x, y, 0.5, 0.62, 0.4, 0.34, 2.6);
}

function inCheck(x, y) {
  return (
    inSegment(x, y, 0.3, 0.5, 0.43, 0.64, 0.062) || inSegment(x, y, 0.43, 0.64, 0.72, 0.33, 0.062)
  );
}

function inCross(x, y) {
  return (
    inSegment(x, y, 0.33, 0.32, 0.67, 0.66, 0.058) || inSegment(x, y, 0.67, 0.32, 0.33, 0.66, 0.058)
  );
}

function inBar(x, y) {
  return inSegment(x, y, 0.31, 0.49, 0.69, 0.49, 0.058);
}

function inDots(x, y) {
  return inDisc(x, y, 0.29, 0.49, 0.055) || inDisc(x, y, 0.5, 0.49, 0.055) || inDisc(x, y, 0.71, 0.49, 0.055);
}

/* ------------------------------------------------------------------ rasterizer */

function coverage(size, predicate, samples) {
  const cov = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        const v = (y + (sy + 0.5) / samples) / size;
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (x + (sx + 0.5) / samples) / size;
          if (predicate(u, v)) hits += 1;
        }
      }
      cov[y * size + x] = hits / (samples * samples);
    }
  }
  return cov;
}

/** Source-over compositing of one flat or gradient coloured layer. */
function composite(target, cov, size, colour) {
  const isGradient = typeof colour === 'function';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const alpha = cov[i];
      if (alpha <= 0) continue;

      const k = i * 4;
      const dstA = target[k + 3];
      const outA = alpha + dstA * (1 - alpha);
      const rgb = isGradient ? colour(x / (size - 1), y / (size - 1)) : colour;
      for (let c = 0; c < 3; c += 1) {
        const src = rgb[c] / 255;
        target[k + c] = (src * alpha + target[k + c] * dstA * (1 - alpha)) / outA;
      }
      target[k + 3] = outA;
    }
  }
}

function toBytes(target) {
  const out = new Uint8Array(target.length);
  for (let i = 0; i < target.length; i += 1) {
    const v = Math.round(Math.min(Math.max(target[i], 0), 1) * 255);
    out[i] = v;
  }
  return out;
}

function render(size, layers) {
  const samples = size >= 512 ? 3 : 6;
  const target = new Float32Array(size * size * 4);
  for (const layer of layers) {
    composite(target, coverage(size, layer.shape, samples), size, layer.rgb);
  }
  return encodePng(size, toBytes(target));
}

/* ------------------------------------------------------------------- palettes */

const STATE_COLOURS = {
  disconnected: [0x64, 0x74, 0x8b], // slate, visible on light and dark menubars
  connected: [0x22, 0xc5, 0x5e], // green
  connecting: [0xf5, 0x9e, 0x0b], // amber
  error: [0xef, 0x44, 0x44], // red
};

const WHITE = [0xff, 0xff, 0xff];

const STATE_GLYPHS = {
  disconnected: inBar,
  connected: inCheck,
  connecting: inDots,
  error: inCross,
};

/* ---------------------------------------------------------------------- icons */

function trayLayers(state) {
  return [
    { shape: inShield, rgb: STATE_COLOURS[state] },
    { shape: STATE_GLYPHS[state], rgb: WHITE },
  ];
}

/* ----------------------------------------------------------------------- main */

function write(fileName, buffer) {
  const target = path.join(ASSETS_DIR, fileName);
  fs.writeFileSync(target, buffer);
  return { target, bytes: buffer.length };
}

function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const written = [];
  const sizes = [
    { suffix: '', size: 16 },
    { suffix: '@2x', size: 32 },
    { suffix: '@3x', size: 48 },
    { suffix: '-16', size: 16 },
    { suffix: '-32', size: 32 },
    { suffix: '-64', size: 64 },
  ];

  for (const state of Object.keys(STATE_COLOURS)) {
    const layers = trayLayers(state);
    for (const { suffix, size } of sizes) {
      written.push({ ...write(`tray-${state}${suffix}.png`, render(size, layers)), size });
    }
  }

  for (const { target, size, bytes } of written) {
    process.stdout.write(`${size}x${size}  ${String(bytes).padStart(7)} bytes  ${path.relative(process.cwd(), target)}\n`);
  }
  process.stdout.write(`${written.length} files written to ${ASSETS_DIR}\n`);
}

main();
