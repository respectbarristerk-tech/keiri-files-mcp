// v0.3 のテスト: 重複の可能性の警告（propose_names / ledger_append）、見積書・納品書の扱い。
// 単体（dupKey）と、SDKのMCPクライアントでサーバー（dist/index.js）を stdio 起動する結合テスト。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dupKey, vendorKey } from "../dist/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const recDir = path.join(here, "fixtures", "receipts");
const readings = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "readings.json"), "utf8"));
let tmp, root, client;

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
}
const ledgerLines = () => fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8").trim().split("\r\n").length - 1;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v03-"));
  root = path.join(tmp, "経理 v03");
  fs.mkdirSync(path.join(root, "受信"), { recursive: true });
  for (const f of fs.readdirSync(recDir)) fs.copyFileSync(path.join(recDir, f), path.join(root, "受信", f));
  fs.copyFileSync(path.join(recDir, "IMG_0001.jpg"), path.join(root, "受信", "追加の写真.jpg"));
  client = new Client({ name: "keiri-v03", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("dupKey: 取引先の前後の空白・全角/半角の違いは無視、日付・金額・中身の違いは区別", () => {
  const k = dupKey("2026-10-10", "テスト文具店", 1320);
  assert.equal(dupKey("2026-10-10", "　ﾃｽﾄ文具店 ", 1320), k);
  assert.equal(dupKey("2026-10-10", "テスト文具店", "1320"), k);
  assert.equal(dupKey("2026-10-10", "ＡＢＣ　Ｓｈｏｐ", 1), dupKey("2026-10-10", " ABC Shop", 1));
  assert.equal(vendorKey("'=架空"), "=架空"); // CSV の数式対策の ' は外して比べる
  assert.notEqual(dupKey("2026-10-11", "テスト文具店", 1320), k);
  assert.notEqual(dupKey("2026-10-10", "テスト文具店", 1321), k);
  assert.notEqual(dupKey("2026-10-10", "テスト文具", 1320), k);
});

test("propose_names / ledger_append: 重複の可能性・見積書・納品書", async () => {
  // 1) 同じ依頼の中の重複（IMG_0001 と IMG_0002 が同日・同取引先・同額）
  const items = readings.map((r) => ({ ...r, path: "受信/" + r.path }));
  const prop = await call("propose_names", { items });
  assert.equal(prop.isError, false, prop.text);
  assert.equal(prop.data.errors.length, 0);
  assert.equal(prop.data.proposals.length, 10); // 警告だけで、案からは外さない
  assert.equal(prop.data.warnings.length, 1, JSON.stringify(prop.data.warnings));
  assert.equal(prop.data.warnings[0].path, "受信/IMG_0002.JPG");
  assert.match(prop.data.warnings[0].warning, /^重複の可能性: この依頼の 4 番目/);

  const ap = await call("apply_renames", { plan_id: prop.data.plan_id });
  assert.equal(ap.data.done, 10);
  const entries = ap.data.results.map((r) => r.ledger_entry);

  // 2) 既定では見積書は追記しない。納品書は注意つきで追記。依頼内の重複は警告して追記
  const la = await call("ledger_append", { entries });
  assert.equal(la.isError, false, la.text);
  assert.equal(la.data.appended, 9);
  assert.equal(ledgerLines(), 9);
  const w = la.data.warnings;
  assert.equal(w.length, 3, JSON.stringify(w));
  const q = w.find((x) => /見積書/.test(x.file_name));
  assert.match(q.warning, /見積書は支払いの記録ではないため追記しませんでした.*include_quotes: true/);
  const n = w.find((x) => /納品書/.test(x.file_name));
  assert.match(n.warning, /納品書.*二重計上/);
  const d = w.find((x) => /重複の可能性/.test(x.warning));
  assert.equal(d.file_name, "20261010_テスト文具店_1320_領収書_2.jpg");
  assert.match(d.warning, /この依頼で追記した「20261010_テスト文具店_1320_領収書.jpg」/);
  assert.ok(!fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8").includes("見積書"));

  // 3) include_quotes: true なら見積書も追記できる
  const quote = entries.filter((e) => e.doc_type === "見積書");
  assert.equal(quote.length, 1);
  const lq = await call("ledger_append", { entries: quote, include_quotes: true });
  assert.equal(lq.data.appended, 1);
  assert.equal(lq.data.warnings.length, 0, JSON.stringify(lq.data.warnings));
  assert.equal(ledgerLines(), 10);

  // 4) 台帳に既にあるものとの重複（取引先の全角/半角・前後の空白は無視）。エラーにはせず警告だけ
  const extra = [{ path: "受信/追加の写真.jpg", date: "2026-10-10", vendor: "　ﾃｽﾄ文具店 ", amount: "１,３２０", doc_type: "領収書" }];
  const p2 = await call("propose_names", { items: extra });
  assert.equal(p2.data.errors.length, 0);
  assert.equal(p2.data.proposals.length, 1);
  assert.equal(p2.data.warnings.length, 1, JSON.stringify(p2.data.warnings));
  assert.match(p2.data.warnings[0].warning, /^重複の可能性: 台帳に登録済みの「20261010_テスト文具店_1320_領収書.jpg」/);
  const a2 = await call("apply_renames", { plan_id: p2.data.plan_id });
  assert.equal(a2.data.done, 1);
  const l2 = await call("ledger_append", { entries: [{ ...a2.data.results[0].ledger_entry, vendor: "テスト文具店　" }] });
  assert.equal(l2.data.appended, 1); // 止めるかは利用者とAIが決める
  assert.equal(l2.data.warnings.length, 1);
  assert.match(l2.data.warnings[0].warning, /^重複の可能性: 台帳に登録済み.*（追記はしました）/);
  assert.equal(ledgerLines(), 11);

  // 5) 重複でないもの（金額違い・日付違い）は警告なし。見積書を include_quotes なしで渡すと警告のみで追記しない（エラーではない）
  const p3 = await call("propose_names", {
    items: [
      { path: "受信/IMG_0001.jpg", date: "2026-10-10", vendor: "テスト文具店", amount: 1321, doc_type: "領収書" },
      { path: "受信/IMG_0002.JPG", date: "2026-10-11", vendor: "テスト文具店", amount: 1320, doc_type: "領収書" },
    ],
  });
  assert.equal(p3.data.warnings.length, 0, JSON.stringify(p3.data.warnings));
  const l3 = await call("ledger_append", { entries: quote });
  assert.equal(l3.isError, false);
  assert.equal(l3.data.appended, 0);
  assert.equal(l3.data.errors.length, 0);
  assert.match(l3.data.warnings[0].warning, /見積書/);
  assert.equal(ledgerLines(), 11);
});

test("ledger_append の入力に include_quotes がある", async () => {
  const { tools } = await client.listTools();
  const la = tools.find((t) => t.name === "ledger_append");
  assert.equal(la.inputSchema.properties.include_quotes.type, "boolean");
  assert.ok(!(la.inputSchema.required ?? []).includes("include_quotes"));
});
