// v0.4: export_freee（A05 tools/export_freee.py と prompts/04_output_freee.md を移植）。
// 台帳 整理済み/ledger.csv の行を、freee の取引インポート（収入・支出形式）の「支出」CSV にする。
// - 税区分と税額は判断しない。tax_label（利用者の freee 画面の税区分名）を全行に入れる。未指定なら止める
// - 決済の列は出さない（未決済として登録され、決済は freee で行う）
// - 判断が要る行は取込用CSVに入れず freee_要確認.csv へ理由付きで出す
// - 出力した行は 整理済み/freee出力済み.csv に記録し、次回は出さない（台帳そのものは変えない）
// 外部通信なし。freee への登録はしない。
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { BOM, appendRows, readCsv, toLine } from "./csv.js";
import { INVOICE_YES } from "./core.js";
import { KeiriError, displayPath, resolveSafe } from "./pathguard.js";
import { checkDate } from "./validate.js";

export const FREEE_DIR_NAME = "freee出力";
export const FREEE_DONE_FILE = "freee出力済み.csv";
export const FREEE_REVIEW_FILE = "freee_要確認.csv";
export const IMPORT_FIELDS = ["収支区分", "管理番号", "発生日", "取引先", "勘定科目", "税区分", "金額", "備考"];
export const REVIEW_FIELDS = ["証憑ファイル名", "日付", "支払先", "科目", "内容", "金額", "事業割合", "インボイス有無", "理由"];
const DONE_HEADER = ["証憑ファイル名", "出力日", "出力ファイル"];

export const TAX_LABEL_HELP =
  "税区分の名称が指定されていないため、止めました。何も出力していません。freee の税区分は名称が一致しないと取り込めません。このツールもAIも税区分を判断しません。利用者の freee 画面で名称を確認してもらい、そのまま tax_label に指定してください。";

const unq = (s: string | undefined) => (s ?? "").replace(/^'(?=[=+\-@])/, "").trim();
const pad = (n: number) => String(n).padStart(2, "0");

/** 事業割合が空欄または100%なら true。「50%」の形（v0.3.1 以降）と小数（0.5・1。A05 の形）の両方を受ける */
export function isFullRatio(text: string): boolean {
  const t = text.normalize("NFKC").trim();
  if (!t) return true;
  const n = t.endsWith("%") ? Number(t.slice(0, -1)) : Number(t);
  if (Number.isNaN(n)) return false;
  return t.endsWith("%") ? n === 100 : n === 1 || n === 100;
}

export function exportFreee(cfg: Config, args: { tax_label?: string; accounts?: string[]; date_from?: string; date_to?: string }) {
  const taxLabel = String(args?.tax_label ?? "").trim();
  if (!taxLabel) throw new KeiriError(TAX_LABEL_HELP);
  const accounts = Array.isArray(args?.accounts) && args.accounts.length ? new Set(args.accounts.map((a) => String(a).trim()).filter(Boolean)) : undefined;
  const range: { from?: string; to?: string } = {};
  for (const key of ["date_from", "date_to"] as const) {
    const raw = args?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const c = checkDate(raw, key);
    if (c.error) throw new KeiriError(c.error + "。何も出力していません。");
    range[key === "date_from" ? "from" : "to"] = c.value!;
  }
  if (range.from && range.to && range.from > range.to) throw new KeiriError("date_from が date_to より後になっています。何も出力していません。");
  const ledgerFile = resolveSafe(cfg, cfg.ledgerPath);
  const all = readCsv(ledgerFile);
  if (all.length === 0) throw new KeiriError("台帳（整理済み/ledger.csv）がありません。");
  const head = all[0].map((h) => h.replace(/^﻿/, ""));
  const col = (name: string) => head.indexOf(name);
  for (const need of ["日付", "支払先", "科目", "内容", "金額", "インボイス有無", "証憑ファイル名", "事業割合(%)", "書類種別"]) {
    if (col(need) < 0) throw new KeiriError(`台帳に必要な列がありません: ${need}`);
  }
  const outReal = resolveSafe(cfg, cfg.outDir);
  const donePath = resolveSafe(cfg, path.join(cfg.outDir, FREEE_DONE_FILE));
  const done = new Set(readCsv(donePath).slice(1).map((r) => unq(r[0]).toLowerCase()).filter(Boolean));

  const exportRows: string[][] = [];
  const exportedFiles: string[] = [];
  const review: string[][] = [];
  let skippedDone = 0;
  for (const r of all.slice(1)) {
    const v = (name: string) => unq(r[col(name)]);
    const file = v("証憑ファイル名");
    const date = v("日付");
    if (range.from && date < range.from) continue;
    if (range.to && date > range.to) continue;
    if (file && done.has(file.toLowerCase())) { skippedDone++; continue; }
    if (v("書類種別") === "見積書") continue; // 支払いの記録ではない
    const reasons: string[] = [];
    const content = v("内容").normalize("NFKC");
    if (content.includes("8%")) reasons.push("内容に8%を含む(税率の混在を確認)");
    if (content.includes("対象外")) reasons.push("内容に対象外を含む(税区分の判断が要る)");
    if (v("インボイス有無") !== INVOICE_YES) reasons.push("インボイスが「あり」以外(税区分が別になることがある)");
    if (!isFullRatio(v("事業割合(%)"))) reasons.push("事業割合が100%以外");
    const amount = v("金額").replace(/,/g, "");
    if (!amount) reasons.push("金額が空");
    else if (!/^\d+$/.test(amount) || Number(amount) <= 0) reasons.push("金額が不正");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!date) reasons.push("日付が空");
    else if (!m) reasons.push("日付が不正");
    const account = v("科目");
    if (!account) reasons.push("科目が空");
    else if (accounts && !accounts.has(account)) reasons.push("科目が指定の科目リスト（accounts）にない");
    if (!file) reasons.push("証憑ファイル名が空(出力済みの記録ができない)");
    // 台帳では数式対策で先頭に ' を付けている。freee 用CSVに ' 付きで出すと名前に ' が混ざり、外すと数式になりうるので要確認へ回す
    for (const [label, val] of [["取引先", v("支払先")], ["勘定科目", account], ["備考", v("内容")]] as const) {
      if (/^[=+\-@]/.test(val)) reasons.push(`${label}が = + - @ で始まる(freee で名前を確認して手入力)`);
    }
    if (reasons.length) {
      review.push([file, date, v("支払先"), account, v("内容"), v("金額"), v("事業割合(%)"), v("インボイス有無"), reasons.join("、")]);
      continue;
    }
    exportRows.push(["支出", file, `${m![1]}/${m![2]}/${m![3]}`, v("支払先"), account, taxLabel, String(Number(amount)), v("内容").split(/\s+/).join(" ")]);
    exportedFiles.push(file);
  }

  const dir = resolveSafe(cfg, path.join(outReal, FREEE_DIR_NAME));
  const reviewPath = path.join(dir, FREEE_REVIEW_FILE);
  const common = {
    review_count: review.length,
    review: review.map((x) => ({ file: x[0], date: x[1], vendor: x[2], reason: x[8] })),
    already_exported: skippedDone,
    cautions: [
      "freee の取り込みは常に新規登録です。同じCSVを2回取り込むと取引が2件になります。",
      "一部の行が失敗したら、失敗した行だけのCSVにして取り込んでください。",
      "税区分・金額・科目は取り込み前のプレビューで利用者が確認してください。このツールもAIも税区分・税額を判断しません。",
      "決済の列は出していないため、未決済の取引として登録されます。決済は freee で利用者が行います。",
      "文字コードは UTF-8（BOM付き）だけです。freee で弾かれた場合は、Excel 等で開いて CSV（Shift_JIS）で保存し直してください。",
      `やり直すとき（1行も登録されていない場合）は、${FREEE_DONE_FILE} から該当の行を消してから出し直します。`,
    ],
  };
  // 要確認CSVは、出力する行の有無にかかわらず毎回書き直す（v0.4.1）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reviewPath, BOM + toLine(REVIEW_FIELDS) + review.map(toLine).join(""), "utf8");
  if (exportRows.length === 0) {
    return { exported: 0, file: undefined, review_file: displayPath(cfg, reviewPath), ...common, note: "出力する行はありません。取込用CSVは書いていません（freee_要確認.csv だけ書き直しました）。" };
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const importPath = path.join(dir, `freee_import_${stamp}.csv`);
  fs.writeFileSync(importPath, BOM + toLine(IMPORT_FIELDS) + exportRows.map(toLine).join(""), { encoding: "utf8", flag: "wx" });
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  appendRows(donePath, DONE_HEADER, exportedFiles.map((f) => [f, today, path.basename(importPath)]));
  return {
    exported: exportRows.length,
    file: displayPath(cfg, importPath),
    review_file: displayPath(cfg, reviewPath),
    done_file: displayPath(cfg, donePath),
    ...common,
    how_to_import: "freee で 取引入力 > 収入・支出形式 > その他の機能 > 取引データのインポート を開き、CSV（5MBまで）をアップロードしてプレビューで確認してから登録します（画面の名前は変わることがあります）。",
  };
}

