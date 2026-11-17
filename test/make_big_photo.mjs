// v0.4 のテスト用「4MB 超の写真」（big_photo.jpg）を、フォントなしでその場で作る（架空。文字は描かない）。
// リポジトリには 5.7MB の big_photo.jpg を入れないため、test/fixtures/v04/big_photo.jpg が無いときに v04.test.mjs が使う。
// 中身: iPhone と同じ 4032×3024 保存・EXIF 向き=6（表示は 3024×4032）、撮影日時 2026:11:01 10:05:00。
// 表示の左上に向き確認用の黒い四角（40〜200px）、本文の代わりに黒い横線、全体に紙のようなむら（ファイルを大きくするため）。
// 使い方（単体）: node test/make_big_photo.mjs <出力ファイル>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

/** 4MB 超の JPEG（EXIF 向き=6・撮影日時入り）を Buffer で返す。乱数は固定なので毎回同じ */
export function makeBigPhoto() {
  const DW = 3024, DH = 4032; // 表示の大きさ
  const W = DH, H = DW; // 保存の大きさ（左に90度回した画素）
  const data = Buffer.alloc(W * H * 4);
  let seed = 12345;
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    // 保存 (sx,sy) = 表示 (DW-1-sy, sx)
    const x = DW - 1 - sy, y = sx;
    let v = 255;
    if (x >= 40 && x < 200 && y >= 40 && y < 200) v = 0; // 向きの目印
    else if (x >= 120 && x < DW - 120 && y >= 480 && y < 1600 && (y - 480) % 200 < 48 && (x * 7 + y) % 900 < 760) v = 0; // 文字の代わりの線
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed % 49) - 24;
    const c = Math.max(0, Math.min(255, v + n));
    const i = (sy * W + sx) * 4;
    data[i] = data[i + 1] = data[i + 2] = c;
    data[i + 3] = 255;
  }
  const jpg = jpeg.encode({ width: W, height: H, data }, 95).data;
  return withExif(jpg, 6, "2026:11:01 10:05:00");
}

/** EXIF（向き・日時）だけの APP1 を JPEG の先頭に入れる（make_fixtures.mjs と同じ形） */
function withExif(jpg, orientation, dateTime) {
  const dt = Buffer.from(dateTime + "\0", "latin1");
  const n = 2;
  const ifdLen = 2 + n * 12 + 4;
  const tiff = Buffer.alloc(8 + ifdLen + dt.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(n, 8);
  let e = 10;
  tiff.writeUInt16LE(0x0112, e); tiff.writeUInt16LE(3, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt16LE(orientation, e + 8); e += 12;
  tiff.writeUInt16LE(0x0132, e); tiff.writeUInt16LE(2, e + 2); tiff.writeUInt32LE(dt.length, e + 4); tiff.writeUInt32LE(8 + ifdLen, e + 8); e += 12;
  tiff.writeUInt32LE(0, e);
  dt.copy(tiff, 8 + ifdLen);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([jpg.subarray(0, 2), head, body, jpg.subarray(2)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("出力ファイルを指定してください");
  const b = makeBigPhoto();
  fs.writeFileSync(out, b);
  console.log(out, b.length);
}
