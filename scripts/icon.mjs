// Infinitum app icons: black letters in the brand font on white, inside a black square frame,
// with ™ set like the wordmark's superscript. One file draws every product's mark:
//   veil "V |™"   cumulus "://™"   fabric "F++™"   scalvs "S™"
// The letters are the brand font's glyph outlines (scripts/icon-glyphs.json: the brand stack
// "Helvetica Neue", Helvetica, Arial, in its bold cut (Arial Bold here) so the marks read heavier; ™ at .38em with its top on cap height).
//
//   node scripts/icon.mjs                 VEIL: veil-vpn/icon.svg, site/icon.svg, the Android mipmap
//                                         launcher PNGs and store/play/images/icon-512.png
//   node scripts/icon.mjs <mark> <dir>    any mark: icon.svg, icon-<px>.png and an Android res/ tree
//                                         (mipmap-*/ic_launcher.png and ic_launcher_round.png) in <dir>
// scripts/build.mjs draws VEIL's extension PNGs with pngIcon().
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import GLYPHS from './icon-glyphs.json' with { type: 'json' };

// Design grid 512 x 512. Frame: a black square outline inset from the edge.
const FRAME_IN = 34, FRAME_W = 26;

/** The mark's outlines in the 512 grid, enlarged to fill the frame (70% of the width, 50% of the height) and centred. */
export function layout(name) {
  const g = GLYPHS[name];
  if (!g) throw new Error(`unknown mark ${name}`);
  const pts = g.flat(), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.min((512 * 0.70) / (x1 - x0), (512 * 0.50) / (y1 - y0));
  const ox = 256 - ((x0 + x1) / 2) * s, oy = 256 - ((y0 + y1) / 2) * s;
  return g.map((c) => c.map(([x, y]) => [ox + x * s, oy + y * s]));
}

// Even-odd fill over all contours (handles counters if a mark ever has one).
const inGlyphs = (C, x, y) => {
  let c = false;
  for (const poly of C) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** PNG at size x size: white square, black frame, black letters with ™; 6x6 supersampled. */
export function pngIcon(size, name = 'veil') {
  const C = layout(name), N = 6, k = 512 / size, raw = Buffer.alloc(size * (size * 4 + 1));
  // Keep the frame at least ~1 px wide and off the edge in small toolbar icons.
  const fw = Math.max(FRAME_W, 1.1 * k), fin = Math.min(FRAME_IN, FRAME_IN * (size / 64));
  const frame = (x, y) => { const a = fin, b = fin + fw; return x >= a && x <= 512 - a && y >= a && y <= 512 - a && !(x > b && x < 512 - b && y > b && y < 512 - b); };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let ink = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const px = (x + (sx + 0.5) / N) * k, py = (y + (sy + 0.5) / N) * k;
        if (frame(px, py) || inGlyphs(C, px, py)) ink++;
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = raw[i + 1] = raw[i + 2] = Math.round(255 * (1 - ink / (N * N)));
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const r = (n) => +n.toFixed(1);
export function svgIcon(name = 'veil') {
  const f = FRAME_IN + FRAME_W / 2, fs = 512 - 2 * f;
  const d = layout(name).map((c) => c.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)} ${r(y)}`).join('') + 'Z').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff"/>`
    + `<rect x="${f}" y="${f}" width="${fs}" height="${fs}" fill="none" stroke="#000" stroke-width="${FRAME_W}"/>`
    + `<path fill="#000" fill-rule="evenodd" d="${d}"/></svg>\n`;
}

/** Android launcher PNGs (legacy mipmaps, drawn as they are): res/mipmap-<dpi>/ic_launcher(_round).png. */
export function writeAndroidRes(resDir, name) {
  for (const [dpi, px] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    const dir = path.join(resDir, `mipmap-${dpi}`);
    mkdirSync(dir, { recursive: true });
    const png = pngIcon(px, name);
    writeFileSync(path.join(dir, 'ic_launcher.png'), png);
    writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, dir] = process.argv.slice(2);
  if (name) {
    if (!dir) throw new Error('usage: node scripts/icon.mjs <veil|cumulus|fabric|scalvs> <dir>');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'icon.svg'), svgIcon(name));
    for (const s of [16, 32, 48, 96, 192, 512]) writeFileSync(path.join(dir, `icon-${s}.png`), pngIcon(s, name));
    writeAndroidRes(path.join(dir, 'res'), name);
    console.log(`Wrote the ${name} icon set to ${dir}`);
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const p = (...x) => path.join(root, ...x);
    for (const f of ['veil-vpn/icon.svg', 'site/icon.svg']) writeFileSync(p(f), svgIcon('veil'));
    writeFileSync(p('store/play/images/icon-512.png'), pngIcon(512, 'veil'));
    writeAndroidRes(p('android/app/src/main/res'), 'veil');
    console.log('Wrote icon.svg (app and site), the Android launcher PNGs and the 512 px store icon');
  }
}
