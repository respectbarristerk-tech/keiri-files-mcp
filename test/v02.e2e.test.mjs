// v0.2 の結合テスト: read_file（画像・PDF・HEIC・上限・許可フォルダ外）と ledger_append の存在確認。
// SDKのMCPクライアントでサーバー（dist/index.js）を stdio 起動する。
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
const recDir = path.join(here, "fixtures", "receipts");
const readings = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "readings.json"), "utf8"));
let tmp, root, inbox, outside, client;

const read = (p) => client.callTool({ name: "read_file", arguments: { path: p } });
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-v02-"));
  root = path.join(tmp, "経理 v02");
  inbox = path.join(root, "受信");
  outside = path.join(tmp, "外部");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(outside);
  for (const f of fs.readdirSync(recDir)) fs.copyFileSync(path.join(recDir, f), path.join(inbox, f));
  // テキストの無いPDF（線だけ）、HEIC、大きすぎる画像、中身が画像でない .jpg、許可フォルダ外のファイル
  const c = "0 0 m 100 100 l S";
  fs.writeFileSync(path.join(inbox, "スキャンのみ.pdf"),
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${c.length} >>\nstream\n${c}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
  fs.writeFileSync(path.join(inbox, "iphone.heic"), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]));
  const big = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
  fs.writeFileSync(path.join(inbox, "big.png"), big);
  fs.writeFileSync(path.join(inbox, "偽物.jpg"), "これは画像ではありません");
  fs.writeFileSync(path.join(inbox, "メモ.txt"), "対象外");
  fs.copyFileSync(path.join(recDir, "IMG_0001.jpg"), path.join(outside, "secret.jpg"));
  client = new Client({ name: "keiri-v02", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, "dist", "index.js"), root], stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true }); // テスト用の一時フォルダだけを片付ける
});

test("read_file: JPG/PNG は image コンテンツ（base64・mimeType付き）で返す", async () => {
  for (const r of readings.filter((x) => !x.path.endsWith(".pdf"))) {
    const res = await read("受信/" + r.path);
    assert.equal(!!res.isError, false, text(res));
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, r.path);
    assert.equal(img.mimeType, /\.png$/i.test(r.path) ? "image/png" : "image/jpeg");
    assert.deepEqual(Buffer.from(img.data, "base64"), fs.readFileSync(path.join(recDir, r.path)));
    assert.match(text(res), /データです/);
  }
});

test("read_file: テキスト入りPDFは埋め込みテキストで返す（readings.json と一致）", async () => {
  for (const r of readings.filter((x) => x.path.endsWith(".pdf"))) {
    const res = await read("受信/" + r.path);
    assert.equal(!!res.isError, false, text(res));
    assert.equal(res.content.length, 1);
    const t = text(res);
    assert.ok(t.includes(r.vendor) && t.includes(r.date), t);
    assert.ok(t.includes("¥" + Number(String(r.amount).replace(/,/g, "")).toLocaleString("ja-JP")), t);
    if (r.invoice_no) assert.ok(t.includes(r.invoice_no), t);
    assert.match(t, /埋め込みテキスト/);
  }
});

test("read_file: テキストの無いPDFは resource（blob, application/pdf）で返す", async () => {
  const res = await read("受信/スキャンのみ.pdf");
  assert.equal(!!res.isError, false, text(res));
  const rs = res.content.find((c) => c.type === "resource");
  assert.ok(rs);
  assert.equal(rs.resource.mimeType, "application/pdf");
  assert.ok(rs.resource.uri.startsWith("file://"));
  assert.deepEqual(Buffer.from(rs.resource.blob, "base64"), fs.readFileSync(path.join(inbox, "スキャンのみ.pdf")));
  assert.match(text(res), /JPG\/PNG に変換/);
});

test("read_file: HEIC・上限超え・画像でない・対象外・存在しない・許可フォルダ外はエラー", async () => {
  const cases = [
    ["受信/iphone.heic", /JPGに変換/],
    ["受信/big.png", /大きすぎ/],
    ["受信/偽物.jpg", /画像として読めません/],
    ["受信/メモ.txt", /対象外の拡張子/],
    ["受信/無い.png", /見つかりません/],
    ["受信", /ファイルではありません/],
    ["../外部/secret.jpg", /許可フォルダの外/],
    [path.join(outside, "secret.jpg"), /許可フォルダの外/],
    ["", /path を指定/],
  ];
  for (const [p, re] of cases) {
    const res = await read(p);
    assert.equal(res.isError, true, p);
    assert.match(text(res), re, p);
    assert.ok(!res.content.some((c) => c.type === "image" || c.type === "resource"), p);
  }
});

test("ledger_append: 整理済みに無い証憑ファイル名は警告して追記しない", async () => {
  const p = await client.callTool({ name: "propose_names", arguments: { items: [{ path: "受信/IMG_0001.jpg", date: "2026-10-10", vendor: "CON", amount: 1320, doc_type: "領収書" }] } });
  const plan = JSON.parse(p.content[0].text);
  assert.equal(plan.proposals[0].new_name, "20261010__CON_1320_領収書.jpg");
  const ap = JSON.parse((await client.callTool({ name: "apply_renames", arguments: { plan_id: plan.plan_id } })).content[0].text);
  assert.equal(ap.done, 1);
  const ok = { date: "2026-10-10", vendor: "CON", amount: 1320, doc_type: "領収書", file_name: "20261010__CON_1320_領収書.jpg" };
  const r = await client.callTool({ name: "ledger_append", arguments: { entries: [{ ...ok, file_name: "ない.pdf" }, { ...ok, file_name: ".." }, ok] } });
  const d = JSON.parse(r.content[0].text);
  assert.equal(d.appended, 1);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0].warning, /見つからない/);
  assert.equal(d.errors.length, 1); // ".." はファイル名として不正
  const csv = fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8").trim().split("\r\n");
  assert.equal(csv.length, 2);
  assert.ok(!csv.join("\n").includes("ない.pdf"));
  // 整理済みのファイルも read_file で読める
  const res = await read("整理済み/20261010__CON_1320_領収書.jpg");
  assert.equal(res.content.find((c) => c.type === "image")?.mimeType, "image/jpeg");
});

test("ledger_append: rename で整理したファイルは log.csv の記録先に実在すれば追記できる", async () => {
  const sub = path.join(inbox, "リネーム");
  fs.mkdirSync(sub);
  fs.copyFileSync(path.join(recDir, "scan_004.png"), path.join(sub, "a.png"));
  fs.copyFileSync(path.join(recDir, "レシート 003.png"), path.join(sub, "b.png"));
  const items = [
    { path: "受信/リネーム/a.png", date: "2026-10-15", vendor: "見本交通（架空）", amount: 2400, doc_type: "領収書" },
    { path: "受信/リネーム/b.png", date: "2026-10-12", vendor: "架空カフェ 試験店", amount: 980, doc_type: "領収書" },
  ];
  const plan = JSON.parse((await client.callTool({ name: "propose_names", arguments: { items } })).content[0].text);
  const ap = JSON.parse((await client.callTool({ name: "apply_renames", arguments: { plan_id: plan.plan_id, mode: "rename" } })).content[0].text);
  assert.equal(ap.done, 2, JSON.stringify(ap));
  const [e1, e2] = ap.results.map((r) => r.ledger_entry);
  assert.ok(!fs.existsSync(path.join(root, "整理済み", e1.file_name))); // 整理済み には無い
  // 2件目は記録先から移動された（実在しない）ので警告
  fs.renameSync(path.join(sub, e2.file_name), path.join(tmp, e2.file_name));
  const d = JSON.parse((await client.callTool({ name: "ledger_append", arguments: { entries: [e1, e2] } })).content[0].text);
  assert.equal(d.appended, 1, JSON.stringify(d));
  assert.equal(d.warnings.length, 1);
  assert.equal(d.warnings[0].file_name, e2.file_name);
  assert.match(d.warnings[0].warning, /見つからない/);
  const csv = fs.readFileSync(path.join(root, "整理済み", "ledger.csv"), "utf8");
  assert.ok(csv.includes(e1.file_name) && !csv.includes(e2.file_name));
});
