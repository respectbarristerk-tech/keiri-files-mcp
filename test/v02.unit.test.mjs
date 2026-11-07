// v0.2 の単体テスト: Windows予約名の回避、PDFテキスト抽出、作り直した架空証憑の中身（npm run build の後に npm test）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { avoidReserved } from "../dist/validate.js";
import { buildName } from "../dist/core.js";
import { extractPdfText } from "../dist/pdftext.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recDir = path.join(here, "fixtures", "receipts");
const readings = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "readings.json"), "utf8"));
const docTexts = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "doc_texts.json"), "utf8"));
const yen = (n) => "¥" + Number(String(n).replace(/,/g, "")).toLocaleString("ja-JP");
const squash = (s) => s.replace(/\s+/g, "");

test("Windows の予約名は先頭に _ を付ける", () => {
  for (const v of ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9", "CON.txt", "nul.pdf"]) {
    assert.equal(avoidReserved(v), "_" + v, v);
  }
  for (const v of ["CONSOLE", "COM0", "COM10", "LPT", "架空商事", "_CON", "ACON"]) assert.equal(avoidReserved(v), v, v);
  assert.equal(buildName("2026-10-01", "CON", 100, "領収書", ".pdf"), "20261001__CON_100_領収書.pdf");
  assert.equal(buildName("2026-10-01", "ｃｏｍ１", 100, "領収書", ".pdf"), "20261001__com1_100_領収書.pdf"); // 全角も NFKC 後に判定
  assert.equal(buildName("2026-10-01", "nul.txt", 100, "領収書", ".pdf"), "20261001__nul.txt_100_領収書.pdf");
  assert.equal(buildName("2026-10-01", "CONSOLE", 100, "領収書", ".pdf"), "20261001_CONSOLE_100_領収書.pdf");
});

test("架空証憑10件: readings.json と書類の印字内容が一致", () => {
  assert.equal(readings.length, 10);
  assert.deepEqual(fs.readdirSync(recDir).sort(), readings.map((r) => r.path).sort());
  for (const r of readings) {
    const lines = docTexts[r.path];
    assert.ok(lines, r.path);
    const all = lines.join("\n");
    assert.ok(all.includes(r.vendor), `${r.path}: 取引先`);
    assert.ok(all.includes(r.date), `${r.path}: 日付`);
    assert.ok(lines.some((l) => l.startsWith("合計") && l.includes(yen(r.amount))), `${r.path}: 合計`);
    if (r.invoice_no) assert.ok(all.includes(r.invoice_no), `${r.path}: 登録番号`);
    else assert.ok(!all.includes("登録番号"), `${r.path}: 登録番号なし`);
    const title = squash(lines[0]);
    const expect = { 請求書: "請求書", 見積書: "御見積書", 納品書: "納品書", 領収書: "領収書", その他: "ご利用明細" }[r.doc_type];
    assert.equal(title, expect, `${r.path}: 書類種別`);
    assert.ok(all.includes("架空"), `${r.path}: 架空の表示`);
  }
});

test("架空証憑のPDF: 埋め込みテキストに日付・取引先・金額・登録番号が入っている", () => {
  const pdfs = readings.filter((r) => r.path.endsWith(".pdf"));
  assert.equal(pdfs.length, 4);
  for (const r of pdfs) {
    const text = extractPdfText(fs.readFileSync(path.join(recDir, r.path)));
    for (const l of docTexts[r.path]) assert.ok(squash(text).includes(squash(l)), `${r.path}: 「${l}」が無い\n${text}`);
    assert.ok(text.includes(r.vendor) && text.includes(r.date) && text.includes(yen(r.amount)));
    if (r.invoice_no) assert.ok(text.includes(r.invoice_no));
    // 1行ごとに取り出せている（書体の切り替えで行が割れない）
    assert.ok(text.split("\n").some((l) => l.startsWith("合計") && l.includes(yen(r.amount))), text);
  }
});

test("架空証憑の画像: 正しい JPG/PNG で、文字が描かれている", () => {
  const imgs = readings.filter((r) => !r.path.endsWith(".pdf"));
  assert.equal(imgs.length, 6);
  for (const r of imgs) {
    const buf = fs.readFileSync(path.join(recDir, r.path));
    let w, h, data;
    if (/\.png$/i.test(r.path)) {
      assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      ({ width: w, height: h, data } = PNG.sync.read(buf));
    } else {
      assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
      ({ width: w, height: h, data } = jpeg.decode(buf, { useTArray: true }));
    }
    assert.ok(w >= 400 && h >= 400, `${r.path}: ${w}x${h}`);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
    const ratio = dark / (w * h);
    assert.ok(ratio > 0.01 && ratio < 0.3, `${r.path}: 黒い画素の割合 ${ratio}`);
  }
});

// ---- 抽出器の単体（手で組んだPDF） ----
function minimalPdf(content, { compress = false, extra = "" } = {}) {
  const body = compress ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
  ];
  const head = Buffer.from(parts.join("") + `4 0 obj\n<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1");
  const tail = Buffer.from(`\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n${extra}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
  return Buffer.concat([head, body, tail]);
}

test("PDF抽出: 無圧縮・Flate・TJ・エスケープ・テキストなし・暗号化", () => {
  const c = "BT /F1 12 Tf 40 780 Td (SAMPLE \\(FICTIONAL\\)) Tj 0 -18 Td [(Total) -300 (JPY) -300 (1,234)] TJ ET";
  assert.equal(extractPdfText(minimalPdf(c)), "SAMPLE (FICTIONAL)\nTotal JPY 1,234");
  assert.equal(extractPdfText(minimalPdf(c, { compress: true })), "SAMPLE (FICTIONAL)\nTotal JPY 1,234");
  assert.equal(extractPdfText(minimalPdf("0 0 m 100 100 l S")), "");
  const enc = Buffer.from(minimalPdf(c).toString("latin1").replace("<< /Root 1 0 R >>", "<< /Root 1 0 R /Encrypt 6 0 R >>"), "latin1");
  assert.equal(extractPdfText(enc), "");
  assert.equal(extractPdfText(Buffer.from("not a pdf")), "");
});
