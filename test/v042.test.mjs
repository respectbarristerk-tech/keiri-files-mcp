// v0.4.2（候補）のテスト: アメックス・ダイナース形式（4-6-5／4-6-4桁）のカード番号、誤検知の減少（日付＋区切り＋8桁、「末尾 の 1234 件」）、
// 医療関係の行が pending のカード検査を外れても何も記録されないこと、ledger_append の知らない列名の警告。
// 架空のデータだけを使う（カード番号は各社が公開しているテスト用の見本番号。leak_check 対策で分割して書く）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { looksLikeCardNumber } from "../dist/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
let tmp, root, client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const json = (r) => { assert.ok(!r.isError, text(r)); return JSON.parse(r.content[0].text); };
const AMEX = ["3782", "822463", "10005"]; // アメックスの見本番号（4-6-5）
const DINERS = ["3056", "930902", "5904"]; // ダイナースの見本番号（4-6-4）

function allText(dir) {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += allText(p);
    else if (/\.(csv|txt|json)$/i.test(e.name)) out += fs.readFileSync(p, "utf8");
  }
  return out;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v042-"));
  root = path.join(tmp, "レシート台帳");
  fs.mkdirSync(path.join(root, "受信"), { recursive: true });
  for (const n of ["IMG_0001.jpg", "IMG_0002.jpg"]) fs.copyFileSync(path.join(here, "fixtures", "receipts", "IMG_0001.jpg"), path.join(root, "受信", n));
  client = new Client({ name: "keiri-v042", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});
after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("カード番号: アメックス（4-6-5）・ダイナース（4-6-4）の区切り形を検出する", () => {
  const hits = [
    AMEX.join(" "), AMEX.join("-"), AMEX.join("."), AMEX.join("/"), AMEX.join(""), `AMEX ${AMEX.join(" ")}`,
    "３７８２　８２２４６３　１０００５", DINERS.join(" "), DINERS.join("-"), DINERS.join(""),
  ];
  for (const s of hits) assert.ok(looksLikeCardNumber(s), s);
});

test("カード番号: 日付＋区切り＋8桁、件数・枚数の「末尾 1234 件」は誤検出しない（v0.4.1 では拒否していた）", () => {
  const ok = [
    "20261108 12345678", "20261108-123456", "20261108_12345678.jpg", "末尾 の 1234 件", "末尾1234件", "最後は 1234 枚", "最後の 2000 円",
    "カード番号の欄は空で 1234 件", "電話 0120-123456", "注文 1234-567890-1",
  ];
  for (const s of ok) assert.ok(!looksLikeCardNumber(s), s);
  // 従来どおり拒否するもの（下4桁の表現・16桁）
  for (const s of ["末尾1234", "最後は1234", "カード番号の最後は1234", ["4111", "1111", "1111", "1111"].join(" ")]) assert.ok(looksLikeCardNumber(s), s);
});

test("カード番号: 日付の後ろに続く番号は見逃さない・下4桁の後ろが単位以外の語なら拒否（v0.4.2 検証の指摘）", () => {
  const C = ["4533", "6553", "7197", "0624"]; // 架空の16桁（Luhn を満たす自作のダミー）
  const hits = [
    `20261108 ${C.join(" ")}`, `20261108-${C.join("")}`, `20261108 ${C.join("")}`, `20261108/${C.join("-")}`, `20261108${C.join("")}`,
    `IMG_20261108_${C.join("")}.jpg`, `20261108 ${AMEX.join(" ")}`,
    "末尾1234 本人", "末尾1234 名義", "カード末尾1234 分割払い", "末尾1234 時点", "末尾1234 回収", "末尾1234 人気", "末尾1234 台風", "末尾1234 件数",
  ];
  for (const s of hits) assert.ok(looksLikeCardNumber(s), s);
  for (const s of ["IMG_20261108_123456.jpg", "PXL_20261108_123456789.jpg", "20261108123456.jpg", "末尾1234 件", "末尾1234 円", "最後は1234回"]) assert.ok(!looksLikeCardNumber(s), s);
});

test("pending_add / ledger_append: アメックス形式を実サーバー経由でも拒否する", async () => {
  const p = json(await call("pending_add", { items: [{ path: "受信/IMG_0001.jpg", reason: "私用の可能性", question: `AMEX ${AMEX.join(" ")} の支払いですか` }] }));
  assert.equal(p.added.length, 0);
  assert.match(JSON.stringify(p.errors), /カード番号/);
  const l = json(await call("ledger_append", { entries: [{ date: "2026-10-10", vendor: "架空文具店", amount: 1320, doc_type: "領収書", file_name: "2026-10-10_架空文具店_1320.jpg", payment_method: `AMEX ${AMEX.join("-")}` }] }));
  assert.equal(l.errors.length, 1);
  assert.match(JSON.stringify(l.errors), /カード番号/);
});

test("医療関係: カード検査を外れても支払先・質問文は記録されない（意図どおりの確認）", async () => {
  const r = json(await call("pending_add", { items: [{ path: "受信/IMG_0002.jpg", reason: "医療関係", vendor: `架空クリニック ${AMEX.join(" ")}`, question: `カード ${DINERS.join("-")} で払った` }] }));
  assert.equal(r.added.length, 1, JSON.stringify(r));
  assert.match(JSON.stringify(r.warnings), /記録していません/);
  json(await call("question_write", {}));
  const all = allText(root);
  for (const s of [AMEX[1], DINERS[1], "架空クリニック"]) assert.ok(!all.includes(s), s);
});

test("ledger_append: 知らない列名（content など）は無視したことを warnings で知らせる", async () => {
  const r = json(await call("ledger_append", { entries: [{ date: "2026-10-10", vendor: "架空文具店", amount: 1320, doc_type: "領収書", file_name: "2026-10-10_架空文具店_1320.jpg", content: "文具" }] }));
  assert.match(JSON.stringify(r.warnings), /知らない列名.*content/);
  assert.match(JSON.stringify(r.warnings), /description/);
});
