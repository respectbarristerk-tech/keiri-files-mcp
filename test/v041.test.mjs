// v0.4.1 のテスト: カード番号の表記ゆれ、ledger_append でのカード番号拒否、
// export_freee の日付範囲の検証・数式記号で始まる取引先・要確認CSVの書き直し、pending_list の today 検証。
// 架空のデータだけを使う（カード番号はテスト用の見本番号）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { looksLikeCardNumber } from "../dist/validate.js";
import { looksLikeCardNumber as fromPending } from "../dist/pending.js";
import { LEDGER_HEADER } from "../dist/core.js";
import { toLine, BOM } from "../dist/csv.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
let tmp, root, client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const json = (r) => { assert.ok(!r.isError, text(r)); return JSON.parse(r.content[0].text); };
// 見本番号は分割して書く（leak_check 対策）
const V = ["4111", "1111", "1111", "1111"];
// 架空の電話番号も分割して書く（leak_check 対策）
const P = (...a) => a.join("-");

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v041-"));
  root = path.join(tmp, "レシート台帳");
  fs.mkdirSync(path.join(root, "受信"), { recursive: true });
  fs.copyFileSync(path.join(here, "fixtures", "receipts", "IMG_0001.jpg"), path.join(root, "受信", "IMG_0001.jpg"));
  client = new Client({ name: "keiri-v041", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});
after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("カード番号: ドット・スラッシュ区切りと下4桁の表記ゆれも検出する", () => {
  assert.equal(fromPending, looksLikeCardNumber);
  const hits = [
    V.join("."), V.join("/"), V.join(" "), V.join("-"), V.join(""), "４１１１．１１１１．１１１１．１１１１",
    "3056 9309 0259 04", "カード下四桁1234", "下4桁 1234", "下４桁１２３４", "末尾1234", "末尾 4桁", "カード番号の最後は1234",
    "card ending 1234", "Card ending in 1234", "card no. 1234", "last 4 digits: 1234", "****1234", "xxxx-1234", "●●●● 1234",
  ];
  for (const s of hits) assert.ok(looksLikeCardNumber(s), s);
});

test("カード番号: 金額・日付・電話番号・登録番号・撮影日時は誤検出しない", () => {
  const ok = [
    "合計 4,460円", "1,234,567円", "¥12,000", "2026-10-12", "2026/10/12", "2026.10.12", "2026年10月12日 14:30",
    P("03", "1234", "5678"), P("090", "1234", "5678"), P("0120", "123", "456"), P("0120", "1234", "5678"), "(03)1234-5678", "TEL 045.123.4567",
    "登録番号 T0000000000001", "T1234567890123", "IMG_20261108_123456.jpg", "PXL_20261108_123456789.jpg", "20261108123456.jpg",
    "2026-11-08_架空文具店_1320.pdf", "ボールペン ×3", "最後の1000円", "末尾2026年", "以下1000円", "クレジットカード", "カード払い 3300円",
    "fiscal year ending 2026", "レシート No.1234", "伝票番号 12345678",
  ];
  for (const s of ok) assert.ok(!looksLikeCardNumber(s), s);
});

test("pending_add / pending_resolve: 新しい表記ゆれも拒否する", async () => {
  const r = json(await call("pending_add", { items: [
    { path: "受信/IMG_0001.jpg", reason: "私用の可能性", question: `カード ${V.join(".")} の支払いですか` },
    { path: "受信/IMG_0001.jpg", reason: "私用の可能性", question: "card ending 1234 の支払いですか" },
    { path: "受信/IMG_0001.jpg", reason: "私用の可能性", question: "末尾1234のカードの支払いですか" },
  ] }));
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.errors.map((e) => e.index), [0, 1, 2]);
  for (const e of r.errors) assert.match(JSON.stringify(e), /カード番号/);
  const ok = json(await call("pending_add", { items: [{ path: "受信/IMG_0001.jpg", reason: "私用の可能性", question: `2026/10/10 の 1,320円（TEL ${P("03", "1234", "5678")} の店）は私用ですか` }] }));
  assert.equal(ok.added.length, 1);
  const id = ok.added[0].receipt_id;
  const bad = await call("pending_resolve", { receipt_id: id, status: "確定", answer: `仕事用。カードは ${V.join("/")}` });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /カード番号/);
  const bad2 = await call("pending_resolve", { receipt_id: id, status: "確定", answer: "仕事用。下四桁1234のカード" });
  assert.equal(bad2.isError, true);
});

test("ledger_append: 全テキスト列でカード番号を拒否し、通常の値は通す", async () => {
  const base = { date: "2026-10-10", vendor: "架空文具店", amount: 1320, doc_type: "領収書", file_name: "2026-10-10_架空文具店_1320.jpg" };
  const cases = [
    { ...base, description: `カード ${V.join(" ")}` },
    { ...base, payment_method: "VISA ****1234" },
    { ...base, vendor: "架空文具店 card ending 1234" },
    { ...base, account: "下4桁1234" },
    { ...base, source_file: `${V.join(".")}.jpg` },
    { ...base, file_name: `${V.join("-")}.jpg` },
  ];
  const r = json(await call("ledger_append", { entries: cases }));
  assert.equal(r.errors.length, cases.length, JSON.stringify(r));
  for (const e of r.errors) assert.match(JSON.stringify(e), /カード番号/);
  const ledger = path.join(root, "整理済み", "ledger.csv");
  assert.ok(!fs.existsSync(ledger) || !fs.readFileSync(ledger, "utf8").includes("1111"));
  // 通常の値（電話番号・登録番号・撮影日時の元ファイル名）はカード番号として拒否しない（証憑が無いので警告で止まる）
  const ok = json(await call("ledger_append", { entries: [{ ...base, description: `TEL ${P("03", "1234", "5678")} 文具 2026.10.10`, payment_method: "クレジットカード", invoice_no: "T0000000000001", source_file: "IMG_20261010_123456.jpg" }] }));
  assert.equal(ok.errors.length, 0, JSON.stringify(ok));
  assert.match(JSON.stringify(ok.warnings), /見つからない/);
});

test("pending_list: today が不正ならエラーにする（PCの日付に黙って戻さない）", async () => {
  const bad = await call("pending_list", { today: "garbage" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /today/);
  json(await call("pending_list", { today: "2026-11-09" }));
  json(await call("pending_list", {}));
});

test("export_freee: date_from/date_to の不正値はエラー、= で始まる取引先は要確認へ、要確認CSVは毎回書き直す", async () => {
  const L = (o) => LEDGER_HEADER.map((h) => o[h] ?? "");
  const rows = [
    L({ 日付: "2026-10-01", 支払先: "架空商事", 科目: "雑費", 内容: "文具", 金額: "1100", インボイス有無: "あり", 証憑ファイル名: "a.pdf", 書類種別: "領収書" }),
    L({ 日付: "2026-10-02", 支払先: "=SUM(A1)テスト", 科目: "雑費", 内容: "文具", 金額: "2200", インボイス有無: "あり", 証憑ファイル名: "b.pdf", 書類種別: "領収書" }),
    L({ 日付: "2026-10-03", 支払先: "見本交通", 科目: "旅費交通費", 内容: "乗車", 金額: "2400", インボイス有無: "なし", 証憑ファイル名: "c.pdf", 書類種別: "領収書" }),
  ];
  fs.mkdirSync(path.join(root, "整理済み"), { recursive: true });
  fs.writeFileSync(path.join(root, "整理済み", "ledger.csv"), BOM + toLine(LEDGER_HEADER) + rows.map(toLine).join(""));
  for (const args of [{ date_from: "bad" }, { date_to: "2026-13-01" }, { date_from: "2026-10-05", date_to: "2026-10-01" }]) {
    const r = await call("export_freee", { tax_label: "課対仕入10%", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(text(r), /date_|日付/);
  }
  assert.ok(!fs.existsSync(path.join(root, "整理済み", "freee出力")), "エラー時は何も書かない");
  // 範囲外だけ → 出力0件でも要確認CSVは書く
  const none = json(await call("export_freee", { tax_label: "課対仕入10%", date_from: "2026-10-03", date_to: "2026-10-03" }));
  assert.equal(none.exported, 0);
  const reviewPath = path.join(root, "整理済み", "freee出力", "freee_要確認.csv");
  assert.equal(none.review_file, "整理済み/freee出力/freee_要確認.csv");
  assert.ok(fs.readFileSync(reviewPath, "utf8").includes("c.pdf"));
  const r = json(await call("export_freee", { tax_label: "課対仕入10%" }));
  assert.equal(r.exported, 1);
  const out = fs.readFileSync(path.join(root, r.file), "utf8");
  assert.ok(!out.includes("'"), "freee 用CSVに ' を残さない");
  assert.ok(!out.includes("SUM"));
  const reasons = Object.fromEntries(r.review.map((x) => [x.file, x.reason]));
  assert.match(reasons["b.pdf"], /取引先が = \+ - @ で始まる/);
  const rv = fs.readFileSync(reviewPath, "utf8");
  assert.ok(rv.includes("b.pdf") && rv.includes("c.pdf"));
});
