// Generates the PWA icon set with no image dependencies: draws a geometric
// sprout onto an RGBA buffer (3x3 supersampled) and encodes PNG via zlib.
// Usage: node scripts/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// --- minimal PNG encoder -----------------------------------------------------

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
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry ------------------------------------------------------------

// Pointed leaf (vesica lens) from p to q; fat = half-width as fraction of length.
function leaf(p, q, fat = 0.18) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const d = Math.hypot(dx, dy);
  const u = (fat * fat + 0.25) / (2 * fat); // R/d so lens half-width = fat*d
  const R = u * d;
  const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4));
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const nx = (-dy / d) * h;
  const ny = (dx / d) * h;
  const c1 = [mx + nx, my + ny];
  const c2 = [mx - nx, my - ny];
  return (x, y) =>
    Math.hypot(x - c1[0], y - c1[1]) <= R && Math.hypot(x - c2[0], y - c2[1]) <= R;
}

// Thick quadratic bezier (sampled).
function stem(p0, p1, p2, w) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    pts.push([
      a * p0[0] + b * p1[0] + c * p2[0],
      a * p0[1] + b * p1[1] + c * p2[1],
    ]);
  }
  return (x, y) => pts.some((p) => Math.hypot(x - p[0], y - p[1]) <= w);
}

// --- artwork ------------------------------------------------------------

const BG = [0x1a, 0x2f, 0x23, 255];
const GREEN_DARK = [0x4f, 0xae, 0x7c, 255];
const GREEN = [0x7f, 0xd4, 0xa0, 255];
const GREEN_LIGHT = [0xa9, 0xe8, 0xc2, 255];

function appIconShapes() {
  return [
    [stem([0.5, 0.86], [0.47, 0.62], [0.5, 0.4], 0.022), GREEN_DARK],
    [leaf([0.5, 0.66], [0.2, 0.42], 0.21), GREEN_DARK],
    [leaf([0.5, 0.56], [0.8, 0.3], 0.21), GREEN],
    [leaf([0.5, 0.42], [0.47, 0.1], 0.19), GREEN_LIGHT],
  ];
}

function badgeShapes() {
  const W = [255, 255, 255, 255];
  return [
    [stem([0.5, 0.95], [0.46, 0.6], [0.5, 0.3], 0.045), W],
    [leaf([0.5, 0.62], [0.08, 0.3], 0.23), W],
    [leaf([0.5, 0.48], [0.92, 0.16], 0.23), W],
  ];
}

function render(size, shapes, bg) {
  const SS = 3;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let c = bg;
          for (const [test, color] of shapes) if (test(x, y)) c = color;
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      rgba[i] = r / n;
      rgba[i + 1] = g / n;
      rgba[i + 2] = b / n;
      rgba[i + 3] = a / n;
    }
  }
  return rgba;
}

const outDir = path.join(import.meta.dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [512, 192, 180]) {
  const png = encodePNG(size, render(size, appIconShapes(), BG));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`icon-${size}.png (${png.length} bytes)`);
}
{
  const png = encodePNG(72, render(72, badgeShapes(), [0, 0, 0, 0]));
  fs.writeFileSync(path.join(outDir, 'badge-72.png'), png);
  console.log(`badge-72.png (${png.length} bytes)`);
}
