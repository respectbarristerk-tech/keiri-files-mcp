// テスト用の架空の証憑ファイル10件を作る（v0.2: 日付・取引先・金額・書類種別・登録番号が実際に読める）。
// 社名・宛名はすべて架空。登録番号は先頭0の架空番号。実在の社名・個人情報なし。
// 画像は pureimage、PDF は pdfkit（どちらも devDependencies。.mcpb には入らない）。
// 使い方: node test/make_fixtures.mjs [日本語TTFのパス] [欧文TTFのパス]
//   v0.4 の read_file 用（EXIF 向き=6 の JPG・縦長 JPEG を埋めた PDF・4MB 超の JPG）だけを作る: node test/make_fixtures.mjs --v04 [フォント...]
//   → test/fixtures/v04/ に出力（既存の receipts/ は変えない）
//   日本語フォントは 引数1 → 環境変数 KEIRI_FIXTURE_FONT → 候補、欧文（数字・記号用）は 引数2 → KEIRI_FIXTURE_FONT_LATIN → 候補
//   （TTF/OTF。TTCは不可）。日本語フォントに無い文字は欧文フォントで描く
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as PImage from "pureimage";
import PDFDocument from "pdfkit";
import jpeg from "jpeg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures", "receipts");
fs.mkdirSync(dir, { recursive: true });

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const V04 = process.argv.includes("--v04");
const candidates = [
  args[0],
  process.env.KEIRI_FIXTURE_FONT,
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
  "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
].filter(Boolean);
const FONT = candidates.find((p) => fs.existsSync(p));
if (!FONT) throw new Error("日本語の TTF フォントが見つかりません。引数か KEIRI_FIXTURE_FONT で指定してください。");
const LATIN = [args[1], process.env.KEIRI_FIXTURE_FONT_LATIN, "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/arial.ttf", "/Library/Fonts/Arial.ttf"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!LATIN) throw new Error("欧文の TTF フォントが見つかりません。引数2か KEIRI_FIXTURE_FONT_LATIN で指定してください。");
const jpFont = PImage.registerFont(FONT, "JP").loadSync();
PImage.registerFont(LATIN, "LAT").loadSync();
/** 文字列を「日本語フォントで描ける部分」と「欧文フォントで描く部分」に分ける */
function segments(t) {
  const out = [];
  for (const ch of t) {
    const f = jpFont.font.charToGlyphIndex(ch) > 0 ? "JP" : "LAT";
    if (out.length && out[out.length - 1][0] === f) out[out.length - 1][1] += ch;
    else out.push([f, ch]);
  }
  return out;
}

const MARK = "※架空のテスト用見本です";
const yen = (n) => "¥" + n.toLocaleString("ja-JP");
const jdate = (d) => { const [y, m, dd] = d.split("-"); return `${y}年${Number(m)}月${Number(dd)}日`; };

// ---------- 中身（readings.json と一致させる） ----------
// kind: receipt=画像レシート / pdf=請求書等のPDF
const docs = [
  { file: "invoice_001.pdf", title: "請 求 書", vendor: "架空商事テスト株式会社", date: "2026-10-01", amount: 55000, reg: "T0000000000001",
    lines: [["業務委託費（10月分・見本）", 50000]], to: "サンプル利用者 様" },
  { file: "invoice_002.pdf", title: "請 求 書", vendor: "ダミーデザイン工房", date: "2026-10-05", amount: 33000, reg: "T0000000000002",
    lines: [["ロゴ制作（見本）", 30000]], to: "サンプル利用者 様" },
  { file: "見積書 サンプル.pdf", title: "御 見 積 書", vendor: "架空商事テスト株式会社", date: "2026-10-07", amount: 110000, reg: "",
    lines: [["システム保守（年間・見本）", 100000]], to: "サンプル利用者 様" },
  { file: "納品書_003.pdf", title: "納 品 書", vendor: "サンプル部品店", date: "2026-10-09", amount: 8800, reg: "",
    lines: [["試験用部品A ×4", 8000]], to: "サンプル利用者 様" },
  { file: "IMG_0001.jpg", title: "領 収 書", vendor: "テスト文具店", date: "2026-10-10", amount: 1320, reg: "T0000000000003",
    lines: [["ノート ×2", 600], ["ボールペン ×3", 600]], time: "14:05" },
  { file: "IMG_0002.JPG", title: "領 収 書", vendor: "テスト文具店", date: "2026-10-10", amount: 1320, reg: "T0000000000003",
    lines: [["ノート ×2", 600], ["ボールペン ×3", 600]], time: "14:05" },
  { file: "レシート 003.png", title: "領 収 書", vendor: "架空カフェ 試験店", date: "2026-10-12", amount: 980, reg: "",
    lines: [["ブレンドコーヒー", 480], ["見本サンド", 427]], time: "09:32", rate: 8 },
  { file: "scan_004.png", title: "領 収 書", vendor: "見本交通（架空）", date: "2026-10-15", amount: 2400, reg: "",
    lines: [["乗車料金（見本）", 2182]], time: "21:47" },
  { file: "receipt_005.jpg", title: "領 収 書", vendor: "Fictional Books/Test", date: "2026-10-20", amount: 3300, reg: "T0000000000004",
    lines: [["技術書（見本）", 3000]], time: "18:10" },
  { file: "receipt_006.jpeg", title: "ご利用明細", vendor: "架空通信サービス", date: "2026-10-25", amount: 5500, reg: "",
    lines: [["通信料（10月分・見本）", 5000]], time: "00:00" },
];

/** 書類に印字する文字列（行ごと）。テストで「埋め込まれているか」を確かめるためにも使う */
export function docText(d) {
  const rate = d.rate ?? 10;
  const tax = d.amount - d.lines.reduce((s, [, v]) => s + v, 0);
  const out = [d.title];
  if (d.to) out.push(d.to);
  out.push(d.vendor);
  if (d.reg) out.push(`登録番号 ${d.reg}`);
  out.push(`日付 ${d.date}（${jdate(d.date)}）${d.time ? " " + d.time : ""}`);
  out.push("----------------------------");
  for (const [name, v] of d.lines) out.push(`${name}  ${yen(v)}`);
  out.push(`消費税（${rate}%）  ${yen(tax)}`);
  out.push(`合計（税込）  ${yen(d.amount)}`);
  out.push("----------------------------");
  out.push(MARK);
  return out;
}

async function image(d, file) {
  const lines = docText(d);
  const LH = 50, H = 80 + lines.length * LH + 40;
  const size = (t, i) => (i === 0 || t.startsWith("合計") ? 36 : 24);
  const measure = PImage.make(10, 10).getContext("2d");
  const width = (t, i) => segments(t).reduce((w, [f, seg]) => { measure.font = `${size(t, i)}pt ${f}`; return w + measure.measureText(seg).width; }, 0);
  const W = Math.ceil(Math.max(...lines.map(width)) + 60);
  const img = PImage.make(W, H);
  const ctx = img.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  lines.forEach((t, i) => {
    let x = 30;
    for (const [f, seg] of segments(t)) {
      ctx.font = `${size(t, i)}pt ${f}`;
      ctx.fillText(seg, x, 80 + i * LH);
      x += ctx.measureText(seg).width;
    }
  });
  const ws = fs.createWriteStream(file);
  if (/\.png$/i.test(file)) await PImage.encodePNGToStream(img, ws);
  else await PImage.encodeJPEGToStream(img, ws, 92);
}

function pdf(d, file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "架空のテスト用見本", Producer: "keiri-files-mcp test", CreationDate: new Date(Date.UTC(2026, 9, 1)) } });
    const ws = fs.createWriteStream(file);
    ws.on("finish", resolve);
    ws.on("error", reject);
    doc.pipe(ws);
    doc.registerFont("JP", FONT);
    doc.registerFont("LAT", LATIN);
    docText(d).forEach((t, i) => {
      doc.fontSize(i === 0 ? 26 : t.startsWith("合計") ? 18 : 13);
      const segs = segments(t);
      segs.forEach(([f, seg], k) => doc.font(f).text(seg, { continued: k < segs.length - 1 }));
      doc.moveDown(0.4);
    });
    doc.end();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !V04) {
  for (const d of docs) {
    const file = path.join(dir, d.file);
    if (d.file.endsWith(".pdf")) await pdf(d, file);
    else await image(d, file);
  }
  fs.writeFileSync(path.join(here, "fixtures", "doc_texts.json"), JSON.stringify(Object.fromEntries(docs.map((d) => [d.file, docText(d)])), null, 2) + "\n");
  console.log(`created ${docs.length} files in ${path.relative(process.cwd(), dir)} (fonts: ${path.basename(FONT)} + ${path.basename(LATIN)})`);
}

// ---------- v0.4: read_file の下ごしらえの試験用（すべて架空。実物のレシートは使わない） ----------
const v04Dir = path.join(here, "fixtures", "v04");
export const V04_DOCS = {
  "exif6_receipt.jpg": { vendor: "架空マート 見本店", date: "2026-10-30", amount: 1650, reg: "T0000000000005",
    lines: [["見本ノート", 500], ["見本ペン ×2", 1000]], time: "12:34" },
  "scan_tall.pdf": { vendor: "架空ホームセンター 試験店", date: "2026-10-31", amount: 0, reg: "T0000000000006", time: "15:20",
    lines: Array.from({ length: 64 }, (_, i) => [`見本品 ${String(i + 1).padStart(2, "0")}`, 100 + i * 10]) },
  "big_photo.jpg": { vendor: "架空書店 見本", date: "2026-11-01", amount: 2200, reg: "T0000000000007",
    lines: [["見本の本", 2000]], time: "10:05" },
};
{
  const d = V04_DOCS["scan_tall.pdf"];
  d.amount = Math.round(d.lines.reduce((s, [, v]) => s + v, 0) * 1.1);
}

/** 正しい向きのレシートを描く。左上に向きの確認用の黒い四角（scale*40 角）を置く */
function drawReceipt(d, scale, minW, minH, noise = 0) {
  const lines = docText({ title: "領 収 書", ...d });
  const LH = 50 * scale;
  const H = Math.max(minH, Math.ceil(120 * scale + lines.length * LH + 40 * scale));
  const fs0 = (t, i) => (i === 0 || t.startsWith("合計") ? 36 : 24) * scale;
  const W = minW;
  const img = PImage.make(W, H);
  const ctx = img.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  ctx.fillRect(10 * scale, 10 * scale, 40 * scale, 40 * scale);
  lines.forEach((t, i) => {
    let x = 30 * scale;
    for (const [f, seg] of segments(t)) {
      ctx.font = `${fs0(t, i)}pt ${f}`;
      ctx.fillText(seg, x, 120 * scale + i * LH);
      x += ctx.measureText(seg).width;
    }
  });
  const data = Buffer.from(img.data);
  if (noise) {
    // 紙の質感のような細かいむら（ファイルを大きくするため）
    let seed = 12345;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed % (2 * noise + 1)) - noise;
      for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, data[i + c] + n));
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** 正しい向きの画像を、EXIF 向き=6（右に90度回して表示）で保存する形（左に90度回した画素）にする */
function storeAsOrientation6(u) {
  const W = u.height, H = u.width; // 保存される大きさ
  const out = Buffer.alloc(W * H * 4);
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    // 表示 (x,y) = 保存 (y, H-1-x) → 保存 (sx,sy) = 表示 (H-1-sy, sx)
    const ux = H - 1 - sy, uy = sx;
    u.data.copy(out, (sy * W + sx) * 4, (uy * u.width + ux) * 4, (uy * u.width + ux) * 4 + 4);
  }
  return { width: W, height: H, data: out };
}

/** EXIF（向き・日時）だけの APP1 を JPEG の先頭に入れる */
function withExif(jpg, orientation, dateTime) {
  const dt = Buffer.from(dateTime + "\0", "latin1"); // 20 バイト
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

function tallPdf(jpg, w, h, file) {
  return new Promise((resolve, reject) => {
    // iOS のスキャンと同じ形: 1ページに JPEG 1枚だけ（文字情報なし）
    const doc = new PDFDocument({ size: [w * 0.5, h * 0.5], margin: 0, info: { Title: "架空のテスト用見本", Producer: "keiri-files-mcp test", CreationDate: new Date(Date.UTC(2026, 9, 31)) } });
    const ws = fs.createWriteStream(file);
    ws.on("finish", resolve);
    ws.on("error", reject);
    doc.pipe(ws);
    doc.image(jpg, 0, 0, { width: w * 0.5, height: h * 0.5 });
    doc.end();
  });
}

if (V04 && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(v04Dir, { recursive: true });
  // 1) EXIF 向き=6 の JPG（表示は 900×1200、保存は 1200×900）
  const a = storeAsOrientation6(drawReceipt(V04_DOCS["exif6_receipt.jpg"], 1, 900, 1200));
  fs.writeFileSync(path.join(v04Dir, "exif6_receipt.jpg"), withExif(jpeg.encode(a, 90).data, 6, "2026:10:30 12:34:56"));
  // 2) 縦長 JPEG（834×3885）を1ページに貼った PDF
  const t = drawReceipt(V04_DOCS["scan_tall.pdf"], 1, 834, 3885);
  const tj = jpeg.encode(t, 85).data;
  await tallPdf(tj, t.width, t.height, path.join(v04Dir, "scan_tall.pdf"));
  // 3) 4MB 超の JPG（iPhone と同じ 4032×3024 保存・EXIF 向き=6。表示は 3024×4032）
  const b = storeAsOrientation6(drawReceipt(V04_DOCS["big_photo.jpg"], 4, 3024, 4032, 24));
  const bj = withExif(jpeg.encode(b, 95).data, 6, "2026:11:01 10:05:00");
  if (bj.length <= 4 * 1024 * 1024) throw new Error(`big_photo.jpg が 4MB 以下です (${bj.length})`);
  fs.writeFileSync(path.join(v04Dir, "big_photo.jpg"), bj);
  fs.writeFileSync(path.join(v04Dir, "v04_docs.json"), JSON.stringify(V04_DOCS, null, 2) + "\n");
  for (const f of fs.readdirSync(v04Dir)) console.log(f, fs.statSync(path.join(v04Dir, f)).size);
}
