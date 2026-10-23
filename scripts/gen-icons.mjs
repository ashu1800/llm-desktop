// 零依赖图标生成脚本:产出应用图标(bundle)与三色托盘图标(运行/停止/异常)
// 这些是占位图形,正式视觉稿可直接替换 src-tauri/icons 下同名文件
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const off = y * stride + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
function inRoundedRect(x, y, w, h, r) {
  const x1 = r,
    x2 = w - r,
    y1 = r,
    y2 = h - r;
  const dx = x < x1 ? x1 - x : x > x2 ? x - x2 : 0;
  const dy = y < y1 ? y1 - y : y > y2 ? y - y2 : 0;
  return dx * dx + dy * dy <= r * r;
}

// 应用图标:深色圆角方块 + 白环 + 翡翠圆心(网关意象)
function drawAppIcon(size) {
  return encodePng(size, (x, y) => {
    const r = size * 0.22;
    if (!inRoundedRect(x + 0.5, y + 0.5, size, size, r)) return [0, 0, 0, 0];
    const c = size / 2;
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const R = size * 0.3;
    if (d < R * 0.62) return [16, 185, 129, 255];
    if (d < R) return [255, 255, 255, 255];
    return [15, 23, 42, 255];
  });
}

// 托盘图标:透明底 + 白环 + 状态色圆心
function drawTrayIcon([r, g, b], size = 32) {
  return encodePng(size, (x, y) => {
    const c = size / 2;
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const R = size * 0.42;
    if (d < R - size * 0.09) return [r, g, b, 255];
    if (d < R) return [255, 255, 255, 255];
    return [0, 0, 0, 0];
  });
}

// ---------- ICO 编码(PNG 条目,Vista+) ----------
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = e[0];
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
}

// ---------- 输出 ----------
const files = {
  "32x32.png": drawAppIcon(32),
  "128x128.png": drawAppIcon(128),
  "128x128@2x.png": drawAppIcon(256),
  "icon.png": drawAppIcon(512),
  "tray-green.png": drawTrayIcon([16, 185, 129]),
  "tray-gray.png": drawTrayIcon([148, 163, 184]),
  "tray-red.png": drawTrayIcon([239, 68, 68]),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(outDir, name), buf);
  console.log("生成", name, buf.length, "bytes");
}
writeFileSync(
  join(outDir, "icon.ico"),
  encodeIco([
    { size: 32, buf: drawAppIcon(32) },
    { size: 48, buf: drawAppIcon(48) },
    { size: 256, buf: drawAppIcon(256) },
  ])
);
console.log("生成 icon.ico");
