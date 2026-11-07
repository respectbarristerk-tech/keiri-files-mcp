// テスト用の架空の証憑ファイル10件を作る（v0.2: 日付・取引先・金額・書類種別・登録番号が実際に読める）。
// 社名・宛名はすべて架空。登録番号は先頭0の架空番号。実在の社名・個人情報なし。
// 画像は pureimage、PDF は pdfkit（どちらも devDependencies。.mcpb には入らない）。
// 使い方: node test/make_fixtures.mjs [日本語TTFのパス] [欧文TTFのパス]
//   日本語フォントは 引数1 → 環境変数 KEIRI_FIXTURE_FONT → 候補、欧文（数字・記号用）は 引数2 → KEIRI_FIXTURE_FONT_LATIN → 候補
//   （TTF/OTF。TTCは不可）。日本語フォントに無い文字は欧文フォントで描く
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as PImage from "pureimage";
import PDFDocument from "pdfkit";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures", "receipts");
fs.mkdirSync(dir, { recursive: true });

const candidates = [
  process.argv[2],
  process.env.KEIRI_FIXTURE_FONT,
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
  "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
].filter(Boolean);
const FONT = candidates.find((p) => fs.existsSync(p));
if (!FONT) throw new Error("日本語の TTF フォントが見つかりません。引数か KEIRI_FIXTURE_FONT で指定してください。");
const LATIN = [process.argv[3], process.env.KEIRI_FIXTURE_FONT_LATIN, "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/arial.ttf", "/Library/Fonts/Arial.ttf"]
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const d of docs) {
    const file = path.join(dir, d.file);
    if (d.file.endsWith(".pdf")) await pdf(d, file);
    else await image(d, file);
  }
  fs.writeFileSync(path.join(here, "fixtures", "doc_texts.json"), JSON.stringify(Object.fromEntries(docs.map((d) => [d.file, docText(d)])), null, 2) + "\n");
  console.log(`created ${docs.length} files in ${path.relative(process.cwd(), dir)} (fonts: ${path.basename(FONT)} + ${path.basename(LATIN)})`);
}
