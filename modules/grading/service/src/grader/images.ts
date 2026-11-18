// Images an agent attached, made fit for a vision model: the type sniffed from the bytes (never the name), the pixel size
// read from the header, and a large 8-bit PNG (what a browser screenshot is) box-downscaled with node:zlib, no image library.
// The bytes are untrusted: the size is checked before anything is inflated, and the inflate is capped.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const MAX_PIXELS = 40_000_000; // a PNG decoded only up to this (≈ 160 MB of RGBA rows)

/** { type, width, height } from the first bytes, or null for anything that isn't a PNG, JPEG, GIF or WebP. */
/** An image's type and pixel size, read from its header. */
export interface ImageInfo {
  type: "image/png" | "image/gif" | "image/webp" | "image/jpeg";
  width: number;
  height: number;
}

export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("latin1", 12, 16) === "IHDR") return { type: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") return { type: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") { const b = buf.readUInt32LE(21); return { type: "image/webp", width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    if (chunk === "VP8 ") return { type: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk the segments to the first start-of-frame (SOF0..SOF15, not DHT/JPG/DAC).
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1]!;
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * The capture stamp aidenhq-browse and ui-review write into their screenshots: the `aidenhq` tEXt chunk's JSON ({ commit,
 * tree, url, width, mode, takenAt }), or null for any other image (or a stamp that doesn't parse). Read before IDAT only.
 */
export function pngStamp(buf: Buffer): Record<string, unknown> | null {
  if (imageInfo(buf)?.type !== "image/png") return null;
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i), type = buf.toString("latin1", i + 4, i + 8);
    if (type === "IDAT" || type === "IEND" || i + 12 + len > buf.length) return null;
    if (type === "tEXt") {
      const d = buf.subarray(i + 8, i + 8 + len), z = d.indexOf(0);
      if (z > 0 && d.toString("latin1", 0, z) === "aidenhq") {
        try {
          const s = JSON.parse(d.toString("latin1", z + 1));
          return s && typeof s === "object" ? s : null;
        } catch {
          return null;
        }
      }
    }
    i += 12 + len;
  }
  return null;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG box-downscaled by a whole factor so its longest side is at most `maxSide`: a new PNG (8-bit RGB or RGBA), or null
 * when it can't be (not 8-bit, interlaced, too many pixels, corrupt).
 */
export function downscalePng(buf: Buffer, maxSide: number): Buffer | null {
  try {
    const info = imageInfo(buf);
    if (!info) return null;
    const { width: w, height: h } = info;
    const depth = buf[24], color = buf[25]!, interlace = buf[28];
    const ch = CHANNELS[color];
    if (depth !== 8 || interlace !== 0 || !ch || !w || !h || w * h > MAX_PIXELS) return null;
    const idat: Buffer[] = [];
    let palette: Buffer | undefined;
    for (let i = 8; i + 8 <= buf.length; ) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("latin1", i + 4, i + 8);
      if (type === "IDAT") idat.push(buf.subarray(i + 8, i + 8 + len));
      if (type === "PLTE") palette = buf.subarray(i + 8, i + 8 + len);
      if (type === "IEND") break;
      i += 12 + len;
    }
    if (color === 3 && !palette) return null;
    const stride = w * ch;
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: h * (stride + 1) });
    if (raw.length < h * (stride + 1)) return null;
    const outCh = color === 3 || color === 2 ? 3 : color === 0 ? 1 : color === 4 ? 2 : 4;
    const k = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
    const W = Math.ceil(w / k), H = Math.ceil(h / k);
    const out = Buffer.alloc(H * (W * outCh + 1));
    let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
    const sums = new Float64Array(W * outCh), counts = new Uint32Array(W);
    for (let y = 0; y < h; y++) {
      // Unfilter one row (PNG filters 0-4) against the previous one.
      const f = raw[y * (stride + 1)]!;
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch]! : 0, b = prev[x]!, c = x >= ch ? prev[x - ch]! : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (row[x]! + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 0xff;
      }
      for (let x = 0; x < w; x++) {
        const o = Math.floor(x / k);
        if (color === 3) for (let j = 0; j < 3; j++) sums[o * 3 + j]! += palette![cur[x]! * 3 + j] ?? 0;
        else for (let j = 0; j < ch; j++) sums[o * ch + j]! += cur[x * ch + j]!;
        counts[o]!++;
      }
      [prev, cur] = [cur, prev];
      if ((y + 1) % k === 0 || y === h - 1) {
        const Y = Math.floor(y / k), base = Y * (W * outCh + 1);
        for (let o = 0; o < W; o++) for (let j = 0; j < outCh; j++) out[base + 1 + o * outCh + j] = Math.round(sums[o * outCh + j]! / counts[o]!);
        sums.fill(0);
        counts.fill(0);
      }
    }
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "latin1");
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
      return Buffer.concat([head, data, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[outCh]!;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(out)), chunk("IEND", Buffer.alloc(0))]);
  } catch {
    return null;
  }
}
