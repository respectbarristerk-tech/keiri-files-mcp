// v0.3.1: 台帳Excel（「経費」シート A〜J 列: 日付〜事業割合）に値として貼れる表記の確認
// openpyxl 等は使わず、ledger.csv の列名と値の表記だけを確認する
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LEDGER_HEADER, INVOICE_YES, INVOICE_NO, invoiceFlag, formatRatio } from "../dist/core.js";
import { readCsv } from "../dist/csv.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const recDir = path.join(here, "fixtures", "receipts");
let tmp, root, client;

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
}
const ledgerFile = () => path.join(root, "整理済み", "ledger.csv");
const col = (name) => LEDGER_HEADER.indexOf(name);

test("台帳の列: A〜J 列（日付〜事業割合）の並びは台帳Excelの「経費」シートと同じ順", () => {
  assert.deepEqual(LEDGER_HEADER.slice(0, 10), [
    "日付", "支払先", "科目", "内容", "金額", "支払方法", "インボイス有無", "登録番号", "証憑ファイル名", "事業割合(%)",
  ]);
  assert.deepEqual(LEDGER_HEADER.slice(10), ["書類種別", "元ファイル", "登録日時"]); // K列以降（台帳Excelには貼らない）
});

test("インボイスは あり/なし、事業割合は 50% の形", () => {
  assert.equal(INVOICE_YES, "あり");
  assert.equal(INVOICE_NO, "なし");
  assert.equal(invoiceFlag("T0000000000001"), "あり");
  assert.equal(invoiceFlag(undefined), "なし");
  assert.equal(invoiceFlag(""), "なし");
  assert.equal(formatRatio(50), "50%");
  assert.equal(formatRatio(100), "100%");
  assert.equal(formatRatio(0), "0%");
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v031-"));
  root = path.join(tmp, "経理 v031");
  fs.mkdirSync(path.join(root, "整理済み"), { recursive: true });
  for (const f of ["new_a.pdf", "new_b.pdf", "new_c.pdf", "new_d.pdf", "old_1.pdf"]) {
    fs.copyFileSync(path.join(recDir, "invoice_001.pdf"), path.join(root, "整理済み", f));
  }
  // v0.3.0 までの表記（インボイス 有/無、事業割合 数字のみ）の既存台帳
  const old = [
    LEDGER_HEADER.join(","),
    ["2026-10-01", "旧表記テスト商店", "", "", "1100", "", "有", "T0000000000009", "old_1.pdf", "100", "請求書", "", "2026-10-02 10:00:00"].join(","),
    ["2026-10-03", "旧表記テスト食堂", "", "", "800", "", "無", "", "old_2.pdf", "", "レシート", "", "2026-10-03 10:00:00"].join(","),
  ];
  fs.writeFileSync(ledgerFile(), "﻿" + old.join("\r\n") + "\r\n");
  client = new Client({ name: "keiri-v031", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("ledger_append の書き方と、旧表記の既存台帳の読み込み・重複判定", async () => {
  const base = { doc_type: "請求書" };
  const la = await call("ledger_append", {
    entries: [
      { ...base, date: "2026-10-10", vendor: "新表記テスト社", amount: 5000, file_name: "new_a.pdf", invoice_no: "T0000000000001", business_ratio: 50 },
      { ...base, date: "2026-10-11", vendor: "新表記テスト社", amount: 3000, file_name: "new_b.pdf", business_ratio: "30%" },
      { ...base, date: "2026-10-12", vendor: "新表記テスト社", amount: 2000, file_name: "new_c.pdf" },
      // 旧表記の行と日付・取引先・金額が同じ → 重複の可能性（追記はする）
      { ...base, date: "2026-10-01", vendor: "旧表記テスト商店", amount: 1100, file_name: "new_d.pdf", invoice_no: "T0000000000009" },
      // 旧表記の行と同じ証憑ファイル名 → 二重登録で追記しない
      { ...base, date: "2026-10-01", vendor: "旧表記テスト商店", amount: 1100, file_name: "old_1.pdf" },
    ],
  });
  assert.equal(la.isError, false, la.text);
  assert.equal(la.data.appended, 4);
  assert.ok(la.data.warnings.some((w) => w.file_name === "new_d.pdf" && /重複の可能性: 台帳に登録済みの「old_1\.pdf」/.test(w.warning)));
  assert.ok(la.data.warnings.some((w) => w.file_name === "old_1.pdf" && /二重登録/.test(w.warning)));

  const rows = readCsv(ledgerFile()).slice(1);
  assert.equal(rows.length, 6);
  const added = Object.fromEntries(rows.slice(2).map((r) => [r[col("証憑ファイル名")], r]));
  assert.equal(added["new_a.pdf"][col("インボイス有無")], "あり");
  assert.equal(added["new_a.pdf"][col("事業割合(%)")], "50%");
  assert.equal(added["new_b.pdf"][col("インボイス有無")], "なし");
  assert.equal(added["new_b.pdf"][col("事業割合(%)")], "30%");
  assert.equal(added["new_c.pdf"][col("事業割合(%)")], ""); // 未指定は空欄のまま
  for (const r of rows.slice(2)) assert.ok(["あり", "なし"].includes(r[col("インボイス有無")]));
  // CSV の生の行でも「50%」がそのまま（引用符なし）で書かれている
  assert.match(fs.readFileSync(ledgerFile(), "utf8"), /,new_a\.pdf,50%,請求書,/);

  // 旧表記の行も検索で読める
  const s = await call("search_ledger", { vendor: "旧表記" });
  assert.equal(s.data.count, 3);
  assert.deepEqual(s.data.rows.map((r) => r["インボイス有無"]).sort(), ["あり", "有", "無"].sort());
});
