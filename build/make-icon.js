// Writes build/icon.png (256x256) from the icon drawn in icon.js, so the exe and
// installer get the same icon as the tray. electron-builder turns it into an .ico.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { drawIcon } = require('../icon');

const SIZE = 256;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// drawIcon gives premultiplied BGRA (what nativeImage wants); PNG wants straight RGBA.
const bgra = drawIcon(SIZE);
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const a = bgra[i + 3];
    const un = (v) => (a ? Math.min(255, Math.round((v * 255) / a)) : 0);
    raw[o] = un(bgra[i + 2]);
    raw[o + 1] = un(bgra[i + 1]);
    raw[o + 2] = un(bgra[i]);
    raw[o + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('Wrote build/icon.png');
