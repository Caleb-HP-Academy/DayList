// Generates assets/icon.ico (a blue rounded square with a white check) using
// only Node built-ins. Run: node assets/make-icon.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = parseInt(process.env.ICON_SIZE || '256', 10);
const OUT = process.env.ICON_OUT || __dirname;

function buildPixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const k = SIZE / 256;        // scale factor from the 256-space design
  const radius = 48 * k;       // rounded corner radius
  const bg = [91, 140, 255];   // #5b8cff accent

  // checkmark polyline points (scaled from 256 space)
  const pts = [
    [70 * k, 138 * k],
    [112 * k, 180 * k],
    [190 * k, 84 * k]
  ];
  const stroke = 22 * k;

  const insideRounded = (x, y) => {
    const r = radius;
    if (x >= r && x <= SIZE - r) return y >= 0 && y <= SIZE;
    if (y >= r && y <= SIZE - r) return x >= 0 && x <= SIZE;
    // corners
    const cx = x < r ? r : SIZE - r;
    const cy = y < r ? r : SIZE - r;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  const distToSeg = (px_, py_, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px_ - ax) * dx + (py_ - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return Math.hypot(px_ - qx, py_ - qy);
  };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; // transparent
        continue;
      }
      // check distance to the checkmark stroke
      let d = Infinity;
      for (let s = 0; s < pts.length - 1; s++) {
        d = Math.min(d, distToSeg(x + 0.5, y + 0.5, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
      }
      if (d <= stroke / 2) {
        // white check with slight anti-alias
        const a = d > stroke / 2 - 1.5 ? Math.max(0, 1 - (d - (stroke / 2 - 1.5)) / 1.5) : 1;
        px[i] = Math.round(255 * a + bg[0] * (1 - a));
        px[i + 1] = Math.round(255 * a + bg[1] * (1 - a));
        px[i + 2] = Math.round(255 * a + bg[2] * (1 - a));
        px[i + 3] = 255;
      } else {
        px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255;
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // add filter byte (0) per scanline
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 -> 0
  entry[1] = 0; // height 256 -> 0
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  return Buffer.concat([header, entry, png]);
}

const pixels = buildPixels();
const png = makePng(pixels);
const ico = makeIco(png);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
fs.writeFileSync(path.join(OUT, 'icon.png'), png);
console.log('Wrote icon.ico + icon.png at ' + SIZE + 'px to ' + OUT);
