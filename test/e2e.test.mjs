// 結合テスト: SDKのMCPクライアントでサーバー（dist/index.js）を stdio 起動し、
// 架空の証憑10件で scan → propose → apply(copy) → ledger_append → search を通す。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const readings = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "readings.json"), "utf8"));

let tmp, root, emptyRoot, outside, client;

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-e2e-"));
  root = path.join(tmp, "経理 テスト フォルダ"); // 日本語・空白入りのパス
  emptyRoot = path.join(tmp, "空のフォルダ");
  outside = path.join(tmp, "外部");
  const inbox = path.join(root, "受信 2026-10");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(emptyRoot);
  fs.mkdirSync(outside);
  for (const f of fs.readdirSync(path.join(here, "fixtures", "receipts"))) {
    fs.copyFileSync(path.join(here, "fixtures", "receipts", f), path.join(inbox, f));
  }
  fs.writeFileSync(path.join(inbox, "メモ.txt"), "対象外の拡張子");
  fs.writeFileSync(path.join(outside, "secret.pdf"), "%PDF-1.4 outside");
  try {
    fs.symlinkSync(outside, path.join(root, "外部へのリンク"), "junction");
  } catch {
    /* 権限が無い環境ではリンクのテストを省略 */
  }
  client = new Client({ name: "keiri-e2e", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root, emptyRoot], stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("ツール一覧と annotations", async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(by).sort(), ["apply_renames", "ledger_append", "propose_names", "read_file", "scan_folder", "search_ledger"]);
  assert.equal(by.read_file.annotations.readOnlyHint, true);
  assert.equal(by.read_file.annotations.destructiveHint, false);
  assert.equal(by.scan_folder.annotations.readOnlyHint, true);
  assert.equal(by.propose_names.annotations.readOnlyHint, true);
  assert.equal(by.search_ledger.annotations.readOnlyHint, true);
  assert.equal(by.apply_renames.annotations.readOnlyHint, false);
  assert.equal(by.apply_renames.annotations.destructiveHint, true);
  assert.equal(by.ledger_append.annotations.readOnlyHint, false);
  assert.equal(by.ledger_append.annotations.destructiveHint, false);
});

test("通しの流れ: scan → propose → apply(copy) → ledger_append → search", async () => {
  const scan = await call("scan_folder", {});
  assert.equal(scan.isError, false, scan.text);
  assert.equal(scan.data.count, 10);
  assert.ok(scan.data.files.every((f) => f.path.startsWith("受信 2026-10/") && f.registered === false));

  const items = readings.map((r) => ({ ...r, path: "受信 2026-10/" + r.path }));
  const prop = await call("propose_names", { items });
  assert.equal(prop.isError, false, prop.text);
  assert.equal(prop.data.errors.length, 0, JSON.stringify(prop.data.errors));
  assert.equal(prop.data.proposals.length, 10);
  const names = prop.data.proposals.map((p) => p.new_name);
  assert.ok(names.includes("20261001_架空商事テスト株式会社_55000_請求書.pdf"));
  assert.ok(names.includes("20261005_ダミーデザイン工房_33000_請求書.pdf"));
  assert.ok(names.includes("20261012_架空カフェ-試験店_980_領収書.png"));
  assert.ok(names.includes("20261020_Fictional-Books-Test_3300_領収書.jpg"));
  assert.ok(names.includes("20261025_架空通信サービス_5500_その他.jpg"));
  // 同名衝突は _2
  assert.ok(names.includes("20261010_テスト文具店_1320_領収書.jpg"));
  assert.ok(names.includes("20261010_テスト文具店_1320_領収書_2.jpg"));
  // propose ではファイルは変わらない
  assert.equal(fs.existsSync(path.join(root, "整理済み")), false);

  const ap = await call("apply_renames", { plan_id: prop.data.plan_id });
  assert.equal(ap.isError, false, ap.text);
  assert.equal(ap.data.done, 10);
  const outFiles = fs.readdirSync(path.join(root, "整理済み")).sort();
  assert.equal(outFiles.filter((f) => f !== "log.csv").length, 10);
  assert.equal(fs.readdirSync(path.join(root, "受信 2026-10")).length, 11); // 元ファイルはそのまま（copy）
  const log = fs.readFileSync(path.join(root, "整理済み", "log.csv"), "utf8");
  assert.ok(log.startsWith("﻿実行日時,"));
  assert.equal(log.trim().split("\r\n").length, 11);

  // 同じ plan_id の再実行は拒否
  const again = await call("apply_renames", { plan_id: prop.data.plan_id });
  assert.equal(again.isError, true);
  assert.match(again.text, /実行済み/);

  const entries = ap.data.results.map((r, i) => ({ ...r.ledger_entry, payment_method: i % 2 ? "現金" : "振込", business_ratio: 100 }));
  const la = await call("ledger_append", { entries, include_quotes: true }); // v0.3: 見積書も入れる指定（既定の扱いは v03.e2e で確認）
  assert.equal(la.isError, false, la.text);
  assert.equal(la.data.appended, 10);
  const csv = fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8");
  assert.ok(csv.startsWith("﻿日付,支払先,科目,内容,金額,支払方法,インボイス有無,登録番号,証憑ファイル名,事業割合(%),書類種別,元ファイル,登録日時\r\n"));
  assert.equal(csv.trim().split("\r\n").length, 11);

  // 二重登録は警告して追記しない
  const dup = await call("ledger_append", { entries: entries.slice(0, 2) });
  assert.equal(dup.data.appended, 0);
  assert.equal(dup.data.warnings.length, 2);
  assert.equal(fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8").trim().split("\r\n").length, 11);

  // scan で登録済みが分かる
  const scan2 = await call("scan_folder", { subdir: "受信 2026-10" });
  assert.equal(scan2.data.count, 10);
  assert.ok(scan2.data.files.every((f) => f.registered === true));

  // 検索
  const s1 = await call("search_ledger", { vendor: "架空商事" });
  assert.equal(s1.data.count, 2);
  assert.equal(s1.data.total_amount, 165000);
  const s2 = await call("search_ledger", { date_from: "2026-10-10", date_to: "2026-10-15", amount_min: 1000 });
  assert.equal(s2.data.count, 3);
  const s3 = await call("search_ledger", {});
  assert.equal(s3.data.count, 10);
  assert.equal(s3.data.rows[0]["インボイス有無"], "あり");
  const s4 = await call("search_ledger", { amount_max: "1,000" });
  assert.equal(s4.data.count, 1);
});

test("許可フォルダ外・../ 脱出・リンクでの脱出を拒否", async () => {
  const r1 = await call("scan_folder", { subdir: "../外部" });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /許可フォルダの外/);
  const r2 = await call("scan_folder", { subdir: outside });
  assert.equal(r2.isError, true);
  const r3 = await call("propose_names", { items: [{ path: path.join(outside, "secret.pdf"), date: "2026-10-01", vendor: "架空", amount: 1, doc_type: "領収書" }] });
  assert.equal(r3.data.plan_id, null);
  assert.match(r3.data.errors[0].errors[0], /許可フォルダの外/);
  if (fs.existsSync(path.join(root, "外部へのリンク"))) {
    const r4 = await call("scan_folder", { subdir: "外部へのリンク" });
    assert.equal(r4.isError, true);
    assert.match(r4.text, /リンク先が許可フォルダの外/);
    const r5 = await call("propose_names", { items: [{ path: "外部へのリンク/secret.pdf", date: "2026-10-01", vendor: "架空", amount: 1, doc_type: "領収書" }] });
    assert.equal(r5.data.plan_id, null);
    // 全体スキャンでもリンク先は数えない
    const r6 = await call("scan_folder", {});
    assert.ok(r6.data.files.every((f) => !f.path.includes("secret")));
  }
});

test("不正な日付・金額・登録番号・書類種別・存在しないファイル", async () => {
  const bad = [
    { path: "受信 2026-10/invoice_001.pdf", date: "2026/10/01", vendor: "架空", amount: 100, doc_type: "請求書" },
    { path: "受信 2026-10/invoice_002.pdf", date: "2026-02-30", vendor: "架空", amount: 100, doc_type: "請求書" },
    { path: "受信 2026-10/IMG_0001.jpg", date: "2026-10-01", vendor: "架空", amount: -5, doc_type: "領収書" },
    { path: "受信 2026-10/scan_004.png", date: "2026-10-01", vendor: "架空", amount: "12.5", doc_type: "領収書" },
    { path: "受信 2026-10/receipt_005.jpg", date: "2026-10-01", vendor: "架空", amount: 100, doc_type: "領収書", invoice_no: "T12345" },
    { path: "受信 2026-10/receipt_006.jpeg", date: "2026-10-01", vendor: "架空", amount: 100, doc_type: "レシート" },
    { path: "受信 2026-10/無いファイル.pdf", date: "2026-10-01", vendor: "架空", amount: 100, doc_type: "領収書" },
    { path: "受信 2026-10/メモ.txt", date: "2026-10-01", vendor: "架空", amount: 100, doc_type: "領収書" },
    { path: "受信 2026-10/IMG_0002.JPG", date: "2026-10-01", vendor: "///", amount: 100, doc_type: "領収書" },
  ];
  const r = await call("propose_names", { items: bad });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.plan_id, null);
  assert.equal(r.data.errors.length, bad.length);
  const msgs = r.data.errors.map((e) => e.errors.join(" "));
  assert.match(msgs[0], /YYYY-MM-DD/);
  assert.match(msgs[1], /存在しない日付/);
  assert.match(msgs[2], /0以上の整数/);
  assert.match(msgs[3], /0以上の整数/);
  assert.match(msgs[4], /T＋13桁/);
  assert.match(msgs[5], /書類種別/);
  assert.match(msgs[6], /見つかりません/);
  assert.match(msgs[7], /対象外の拡張子/);
  assert.match(msgs[8], /取引先/);

  const le = await call("ledger_append", { entries: [{ date: "2026-10-01", vendor: "架空", amount: 100, doc_type: "領収書", file_name: "../x.pdf", invoice_no: "X1" }] });
  assert.equal(le.data.appended, 0);
  assert.equal(le.data.errors.length, 1);
  const s = await call("search_ledger", { date_from: "2026-13-01" });
  assert.equal(s.isError, true);
  const s2 = await call("search_ledger", { date_from: "2026-10-31", date_to: "2026-10-01" });
  assert.equal(s2.isError, true);
  const ap = await call("apply_renames", { plan_id: "nonexist" });
  assert.equal(ap.isError, true);
  assert.match(ap.text, /plan_id が見つかりません/);
});

test("空フォルダ・2つ目の許可フォルダ", async () => {
  const r = await call("scan_folder", { subdir: emptyRoot });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.count, 0);
  assert.match(r.data.note, /ありませんでした/);
  const e = await call("propose_names", { items: [] });
  assert.equal(e.isError, true);
});

test("rename モード: 上書きせず名前を変える", async () => {
  const sub = path.join(root, "リネーム試験");
  fs.mkdirSync(sub);
  fs.copyFileSync(path.join(here, "fixtures", "receipts", "invoice_001.pdf"), path.join(sub, "a.pdf"));
  fs.copyFileSync(path.join(here, "fixtures", "receipts", "invoice_002.pdf"), path.join(sub, "20261101_架空試験商会_500_領収書.pdf"));
  const p = await call("propose_names", { items: [{ path: "リネーム試験/a.pdf", date: "2026-11-01", vendor: "架空試験商会", amount: 500, doc_type: "領収書" }] });
  const ap = await call("apply_renames", { plan_id: p.data.plan_id, mode: "rename" });
  assert.equal(ap.data.done, 1, ap.text);
  const files = fs.readdirSync(sub).sort();
  assert.deepEqual(files, ["20261101_架空試験商会_500_領収書.pdf", "20261101_架空試験商会_500_領収書_2.pdf"]);
  // 既存ファイルの中身は変わっていない
  assert.deepEqual(fs.readFileSync(path.join(sub, "20261101_架空試験商会_500_領収書.pdf")), fs.readFileSync(path.join(here, "fixtures", "receipts", "invoice_002.pdf")));
});

test("提案後に元ファイルが変わったら実行しない", async () => {
  const f = path.join(root, "受信 2026-10", "invoice_001.pdf");
  const p = await call("propose_names", { items: [{ path: "受信 2026-10/invoice_001.pdf", date: "2026-10-01", vendor: "架空変更確認", amount: 1, doc_type: "請求書" }] });
  fs.appendFileSync(f, "\n% changed");
  const ap = await call("apply_renames", { plan_id: p.data.plan_id });
  assert.equal(ap.data.done, 0);
  assert.match(ap.data.results[0].status, /変更された/);
});
