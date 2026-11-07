// 単体テスト: 形式チェック、CSV、パスの安全確認（npm run build の後に npm test）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDate, checkAmount, checkInvoiceNo, checkDocType, sanitizePart } from "../dist/validate.js";
import { parseCsv, toLine } from "../dist/csv.js";
import { loadConfig } from "../dist/config.js";
import { resolveSafe, isInside } from "../dist/pathguard.js";
import { buildName } from "../dist/core.js";

test("日付の形式チェック", () => {
  assert.equal(checkDate("2026-10-01").value, "2026-10-01");
  assert.ok(checkDate("2026/10/01").error);
  assert.ok(checkDate("2026-02-30").error);
  assert.ok(checkDate("2026-13-01").error);
  assert.ok(checkDate("").error);
  assert.equal(checkDate("２０２６-１０-０１").value, "2026-10-01"); // 全角数字は正規化
});

test("金額の形式チェック", () => {
  assert.equal(checkAmount(1200).value, 1200);
  assert.equal(checkAmount("1,200円").value, 1200);
  assert.equal(checkAmount("￥33,000").value, 33000);
  assert.ok(checkAmount(-1).error);
  assert.ok(checkAmount(12.5).error);
  assert.ok(checkAmount("12.5").error);
  assert.ok(checkAmount("abc").error);
});

test("登録番号の形式チェック", () => {
  assert.equal(checkInvoiceNo("T0000000000001").value, "T0000000000001");
  assert.equal(checkInvoiceNo("ｔ００００００００００００１").value, "T0000000000001");
  assert.equal(checkInvoiceNo("").value, "");
  assert.ok(checkInvoiceNo("T123").error);
  assert.ok(checkInvoiceNo("0000000000001").error);
  assert.ok(checkInvoiceNo("T00000000000012").error);
});

test("書類種別", () => {
  assert.equal(checkDocType("領収書").value, "領収書");
  assert.ok(checkDocType("レシート").error);
});

test("ファイル名の整形", () => {
  assert.equal(sanitizePart('A/B:C*D?"E<F>G|H', 40), "A-B-C-D-E-F-G-H");
  assert.equal(sanitizePart("架空 商事_テスト", 40), "架空-商事-テスト");
  assert.equal(sanitizePart("  ..  ", 40), "");
  assert.equal([...sanitizePart("あ".repeat(100), 40)].length, 40);
  const n = buildName("2026-10-01", "あ".repeat(200), 1000, "領収書", ".pdf");
  assert.ok([...n].length <= 120);
  assert.match(n, /^20261001_あ+_1000_領収書\.pdf$/);
});

test("CSV の往復（カンマ・引用符・数式・改行）", () => {
  const line = toLine(["a,b", 'x"y', "=SUM(A1)", "改\n行", 100]);
  const rows = parseCsv("﻿" + line);
  assert.deepEqual(rows[0], ["a,b", 'x"y', "'=SUM(A1)", "改 行", "100"]);
});

test("パスの安全確認（../ 脱出・外部の絶対パス）", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-unit-"));
  const root = path.join(base, "許可 フォルダ");
  fs.mkdirSync(root);
  const cfg = loadConfig([root]);
  assert.ok(isInside(resolveSafe(cfg, "a/b.pdf"), cfg.primary));
  assert.throws(() => resolveSafe(cfg, "../outside.pdf"), /許可フォルダの外/);
  assert.throws(() => resolveSafe(cfg, "a/../../outside.pdf"), /許可フォルダの外/);
  assert.throws(() => resolveSafe(cfg, base), /許可フォルダの外/);
  assert.throws(() => resolveSafe(cfg, path.join(os.tmpdir(), "x.pdf")), /許可フォルダの外/);
  // 名前が ".." で始まるだけのフォルダは配下扱い
  assert.ok(isInside(path.join(cfg.primary, "..x"), cfg.primary));
  // 前方一致だけの別フォルダは外扱い
  assert.equal(isInside(cfg.primary + "2", cfg.primary), false);
});

test("許可フォルダの指定なし・存在しないものは起動エラー", () => {
  assert.throws(() => loadConfig([], {}), /許可フォルダが指定されていません/);
  assert.throws(() => loadConfig([path.join(os.tmpdir(), "keiri-no-such-dir-xyz")], {}), /見つかりません/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-env-"));
  assert.equal(loadConfig([], { KEIRI_ALLOWED_DIRS: d }).roots.length, 1);
});
