// 画像の下ごしらえ（v0.4）: EXIF の向きを直す → 長辺を縮める → 縦長なら少し重ねて縦に分割 → JPEG で返す。
// 純JSのライブラリ（jpeg-js・pngjs）だけを使う。ネイティブ依存・外部コマンド・外部通信なし。
import { createRequire } from "node:module";
import jpeg from "jpeg-js";

const require = createRequire(import.meta.url);
interface PngData { width: number; height: number; data: Buffer; }
const PNG: { sync: { read(buf: Buffer): PngData } } = require("pngjs").PNG;

/** 返す画像の長辺の上限（AIが読む側でこれより大きいと縮められる大きさ） */
export const MAX_LONG_SIDE = 1568;
/** 縦長とみなす縦横比（高さ÷幅） */
export const TALL_RATIO = 2.5;
/** 縦長を分割するときの幅の上限 */
export const TALL_MAX_WIDTH = 1100;
/** 分割するときの重なり（px、縮めた後の大きさで） */
export const SPLIT_OVERLAP = 150;
/** 1ファイルから返す画像の枚数の上限 */
export const MAX_PIECES = 8;
/** デコードしてよい画素数の上限（メガピクセル） */
export const MAX_MEGAPIXELS = 60;
const JPEG_QUALITY = 85;

export interface ImageInfo {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** EXIF の向き（1〜8。無ければ 1） */
  orientation: number;
  /** EXIF の撮影日時（YYYY-MM-DD HH:MM:SS。無ければ undefined） */
  takenAt?: string;
}

export interface PreparedImage {
  /** 返す画像（JPEG/PNG のバイト列）。1枚なら分割なし */
  pieces: { data: Buffer; mimeType: string; width: number; height: number }[];
  /** 元の画像をそのまま返したか */
  passthrough: boolean;
  info: ImageInfo;
  /** 向きを直した後の元の大きさ */
  uprightWidth: number;
  uprightHeight: number;
  /** 縦長で分割したか */
  split: boolean;
  /** 縮めたか */
  resized: boolean;
}

export function detectMime(head: Buffer): "image/jpeg" | "image/png" | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return undefined;
}

// ---------- EXIF（向き・撮影日時）と大きさを、デコードせずに読む ----------
function parseExif(tiff: Buffer): { orientation: number; takenAt?: string } {
  const out: { orientation: number; takenAt?: string } = { orientation: 1 };
  if (tiff.length < 8) return out;
  const le = tiff.toString("latin1", 0, 2) === "II";
  if (!le && tiff.toString("latin1", 0, 2) !== "MM") return out;
  const u16 = (o: number) => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0);
  const u32 = (o: number) => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0);
  const ascii = (entry: number) => {
    const count = u32(entry + 4);
    const off = count <= 4 ? entry + 8 : u32(entry + 8);
    if (off + count > tiff.length) return undefined;
    return tiff.toString("latin1", off, off + count).replace(/\0+$/, "");
  };
  const readIfd = (off: number, cb: (tag: number, entry: number) => void) => {
    if (!off || off + 2 > tiff.length) return;
    const n = Math.min(u16(off), 512);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      cb(u16(e), e);
    }
  };
  let exifIfd = 0;
  let dateTime: string | undefined;
  readIfd(u32(4), (tag, e) => {
    if (tag === 0x0112) {
      const v = u16(e + 8);
      if (v >= 1 && v <= 8) out.orientation = v;
    } else if (tag === 0x8769) exifIfd = u32(e + 8);
    else if (tag === 0x0132) dateTime = ascii(e);
  });
  let original: string | undefined;
  readIfd(exifIfd, (tag, e) => {
    if (tag === 0x9003) original = ascii(e);
  });
  const t = original || dateTime;
  const m = t ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(t) : null;
  if (m) out.takenAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return out;
}

export function imageInfo(buf: Buffer): ImageInfo | undefined {
  const mime = detectMime(buf);
  if (mime === "image/png") {
    if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
    return { mime, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
  }
  if (mime !== "image/jpeg") return undefined;
  let pos = 2;
  let width = 0;
  let height = 0;
  let exif: { orientation: number; takenAt?: string } = { orientation: 1 };
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(pos + 2);
    const seg = buf.subarray(pos + 4, Math.min(buf.length, pos + 2 + len));
    if (marker === 0xe1 && seg.length > 14 && seg.toString("latin1", 0, 6) === "Exif\0\0") exif = parseExif(seg.subarray(6));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && seg.length >= 5) {
      height = seg.readUInt16BE(1);
      width = seg.readUInt16BE(3);
    }
    pos += 2 + len;
  }
  if (!width || !height) return undefined;
  return { mime, width, height, orientation: exif.orientation, takenAt: exif.takenAt };
}

// ---------- 画素の処理（RGBA → RGB 相当の RGBA。透明は白で埋める） ----------
interface Raster { w: number; h: number; d: Uint8Array; }

function decode(buf: Buffer, info: ImageInfo): Raster {
  if (info.width * info.height > MAX_MEGAPIXELS * 1e6) throw new Error("too large");
  if (info.mime === "image/jpeg") {
    const r = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
    return { w: r.width, h: r.height, d: r.data };
  }
  const p = PNG.sync.read(buf);
  const d = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length);
  // 透明部分は白の上に重ねる
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    d[i] = Math.round((d[i] * a + 255 * (255 - a)) / 255);
    d[i + 1] = Math.round((d[i + 1] * a + 255 * (255 - a)) / 255);
    d[i + 2] = Math.round((d[i + 2] * a + 255 * (255 - a)) / 255);
    d[i + 3] = 255;
  }
  return { w: p.width, h: p.height, d };
}

/** 面積平均で縮める（文字がつぶれにくい）。拡大はしない */
export function resizeBox(src: Raster, nw: number, nh: number): Raster {
  if (nw >= src.w && nh >= src.h) return src;
  const { w, h, d } = src;
  const out = new Uint8Array(nw * nh * 4);
  const xs = new Int32Array(nw + 1);
  for (let x = 0; x <= nw; x++) xs[x] = Math.min(w, Math.floor((x * w) / nw));
  const acc = new Float64Array(nw * 3);
  const cnt = new Float64Array(nw);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor(((y + 1) * h) / nh)));
    acc.fill(0);
    cnt.fill(0);
    for (let sy = y0; sy < y1; sy++) {
      const row = sy * w * 4;
      for (let x = 0; x < nw; x++) {
        const x0 = xs[x];
        const x1 = Math.max(x0 + 1, xs[x + 1]);
        let r = 0, g = 0, b = 0;
        for (let sx = x0; sx < x1; sx++) {
          const i = row + sx * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2];
        }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
        cnt[x] += x1 - x0;
      }
    }
    for (let x = 0; x < nw; x++) {
      const o = (y * nw + x) * 4;
      out[o] = Math.round(acc[x * 3] / cnt[x]);
      out[o + 1] = Math.round(acc[x * 3 + 1] / cnt[x]);
      out[o + 2] = Math.round(acc[x * 3 + 2] / cnt[x]);
      out[o + 3] = 255;
    }
  }
  return { w: nw, h: nh, d: out };
}

/** EXIF の向き（1〜8）に従って、見た目どおりの向きに直す */
export function orient(src: Raster, o: number): Raster {
  if (o <= 1 || o > 8) return src;
  const { w: W, h: H, d } = src;
  const swap = o >= 5;
  const w = swap ? H : W;
  const h = swap ? W : H;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx: number, sy: number;
      switch (o) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        default: sx = W - 1 - y; sy = x; break; // 8
      }
      const si = (sy * W + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = d[si]; out[di + 1] = d[si + 1]; out[di + 2] = d[si + 2]; out[di + 3] = 255;
    }
  }
  return { w, h, d: out };
}

function crop(src: Raster, top: number, height: number): Raster {
  const start = top * src.w * 4;
  return { w: src.w, h: height, d: src.d.slice(start, start + height * src.w * 4) };
}

function encodeJpeg(r: Raster): Buffer {
  return jpeg.encode({ width: r.w, height: r.h, data: r.d }, JPEG_QUALITY).data;
}

/** 縮めた後の大きさと分割の数を決める（向きを直した後の大きさで） */
export function plan(uw: number, uh: number): { scale: number; pieces: number; tall: boolean } {
  const tall = uh / uw > TALL_RATIO;
  if (!tall) {
    const scale = Math.min(1, MAX_LONG_SIDE / Math.max(uw, uh));
    return { scale, pieces: 1, tall };
  }
  let scale = Math.min(1, TALL_MAX_WIDTH / uw);
  const fit = (s: number) => Math.ceil((Math.round(uh * s) - SPLIT_OVERLAP) / (MAX_LONG_SIDE - SPLIT_OVERLAP));
  let pieces = Math.max(1, fit(scale));
  if (pieces > MAX_PIECES) {
    scale = (MAX_PIECES * (MAX_LONG_SIDE - SPLIT_OVERLAP) + SPLIT_OVERLAP) / uh;
    pieces = Math.max(1, Math.min(MAX_PIECES, fit(scale)));
  }
  return { scale, pieces, tall };
}

/**
 * 画像を AI が読みやすい形にする。向きが正しく、大きすぎず、縦長でなく、上限内なら元のまま返す（画質を落とさない）。
 * 読めない画像は例外を投げる。
 */
export function prepareImage(buf: Buffer, maxPassthroughBytes: number): PreparedImage {
  const info = imageInfo(buf);
  if (!info) throw new Error("not an image");
  const swap = info.orientation >= 5;
  const uw = swap ? info.height : info.width;
  const uh = swap ? info.width : info.height;
  const p = plan(uw, uh);
  if (info.orientation === 1 && p.scale >= 1 && p.pieces === 1 && buf.length <= maxPassthroughBytes) {
    return { pieces: [{ data: buf, mimeType: info.mime, width: uw, height: uh }], passthrough: true, info, uprightWidth: uw, uprightHeight: uh, split: false, resized: false };
  }
  let r = decode(buf, info);
  // 先に縮めてから向きを直す（計算を軽くする）。縮める比率は向きに関係なく同じ
  if (p.scale < 1) r = resizeBox(r, Math.max(1, Math.round(r.w * p.scale)), Math.max(1, Math.round(r.h * p.scale)));
  r = orient(r, info.orientation);
  const pieces: PreparedImage["pieces"] = [];
  if (p.pieces <= 1) {
    pieces.push({ data: encodeJpeg(r), mimeType: "image/jpeg", width: r.w, height: r.h });
  } else {
    const n = p.pieces;
    const ph = Math.min(r.h, Math.ceil((r.h + (n - 1) * SPLIT_OVERLAP) / n));
    for (let i = 0; i < n; i++) {
      const top = i === n - 1 ? r.h - ph : Math.min(r.h - ph, i * (ph - SPLIT_OVERLAP));
      const c = crop(r, Math.max(0, top), ph);
      pieces.push({ data: encodeJpeg(c), mimeType: "image/jpeg", width: c.w, height: c.h });
    }
  }
  return { pieces, passthrough: false, info, uprightWidth: uw, uprightHeight: uh, split: pieces.length > 1, resized: p.scale < 1 };
}
