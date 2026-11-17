// v0.4 のテスト: read_file の下ごしらえ（EXIF 向き・縮小・縦長の分割・スキャンPDFの JPEG 取り出し）、
// 確認待ち（pending_*）・Muse との受け渡し（question_write / answers_read）・notify_setup_text・export_freee。
// 架空のレシートだけを使う（test/fixtures/v04 は node test/make_fixtures.mjs --v04 で作ったもの）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { orient, plan, resizeBox, imageInfo } from "../dist/image.js";
import { extractPdfJpegs } from "../dist/pdftext.js";
import { looksLikeCardNumber } from "../dist/pending.js";
import { isFullRatio } from "../dist/freee.js";
import { LEDGER_HEADER } from "../dist/core.js";
import { toLine, BOM } from "../dist/csv.js";
import { makeBigPhoto } from "./make_big_photo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const v04 = path.join(here, "fixtures", "v04");
const recDir = path.join(here, "fixtures", "receipts");
let tmp, root, inbox, client;
// 4MB 超の写真はリポジトリに入れない。fixtures/v04 に無ければフォントなしでその場で作る（test/make_big_photo.mjs）
let bigPhoto = path.join(v04, "big_photo.jpg");

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const json = (r) => {
  assert.ok(!r.isError, text(r));
  return JSON.parse(r.content[0].text);
};
const images = (r) => r.content.filter((c) => c.type === "image").map((c) => Buffer.from(c.data, "base64"));
/** 画像の一部の明るさの平均（0=黒〜255=白） */
function brightness(img, x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    s += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    n++;
  }
  return s / n;
}
const decode = (b) => jpeg.decode(b, { useTArray: true, formatAsRGBA: true });
const contactDir = () => path.join(root, "確認待ち");
const pendingCsv = () => fs.readFileSync(path.join(root, "整理済み", "確認待ち.csv"), "utf8");
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v04-"));
  root = path.join(tmp, "レシート台帳");
  inbox = path.join(root, "受信");
  fs.mkdirSync(inbox, { recursive: true });
  if (!fs.existsSync(bigPhoto)) {
    bigPhoto = path.join(tmp, "big_photo.jpg");
    fs.writeFileSync(bigPhoto, makeBigPhoto());
  }
  for (const f of ["exif6_receipt.jpg", "scan_tall.pdf"]) fs.copyFileSync(path.join(v04, f), path.join(inbox, f));
  fs.copyFileSync(bigPhoto, path.join(inbox, "big_photo.jpg"));
  for (const f of ["IMG_0001.jpg", "receipt_005.jpg", "scan_004.png"]) fs.copyFileSync(path.join(recDir, f), path.join(inbox, f));
  // 医療関係（架空。名前に医療機関名が入っている想定）
  fs.copyFileSync(path.join(recDir, "receipt_006.jpeg"), path.join(inbox, "架空クリニック_領収書.jpeg"));
  // 画像（JPEG）も文字もない PDF
  const c = "0 0 m 100 100 l S";
  fs.writeFileSync(path.join(inbox, "線だけ.pdf"),
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${c.length} >>\nstream\n${c}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
  client = new Client({ name: "keiri-v04", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

// ---------- 段階A: read_file の下ごしらえ ----------
test("架空の試験ファイル: EXIF 向き=6 の JPG、縦長 JPEG 1枚の PDF、4MB 超の JPG", () => {
  const a = imageInfo(fs.readFileSync(path.join(v04, "exif6_receipt.jpg")));
  assert.equal(a.orientation, 6);
  assert.equal(a.width, 1200);
  assert.equal(a.height, 900);
  assert.equal(a.takenAt, "2026-10-30 12:34:56");
  const pdf = fs.readFileSync(path.join(v04, "scan_tall.pdf"));
  const jpgs = extractPdfJpegs(pdf);
  assert.equal(jpgs.length, 1);
  const t = imageInfo(jpgs[0]);
  assert.deepEqual([t.width, t.height], [834, 3885]);
  assert.ok(!pdf.toString("latin1").includes("/Font"), "文字情報のないPDF");
  const big = fs.readFileSync(bigPhoto);
  assert.ok(big.length > 4 * 1024 * 1024);
  const b = imageInfo(big);
  assert.deepEqual([b.width, b.height, b.orientation], [4032, 3024, 6]);
});

test("read_file: EXIF 向き=6 の JPG は正しい向きに直して返す（撮影日時も添える）", async () => {
  const res = await call("read_file", { path: "受信/exif6_receipt.jpg" });
  assert.ok(!res.isError, text(res));
  const imgs = images(res);
  assert.equal(imgs.length, 1);
  const img = decode(imgs[0]);
  assert.deepEqual([img.width, img.height], [900, 1200]);
  // 左上に黒い四角（向きの目印）、右上・左下は白
  assert.ok(brightness(img, 12, 12, 48, 48) < 60, "左上が黒");
  assert.ok(brightness(img, img.width - 60, 10, img.width - 10, 50) > 200, "右上は白");
  assert.ok(brightness(img, 10, img.height - 50, 50, img.height - 10) > 200, "左下は白");
  assert.match(text(res), /向き（EXIF 6）を直しました/);
  assert.match(text(res), /撮影日時 2026-10-30 12:34:56/);
});

test("read_file: 4MB 超の JPG もエラーにせず、縮めて正しい向きで返す", async () => {
  const res = await call("read_file", { path: "受信/big_photo.jpg" });
  assert.ok(!res.isError, text(res));
  const imgs = images(res);
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].length < 1024 * 1024, `返す画像は1MB未満 (${imgs[0].length})`);
  const img = decode(imgs[0]);
  assert.ok(Math.max(img.width, img.height) <= 1568);
  assert.ok(img.height > img.width, "縦向き（3024×4032 の縮小）");
  assert.equal(img.height, 1568);
  assert.ok(brightness(img, 22, 22, 72, 72) < 60, "左上が黒");
  assert.match(text(res), /縮めました/);
});

test("read_file: 文字のないスキャンPDFは中の JPEG を取り出し、縦長なので重ねて3枚に分けて返す", async () => {
  const res = await call("read_file", { path: "受信/scan_tall.pdf" });
  assert.ok(!res.isError, text(res));
  assert.ok(!res.content.some((c) => c.type === "resource"), "PDF そのものは返さない");
  const imgs = images(res).map(decode);
  assert.equal(imgs.length, 3);
  for (const im of imgs) {
    assert.equal(im.width, 834);
    assert.ok(im.height <= 1568);
  }
  // 重なりあり: 合計の高さが元より大きい
  assert.ok(imgs.reduce((s, im) => s + im.height, 0) > 3885);
  assert.ok(brightness(imgs[0], 12, 12, 48, 48) < 60, "1枚目の左上に目印");
  const t = text(res);
  assert.match(t, /1\/3 枚目/);
  assert.match(t, /3\/3 枚目/);
  assert.match(t, /重ねて|重なった|重ねてある/);
  assert.match(t, /ドキュメントをスキャン/);
});

test("read_file: 画像も文字もないPDFは従来どおり PDF を返し、撮り直しを勧める", async () => {
  const res = await call("read_file", { path: "受信/線だけ.pdf" });
  assert.ok(!res.isError, text(res));
  assert.ok(res.content.some((c) => c.type === "resource"));
  assert.match(text(res), /ドキュメントをスキャン/);
});

test("read_file: 小さく向きの正しい画像は元のまま返す（画質を落とさない）", async () => {
  const res = await call("read_file", { path: "受信/receipt_005.jpg" });
  assert.deepEqual(images(res)[0], fs.readFileSync(path.join(recDir, "receipt_005.jpg")));
});

test("画像処理の部品: 向き1〜8・面積平均の縮小・分割の計画", () => {
  // 2×3 の画像（画素ごとに違う値）で、向きごとの大きさと左上の画素を確かめる
  const W = 2, H = 3;
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) d[i * 4] = i * 10;
  const src = { w: W, h: H, d };
  const tl = (o) => { const r = orient(src, o); return [r.w, r.h, r.d[0]]; };
  // 元: (0,0)=0 (1,0)=10 / (0,1)=20 (1,1)=30 / (0,2)=40 (1,2)=50
  assert.deepEqual(tl(1), [2, 3, 0]);
  assert.deepEqual(tl(2), [2, 3, 10]);
  assert.deepEqual(tl(3), [2, 3, 50]);
  assert.deepEqual(tl(4), [2, 3, 40]);
  assert.deepEqual(tl(5), [3, 2, 0]);
  assert.deepEqual(tl(6), [3, 2, 40]);
  assert.deepEqual(tl(7), [3, 2, 50]);
  assert.deepEqual(tl(8), [3, 2, 10]);
  const half = resizeBox({ w: 2, h: 2, d: new Uint8Array([0, 0, 0, 255, 200, 200, 200, 255, 100, 100, 100, 255, 100, 100, 100, 255]) }, 1, 1);
  assert.equal(half.d[0], 100);
  assert.deepEqual(plan(834, 3885), { scale: 1, pieces: 3, tall: true });
  assert.equal(plan(3024, 4032).pieces, 1);
  assert.ok(Math.abs(plan(3024, 4032).scale * 4032 - 1568) < 1);
  const veryLong = plan(800, 30000);
  assert.equal(veryLong.pieces, 8);
});

// ---------- 段階B: 確認待ち・Muse・freee ----------
test("カード番号らしきものの判定", () => {
  for (const s of ["カード 1234 5678 9012 3456", "****1234", "＊＊＊＊ 5678", "カード下4桁 1234"]) assert.ok(looksLikeCardNumber(s), s);
  for (const s of ["登録番号 T0000000000001", "合計 4,460円", "2026-10-12", "ボールペン ×3"]) assert.ok(!looksLikeCardNumber(s), s);
});

test("pending_add: 確認待ち・撮り直し・医療関係を記録し、カード番号・二重記録・不正な値ははじく", async () => {
  const r = json(await call("pending_add", {
    items: [
      { path: "受信/IMG_0001.jpg", reason: "読み取り", question: "合計金額は1,320円で合っていますか。", vendor: "テスト文具店", date: "2026-10-10", candidate: "1,320円（明細の合計）", read_range: "合計がかすれている" },
      { path: "受信/big_photo.jpg", reason: "撮り直し", read_range: "日付と合計は読めた。品目はぼけて読めない", date: "2026-11-01", amount: 2200 },
      { path: "受信/架空クリニック_領収書.jpeg", reason: "医療関係", vendor: "架空クリニック", date: "2026-10-25", amount: 5500, question: "診察代ですか" },
      { path: "受信/scan_004.png", reason: "私用の可能性", question: "カード下4桁 1234 の支払いですか" },
      { path: "受信/無い.jpg", reason: "読み取り", question: "?" },
      { path: "受信/receipt_005.jpg", reason: "科目" },
    ],
  }));
  assert.deepEqual(r.added.map((a) => a.receipt_id), ["R0001", "R0002", "R0003"]);
  assert.deepEqual(r.errors.map((e) => e.index), [3, 4, 5]);
  assert.match(JSON.stringify(r.errors[2]), /question/);
  const badReason = await call("pending_add", { items: [{ path: "受信/receipt_005.jpg", reason: "なんとなく", question: "?" }] });
  assert.equal(badReason.isError, true);
  assert.match(JSON.stringify(r.errors[0]), /カード番号/);
  // 医療関係: 画像は 整理済み/医療関係/R0003.jpeg へ移り、元の名前・医療機関名はどこにも書かない
  assert.equal(r.added[2].moved_to, "整理済み/医療関係/R0003.jpeg");
  assert.ok(fs.existsSync(path.join(root, "整理済み", "医療関係", "R0003.jpeg")));
  assert.ok(!fs.existsSync(path.join(inbox, "架空クリニック_領収書.jpeg")));
  const csv = pendingCsv();
  assert.ok(!csv.includes("架空クリニック"));
  assert.ok(!csv.includes("診察代"));
  assert.match(csv, /R0003,R0003\.jpeg,2026-10-25,医療関係,5500,医療関係/);
  // 撮り直し: 撮影日時（EXIF）と「ドキュメントをスキャン」の案内
  assert.match(csv, /2026-11-01 10:05:00/);
  assert.match(csv, /big_photo\.jpg（撮影日時 2026-11-01 10:05:00、読めた範囲: 日付と合計は読めた。品目はぼけて読めない）/);
  assert.match(csv, /ドキュメントをスキャン/);
  // 同じファイルは二重に記録しない
  const again = json(await call("pending_add", { items: [{ path: "受信/IMG_0001.jpg", reason: "読み取り", question: "もう一度" }] }));
  assert.equal(again.added.length, 0);
  assert.match(again.warnings[0].warning, /既に確認待ち/);
  // scan_folder の対象から医療関係の画像は外れる（整理済みの中）
  const scan = json(await call("scan_folder", {}));
  assert.ok(!scan.files.some((f) => /R0003|クリニック/.test(f.path)));
});

test("question_write: Muse 用の質問ファイルを書き、同じ質問は作り直さない", async () => {
  const w = json(await call("question_write", {}));
  assert.deepEqual(w.written.map((x) => x.question_id), ["R0001", "R0002", "R0003"]);
  assert.equal(w.folder, "確認待ち");
  const q1 = fs.readFileSync(path.join(contactDir(), "question_R0001.txt"), "utf8");
  assert.match(q1, /^質問ID: R0001\r\n画像: 受信\/IMG_0001\.jpg\r\n支払先: テスト文具店\r\n日付: 2026-10-10\r\n/);
  assert.match(q1, /AIの候補: 1,320円（明細の合計）/);
  assert.match(q1, /質問:\r\n1\. 合計金額は1,320円で合っていますか。\r\n状態: 回答待ち\r\n$/);
  const q2 = fs.readFileSync(path.join(contactDir(), "question_R0002.txt"), "utf8");
  assert.match(q2, /確認の理由: 撮り直し/);
  assert.match(q2, /撮影日時: 2026-11-01 10:05:00/);
  assert.match(q2, /ドキュメントをスキャン/);
  const q3 = fs.readFileSync(path.join(contactDir(), "question_R0003.txt"), "utf8");
  assert.match(q3, /画像: R0003\.jpeg\r\n画像の表示: しない\r\n支払先: 医療関係/);
  assert.match(q3, /医療関係の領収書が1件あります（R0003）。台帳に入れず、対象から外してよいですか/);
  assert.ok(!q3.includes("クリニック"));
  const w2 = json(await call("question_write", {}));
  assert.equal(w2.written.length, 0);
  const w3 = json(await call("question_write", { receipt_ids: ["R0001", "R9999"] }));
  assert.match(JSON.stringify(w3.skipped), /作成済み/);
  assert.match(JSON.stringify(w3.skipped), /見つかりません/);
});

test("answers_read → pending_resolve: 反映・聞き直し（_2 まで）・医療「いいえ」・二重反映の防止", async () => {
  const ans = (qid, body) => fs.writeFileSync(path.join(contactDir(), `answer_${qid}.txt`), `質問ID: ${qid}\n回答: ${body}\n回答日時: 2026-11-08 20:05\n状態: 回答済み\n`);
  ans("R0001", "よく分からない");
  ans("R0003", "いいえ");
  let a = json(await call("answers_read"));
  assert.equal(a.count, 2);
  assert.equal(a.answers[0].answer, "よく分からない");
  assert.match(a.answers[0].action, /反映してください/);
  // 聞き直し → question_R0001_2.txt
  let r = json(await call("pending_resolve", { receipt_id: "R0001", status: "聞き直し", answer: "よく分からない", new_question: "合計金額は1,320円ですか、別の金額ですか。" }));
  assert.equal(r.question_id, "R0001_2");
  assert.match(fs.readFileSync(path.join(contactDir(), "question_R0001.txt"), "utf8"), /状態: 聞き直し/);
  assert.match(fs.readFileSync(path.join(contactDir(), "question_R0001_2.txt"), "utf8"), /^質問ID: R0001_2[\s\S]*状態: 回答待ち/);
  a = json(await call("answers_read"));
  assert.match(a.answers.find((x) => x.question_id === "R0001").action, /古い質問への回答/);
  // _2 でも分からない → _3 は作らずチャットで確認
  r = json(await call("pending_resolve", { receipt_id: "R0001", status: "聞き直し", answer: "うーん" }));
  assert.equal(r.state, "チャットで確認");
  assert.ok(!fs.existsSync(path.join(contactDir(), "question_R0001_3.txt")));
  assert.match(fs.readFileSync(path.join(contactDir(), "question_R0001_2.txt"), "utf8"), /状態: チャットで確認/);
  // チャットで聞いて確定
  r = json(await call("pending_resolve", { receipt_id: "R0001", status: "確定", answer: "1,320円で合っています（チャット）" }));
  assert.equal(r.state, "確定");
  assert.match(r.notes.join(), /propose_names/);
  assert.match(fs.readFileSync(path.join(contactDir(), "question_R0001_2.txt"), "utf8"), /状態: 反映済み/);
  const dup = await call("pending_resolve", { receipt_id: "R0001", status: "確定", answer: "もう一度" });
  assert.equal(dup.isError, true);
  assert.match(text(dup), /二重に反映しません/);
  // 医療関係「いいえ」→ チャットで確認（Muse の対象外）
  r = json(await call("pending_resolve", { receipt_id: "R0003", status: "チャットで確認", answer: "いいえ" }));
  assert.equal(r.state, "チャットで確認");
  assert.match(fs.readFileSync(path.join(contactDir(), "question_R0003.txt"), "utf8"), /状態: チャットで確認/);
  a = json(await call("answers_read"));
  assert.match(a.answers.find((x) => x.question_id === "R0003").action, /チャットで本人に聞いて/);
  // 撮り直しが届いた → 古い写真は重複（残す方を記録）
  fs.copyFileSync(path.join(v04, "scan_tall.pdf"), path.join(inbox, "big_photo_スキャン.pdf"));
  r = json(await call("pending_resolve", { receipt_id: "R0002", status: "重複", answer: "スキャンし直しました", replaced_by: "受信/big_photo_スキャン.pdf" }));
  assert.equal(r.state, "重複");
  assert.match(pendingCsv(), /受信\/big_photo_スキャン\.pdf/);
  const bad = await call("pending_resolve", { receipt_id: "R0002", status: "なし", answer: "x" });
  assert.equal(bad.isError, true);
  const list = json(await call("pending_list", {}));
  assert.deepEqual(list.items.map((x) => [x.receipt_id, x.state]), [["R0003", "チャットで確認"]]);
  const all = json(await call("pending_list", { include_resolved: true }));
  assert.equal(all.count, 3);
});

test("pending_list（通知用）: 古い順に5件まで・7日以上の注意・14日以上は月曜だけ・0件なら通知しない", async () => {
  // 8件を追加して質問ファイルを書く（今日の日付で作成）
  const files = ["exif6_receipt.jpg", "scan_tall.pdf", "receipt_005.jpg", "scan_004.png", "線だけ.pdf", "IMG_0001.jpg"];
  const items = files.map((f, i) => ({ path: `受信/${f}`, reason: "私用の可能性", question: `事業用ですか（${i + 1}）`, vendor: `見本店${i + 1}`, date: "2026-10-0" + (i + 1) }));
  items[5].question = "同じレシートですか";
  const add = json(await call("pending_add", { items }));
  assert.equal(add.added.length, 6);
  json(await call("question_write", {}));
  const today = localToday();
  let n = json(await call("pending_list", { for_notification: true, today }));
  assert.equal(n.count, 6);
  assert.equal(n.shown, 5);
  assert.equal(n.remaining, 1);
  assert.equal(n.over_7_days, 0);
  assert.match(n.message, /^今日の確認は6件です。/);
  assert.match(n.message, /ほかに1件あります/);
  assert.match(n.message, /1\. 見本店1（10\/1）: 事業用ですか（1）/);
  assert.ok(!n.items.some((x) => x.receipt_id === "R0003"), "チャットで確認は通知しない");
  n = json(await call("pending_list", { for_notification: true, today: addDays(today, 8) }));
  assert.equal(n.over_7_days, 6);
  assert.match(n.message, /^7日以上たっているものが6件あります。/);
  // 14日以上: 月曜だけ
  let d = addDays(today, 15);
  while (new Date(d + "T00:00:00Z").getUTCDay() === 1) d = addDays(d, 1);
  n = json(await call("pending_list", { for_notification: true, today: d }));
  assert.equal(n.count, 0);
  assert.equal(n.weekly_held, 6);
  assert.equal(n.message, undefined);
  assert.match(n.note, /何も送らない/);
  let mon = addDays(today, 15);
  while (new Date(mon + "T00:00:00Z").getUTCDay() !== 1) mon = addDays(mon, 1);
  n = json(await call("pending_list", { for_notification: true, today: mon }));
  assert.equal(n.count, 6);
});

test("notify_setup_text: Muse（おすすめ）の貼り付け文と、Gmail 連携の案内", async () => {
  const m = json(await call("notify_setup_text", { notify_time: "20:00" }));
  assert.equal(m.method, "muse");
  assert.match(m.setup_text, /毎日 20:00 に、Googleドライブのフォルダ「レシート台帳\/確認待ち」を確認してください/);
  assert.match(m.setup_text, /answer_\(質問ID\)\.txt/);
  assert.match(m.setup_text, /画像の表示: しない/);
  assert.match(m.setup_text, /ドキュメントをスキャン/);
  const m2 = json(await call("notify_setup_text", { method: "muse", drive_folder: "経理/レシート" }));
  assert.match(m2.setup_text, /「経理\/レシート\/確認待ち」/);
  assert.match(m2.setup_text, /（通知の時刻）/);
  const g = json(await call("notify_setup_text", { method: "gmail", notify_time: "21:00" }));
  assert.match(g.setup_text, /このツール自体はメールを送りません/);
  assert.match(g.setup_text, /パスワードは入力しません/);
  const bad = await call("notify_setup_text", { method: "line" });
  assert.equal(bad.isError, true);
});

test("export_freee: 税区分名が必須・判断が要る行は要確認へ・出力済みは次回出さない", async () => {
  const noLabel = await call("export_freee", { tax_label: "" });
  assert.equal(noLabel.isError, true);
  assert.match(text(noLabel), /税区分の名称が指定されていないため、止めました/);
  // 台帳（架空）を直接用意する
  const L = (o) => LEDGER_HEADER.map((h) => o[h] ?? "");
  const rows = [
    L({ 日付: "2026-10-01", 支払先: "架空商事テスト株式会社", 科目: "外注工賃", 内容: "業務委託費", 金額: "55000", インボイス有無: "あり", 登録番号: "T0000000000001", 証憑ファイル名: "a.pdf", "事業割合(%)": "", 書類種別: "請求書" }),
    L({ 日付: "2026-10-05", 支払先: "ダミーデザイン工房", 科目: "広告宣伝費", 内容: "ロゴ制作", 金額: "33000", インボイス有無: "あり", 証憑ファイル名: "b.pdf", "事業割合(%)": "100%", 書類種別: "請求書" }),
    L({ 日付: "2026-10-12", 支払先: "架空カフェ", 科目: "会議費", 内容: "8%対象980円", 金額: "980", インボイス有無: "あり", 証憑ファイル名: "c.png", 書類種別: "領収書" }),
    L({ 日付: "2026-10-15", 支払先: "見本交通", 科目: "旅費交通費", 内容: "乗車", 金額: "2400", インボイス有無: "なし", 証憑ファイル名: "d.png", 書類種別: "領収書" }),
    L({ 日付: "2026-10-20", 支払先: "Fictional Books", 科目: "新聞図書費", 内容: "技術書", 金額: "3300", インボイス有無: "あり", 証憑ファイル名: "e.jpg", "事業割合(%)": "50%", 書類種別: "領収書" }),
    L({ 日付: "2026-10-25", 支払先: "架空通信", 科目: "", 内容: "通信料", 金額: "5500", インボイス有無: "あり", 証憑ファイル名: "f.jpg", 書類種別: "領収書" }),
    L({ 日付: "2026-10-26", 支払先: "架空商事", 科目: "雑費", 内容: "見積", 金額: "110000", インボイス有無: "あり", 証憑ファイル名: "g.pdf", 書類種別: "見積書" }),
    L({ 日付: "2026-10-27", 支払先: "架空ソフト", 科目: "ソフトウェア", 内容: "利用料", 金額: "1100", インボイス有無: "有", 証憑ファイル名: "h.pdf", "事業割合(%)": "1", 書類種別: "請求書" }),
  ];
  const ledger = path.join(root, "整理済み", "ledger.csv");
  fs.writeFileSync(ledger, BOM + toLine(LEDGER_HEADER) + rows.map(toLine).join(""));
  const r = json(await call("export_freee", { tax_label: "課対仕入10%", accounts: ["外注工賃", "広告宣伝費", "会議費", "旅費交通費", "新聞図書費", "雑費"] }));
  assert.equal(r.exported, 2);
  assert.match(r.file, /^整理済み\/freee出力\/freee_import_\d{8}_\d{6}\.csv$/);
  const out = fs.readFileSync(path.join(root, r.file), "utf8");
  assert.ok(out.startsWith("﻿収支区分,管理番号,発生日,取引先,勘定科目,税区分,金額,備考\r\n"));
  assert.match(out, /\r\n支出,a\.pdf,2026\/10\/01,架空商事テスト株式会社,外注工賃,課対仕入10%,55000,業務委託費\r\n/);
  assert.match(out, /\r\n支出,b\.pdf,2026\/10\/05,ダミーデザイン工房,広告宣伝費,課対仕入10%,33000,ロゴ制作\r\n/);
  const reasons = Object.fromEntries(r.review.map((x) => [x.file, x.reason]));
  assert.match(reasons["c.png"], /8%/);
  assert.match(reasons["d.png"], /インボイスが「あり」以外/);
  assert.match(reasons["e.jpg"], /事業割合が100%以外/);
  assert.match(reasons["f.jpg"], /科目が空/);
  assert.match(reasons["h.pdf"], /インボイスが「あり」以外/); // 旧表記「有」も要確認へ（推測しない）
  assert.match(reasons["h.pdf"], /科目リスト/);
  assert.ok(!("g.pdf" in reasons), "見積書は出さない");
  assert.ok(fs.readFileSync(path.join(root, "整理済み", "freee出力", "freee_要確認.csv"), "utf8").includes("c.png"));
  assert.match(fs.readFileSync(path.join(root, "整理済み", "freee出力済み.csv"), "utf8"), /a\.pdf,\d{4}-\d{2}-\d{2},freee_import_/);
  // 2回目: 出力済みは出さない
  const r2 = json(await call("export_freee", { tax_label: "課対仕入10%" }));
  assert.equal(r2.exported, 0);
  assert.equal(r2.already_exported, 2);
  assert.match(r2.note, /取込用CSVは書いていません/); // v0.4.1: 要確認CSVは毎回書き直す（意図した変更）
  assert.ok(isFullRatio("") && isFullRatio("100%") && isFullRatio("1") && !isFullRatio("0.5") && !isFullRatio("50%"));
});
