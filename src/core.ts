// ツール本体（MCPに依存しない純粋な処理。テストから直接呼べる）。
// 外部通信なし・削除なし・子プロセスなし。読み書きは許可フォルダ配下のみ。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { OUT_DIR_NAME } from "./config.js";
import { KeiriError, displayPath, isInside, resolveSafe } from "./pathguard.js";
import { appendRows, readCsv } from "./csv.js";
import { EXTS, avoidReserved, checkAmount, checkDate, checkDocType, checkInvoiceNo, sanitizePart } from "./validate.js";

export const SCAN_LIMIT = 500;
export const SEARCH_LIMIT = 200;
const MAX_NAME_LEN = 120;
const MAX_VENDOR_LEN = 40;

export const LEDGER_HEADER = [
  "日付", "支払先", "科目", "内容", "金額", "支払方法", "インボイス有無", "登録番号",
  "証憑ファイル名", "事業割合(%)", "書類種別", "元ファイル", "登録日時",
];
/**
 * 台帳Excel（「経費」シート A〜J 列: 日付〜事業割合）に値として貼れる表記（v0.3.1）
 * - インボイス: 「あり」「なし」（入力規則 あり/なし/確認中 に合わせる。v0.3.0 までの「有」「無」の行もそのまま読める）
 * - 事業割合: 「50%」の形（Excel で開くと 0.5・パーセント表示として認識される）。未指定は空欄
 */
export const INVOICE_YES = "あり";
export const INVOICE_NO = "なし";
export const invoiceFlag = (registrationNo: string | undefined): string => (registrationNo ? INVOICE_YES : INVOICE_NO);
export const formatRatio = (percent: number): string => `${percent}%`;
export const LOG_HEADER = ["実行日時", "モード", "元ファイル", "新ファイル", "結果", "plan_id"];

function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 出力フォルダの実パスを確認する（整理済み がリンクで外へ向いていたら拒否） */
function guardOutDir(cfg: Config, create: boolean): string {
  const real = resolveSafe(cfg, cfg.outDir);
  if (create) fs.mkdirSync(real, { recursive: true });
  return real;
}

interface LedgerIndex { rows: string[][]; files: Set<string>; originals: Set<string>; }
function loadLedger(cfg: Config): LedgerIndex {
  const ledger = resolveSafe(cfg, cfg.ledgerPath);
  const all = readCsv(ledger);
  const rows = all.length && all[0][0] === LEDGER_HEADER[0] ? all.slice(1) : all;
  const iFile = LEDGER_HEADER.indexOf("証憑ファイル名");
  const iOrig = LEDGER_HEADER.indexOf("元ファイル");
  return {
    rows,
    files: new Set(rows.map((r) => (r[iFile] ?? "").toLowerCase()).filter(Boolean)),
    originals: new Set(rows.map((r) => r[iOrig] ?? "").filter(Boolean)),
  };
}

// ---------- 重複の可能性（日付・取引先・金額が同じ） ----------
/** 取引先の比較用: 全角/半角の違い（NFKC）と前後の空白を無視。CSVの数式対策で付いた先頭の ' も外す */
export function vendorKey(v: unknown): string {
  return String(v ?? "").normalize("NFKC").replace(/^'(?=[=+\-@])/, "").trim();
}
export function dupKey(date: string, vendor: unknown, amount: number | string): string {
  return `${date}\u0000${vendorKey(vendor)}\u0000${Number(amount)}`;
}
/** 台帳の既存行のキー → その証憑ファイル名（最初の1件） */
function ledgerDupIndex(rows: string[][]): Map<string, string> {
  const iFile = LEDGER_HEADER.indexOf("証憑ファイル名");
  const m = new Map<string, string>();
  for (const r of rows) {
    const k = dupKey(r[0] ?? "", r[1] ?? "", r[4] ?? "");
    if (!m.has(k)) m.set(k, (r[iFile] ?? "").replace(/^'(?=[=+\-@])/, ""));
  }
  return m;
}
const DUP_NOTE = "日付・取引先・金額が同じです。同じ支払いの書類が2通ある（例: レシートと領収書、請求書と納品書）可能性があります。止めるかどうかは利用者に確認してください";

// ---------- 1. scan_folder ----------
export interface ScanItem { path: string; size: number; modified: string; registered: boolean; }
export function scanFolder(cfg: Config, args: { subdir?: string; recursive?: boolean }) {
  const base = resolveSafe(cfg, args.subdir);
  if (!fs.existsSync(base)) throw new KeiriError(`フォルダが見つかりません: ${args.subdir ?? ""}`);
  if (!fs.statSync(base).isDirectory()) throw new KeiriError(`フォルダではありません: ${args.subdir ?? ""}`);
  const recursive = args.recursive ?? true;
  const outReal = fs.existsSync(cfg.outDir) ? fs.realpathSync.native(cfg.outDir) : cfg.outDir;
  const scanningOut = isInside(base, outReal);
  const ledger = loadLedger(cfg);
  const items: ScanItem[] = [];
  let total = 0;
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // リンクはたどらない
      if (e.isDirectory()) {
        if (!recursive) continue;
        if (!scanningOut && full === outReal) continue; // 出力フォルダは対象外
        walk(full);
      } else if (e.isFile() && EXTS.includes(path.extname(e.name).toLowerCase())) {
        total++;
        if (items.length >= SCAN_LIMIT) continue;
        const st = fs.statSync(full);
        const rel = displayPath(cfg, full);
        items.push({
          path: rel,
          size: st.size,
          modified: st.mtime.toISOString(),
          registered: ledger.originals.has(rel) || ledger.files.has(e.name.toLowerCase()),
        });
      }
    }
  };
  walk(base);
  return {
    folder: displayPath(cfg, base) || ".",
    count: total,
    shown: items.length,
    truncated: total > items.length,
    note: total === 0 ? "対象ファイル（PDF/JPG/PNG/HEIC）はありませんでした。" : total > items.length ? `${SCAN_LIMIT}件で打ち切りました。subdir で絞ってください。` : undefined,
    files: items,
  };
}

// ---------- 2. propose_names ----------
export interface ProposeInput {
  path: string; date: unknown; vendor: unknown; amount: unknown; doc_type: unknown; invoice_no?: unknown;
}
interface PlanItem {
  source: string; sourceDisplay: string; size: number; mtimeMs: number; newName: string;
  date: string; vendor: string; amount: number; doc_type: string; invoice_no: string;
}
interface Plan { id: string; created: number; items: PlanItem[]; used: boolean; }
export class PlanStore {
  private plans = new Map<string, Plan>();
  add(items: PlanItem[]): string {
    const id = randomUUID().slice(0, 8);
    this.plans.set(id, { id, created: Date.now(), items, used: false });
    while (this.plans.size > 50) this.plans.delete(this.plans.keys().next().value as string);
    return id;
  }
  get(id: string) { return this.plans.get(id); }
}

function uniqueName(dir: string, name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const cand = n === 1 ? name : `${stem}_${n}${ext}`;
    if (!taken.has(cand.toLowerCase()) && !fs.existsSync(path.join(dir, cand))) {
      taken.add(cand.toLowerCase());
      return cand;
    }
  }
  throw new KeiriError(`同名ファイルが多すぎます: ${name}`);
}

export function buildName(date: string, vendor: string, amount: number, docType: string, ext: string): string {
  const fixed = `${date.replace(/-/g, "")}__${amount}_${docType}${ext}`;
  const room = Math.max(1, Math.min(MAX_VENDOR_LEN, MAX_NAME_LEN - 4 - [...fixed].length));
  const v = avoidReserved(sanitizePart(vendor, room));
  return `${date.replace(/-/g, "")}_${v}_${amount}_${docType}${ext}`;
}

export function proposeNames(cfg: Config, store: PlanStore, items: ProposeInput[]) {
  if (!Array.isArray(items) || items.length === 0) throw new KeiriError("items が空です。1件以上指定してください。");
  if (items.length > 500) throw new KeiriError("一度に扱えるのは500件までです。");
  const outDir = guardOutDir(cfg, false);
  const taken = new Set<string>();
  const seen = new Set<string>();
  const planItems: PlanItem[] = [];
  const proposals: Array<{ path: string; new_name: string; renamed_for_conflict: boolean }> = [];
  const errors: Array<{ index: number; path: string; errors: string[] }> = [];
  const warnings: Array<{ index: number; path: string; warning: string }> = [];
  const ledgerDup = ledgerDupIndex(loadLedger(cfg).rows);
  const reqDup = new Map<string, number>();
  items.forEach((it, index) => {
    const errs: string[] = [];
    let src = "";
    let st: fs.Stats | undefined;
    try {
      src = resolveSafe(cfg, String(it?.path ?? ""));
      if (!fs.existsSync(src)) errs.push("ファイルが見つかりません");
      else {
        st = fs.statSync(src);
        if (!st.isFile()) errs.push("ファイルではありません");
        else if (!EXTS.includes(path.extname(src).toLowerCase())) errs.push("対象外の拡張子です（PDF/JPG/PNG/HEICのみ）");
        else if (seen.has(src)) errs.push("同じファイルが2回指定されています");
        else seen.add(src);
      }
    } catch (e) {
      errs.push((e as Error).message);
    }
    const d = checkDate(it?.date);
    const a = checkAmount(it?.amount);
    const t = checkDocType(it?.doc_type);
    const inv = checkInvoiceNo(it?.invoice_no);
    for (const r of [d, a, t, inv]) if (r.error) errs.push(r.error);
    const vendorPart = sanitizePart(it?.vendor, MAX_VENDOR_LEN);
    if (!vendorPart) errs.push("取引先（vendor）が空、または使える文字がありません");
    if (errs.length || !st) {
      errors.push({ index, path: String(it?.path ?? ""), errors: errs });
      return;
    }
    const ext = path.extname(src).toLowerCase().replace(".jpeg", ".jpg");
    const ideal = buildName(d.value!, String(it.vendor), a.value!, t.value!, ext);
    const name = uniqueName(outDir, ideal, taken);
    planItems.push({
      source: src, sourceDisplay: displayPath(cfg, src), size: st.size, mtimeMs: st.mtimeMs, newName: name,
      date: d.value!, vendor: String(it.vendor).normalize("NFKC").trim(), amount: a.value!, doc_type: t.value!, invoice_no: inv.value ?? "",
    });
    proposals.push({ path: displayPath(cfg, src), new_name: name, renamed_for_conflict: name !== ideal });
    const k = dupKey(d.value!, it.vendor, a.value!);
    const shown = displayPath(cfg, src);
    if (reqDup.has(k)) warnings.push({ index, path: shown, warning: `重複の可能性: この依頼の ${reqDup.get(k)} 番目（0始まり）と${DUP_NOTE}` });
    else reqDup.set(k, index);
    if (ledgerDup.has(k)) warnings.push({ index, path: shown, warning: `重複の可能性: 台帳に登録済みの「${ledgerDup.get(k)}」と${DUP_NOTE}` });
  });
  const plan_id = planItems.length ? store.add(planItems) : null;
  return {
    plan_id,
    proposals,
    errors,
    warnings,
    note: plan_id
      ? "ファイルはまだ変更していません。命名案を利用者に見せて承認を得てから apply_renames を呼んでください。エラーの行は案に含まれません。"
      : "有効な案がありません。エラーを直して再度 propose_names を呼んでください。",
  };
}

// ---------- 3. apply_renames ----------
export function applyRenames(cfg: Config, store: PlanStore, args: { plan_id: string; mode?: "copy" | "rename" }) {
  const mode = args.mode ?? "copy";
  if (mode !== "copy" && mode !== "rename") throw new KeiriError("mode は copy か rename を指定してください。");
  const plan = store.get(String(args.plan_id ?? ""));
  if (!plan) throw new KeiriError("plan_id が見つかりません。propose_names からやり直してください（サーバー再起動でも消えます）。");
  if (plan.used) throw new KeiriError("この plan_id は実行済みです。もう一度行う場合は propose_names からやり直してください。");
  plan.used = true;
  const outDir = guardOutDir(cfg, true);
  const logPath = resolveSafe(cfg, cfg.logPath);
  const taken = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  const logRows: Array<Array<string>> = [];
  const ts = now();
  for (const it of plan.items) {
    let status = "ok";
    let newPath = "";
    try {
      const src = resolveSafe(cfg, it.source);
      if (!fs.existsSync(src)) throw new KeiriError("元ファイルが見つかりません（提案後に移動・変更された可能性）");
      const st = fs.statSync(src);
      if (st.size !== it.size || st.mtimeMs !== it.mtimeMs) throw new KeiriError("提案後に元ファイルが変更されたため実行しませんでした");
      const dir = mode === "copy" ? outDir : resolveSafe(cfg, path.dirname(src));
      if (mode === "rename" && path.basename(src) === it.newName) {
        status = "skip: すでにこの名前です";
        newPath = src;
      } else {
        const name = uniqueName(dir, it.newName, taken);
        const dst = path.join(dir, name);
        if (mode === "copy") fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        else {
          if (fs.existsSync(dst)) throw new KeiriError("同名ファイルがあるため上書きしませんでした");
          fs.renameSync(src, dst);
        }
        newPath = dst;
      }
    } catch (e) {
      status = "error: " + (e as Error).message;
    }
    const newName = newPath ? path.basename(newPath) : "";
    results.push({
      source: it.sourceDisplay,
      new_file: newPath ? displayPath(cfg, newPath) : "",
      status,
      ledger_entry: newPath
        ? { date: it.date, vendor: it.vendor, amount: it.amount, doc_type: it.doc_type, invoice_no: it.invoice_no, file_name: newName, source_file: it.sourceDisplay }
        : undefined,
    });
    logRows.push([ts, mode, it.sourceDisplay, newPath ? displayPath(cfg, newPath) : "", status, plan.id]);
  }
  appendRows(logPath, LOG_HEADER, logRows);
  const ok = results.filter((r) => r.status === "ok").length;
  return {
    mode,
    done: ok,
    failed: results.length - ok,
    log: displayPath(cfg, logPath),
    results,
    note: "台帳に載せる場合は各 ledger_entry を確認し（科目・支払方法などは利用者に確認）、ledger_append に渡してください。",
  };
}

// ---------- 4. ledger_append ----------
export interface LedgerInput {
  date: unknown; vendor: unknown; amount: unknown; doc_type: unknown; file_name: unknown;
  account?: unknown; description?: unknown; payment_method?: unknown; invoice_no?: unknown;
  business_ratio?: unknown; source_file?: unknown;
}
const text = (v: unknown, max = 200) => String(v ?? "").normalize("NFKC").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** 証憑ファイルが実在するか: 整理済み にある、または log.csv に そのファイル名への copy/rename の記録があり記録先に実在する */
function evidenceExists(cfg: Config, outReal: string, file: string, logRows: string[][]): boolean {
  const inOut = path.join(outReal, file);
  if (fs.existsSync(inOut) && fs.statSync(inOut).isFile()) return true;
  const key = file.toLowerCase();
  for (const r of logRows) {
    const dst = (r[3] ?? "").replace(/^'(?=[=+\-@])/, ""); // CSV の数式対策で付いた先頭の ' を外す
    if (!dst || !/^(ok|skip)/.test(r[4] ?? "")) continue;
    if (path.basename(dst.replace(/\\/g, "/")).toLowerCase() !== key) continue;
    try {
      const real = resolveSafe(cfg, dst);
      if (fs.existsSync(real) && fs.statSync(real).isFile()) return true;
    } catch {
      /* 許可フォルダ外の記録は認めない */
    }
  }
  return false;
}

export function ledgerAppend(cfg: Config, entries: LedgerInput[], opts: { include_quotes?: boolean } = {}) {
  const includeQuotes = opts.include_quotes === true;
  if (!Array.isArray(entries) || entries.length === 0) throw new KeiriError("entries が空です。1件以上指定してください。");
  if (entries.length > 500) throw new KeiriError("一度に追記できるのは500件までです。");
  const outReal = guardOutDir(cfg, true);
  const ledgerPath = resolveSafe(cfg, cfg.ledgerPath);
  const idx = loadLedger(cfg);
  const logAll = readCsv(resolveSafe(cfg, cfg.logPath));
  const logRows = logAll.length && logAll[0][0] === LOG_HEADER[0] ? logAll.slice(1) : logAll;
  const rows: string[][] = [];
  const errors: Array<{ index: number; file_name: string; errors: string[] }> = [];
  const warnings: Array<{ index: number; file_name: string; warning: string }> = [];
  const ts = now();
  const ledgerDup = ledgerDupIndex(idx.rows);
  const reqDup = new Map<string, string>();
  entries.forEach((e, index) => {
    const errs: string[] = [];
    const d = checkDate(e?.date);
    const a = checkAmount(e?.amount);
    const t = checkDocType(e?.doc_type);
    const inv = checkInvoiceNo(e?.invoice_no);
    for (const r of [d, a, t, inv]) if (r.error) errs.push(r.error);
    const vendor = text(e?.vendor, 100);
    if (!vendor) errs.push("支払先（vendor）が空です");
    const file = text(e?.file_name, 255);
    if (!file) errs.push("証憑ファイル名（file_name）が空です");
    else if (/[\\/]/.test(file) || file === "." || file === "..") errs.push("証憑ファイル名にはフォルダを含めず、ファイル名だけを指定してください");
    let ratio = "";
    if (e?.business_ratio !== undefined && e?.business_ratio !== null && String(e.business_ratio).trim() !== "") {
      const r = checkAmount(String(e.business_ratio).replace(/[%％]/g, ""), "事業割合");
      if (r.error || r.value! > 100) errs.push("事業割合は0〜100の整数で指定してください");
      else ratio = formatRatio(r.value!);
    }
    if (errs.length) {
      errors.push({ index, file_name: file, errors: errs });
      return;
    }
    if (t.value === "見積書" && !includeQuotes) {
      warnings.push({ index, file_name: file, warning: "見積書は支払いの記録ではないため追記しませんでした（台帳に入れる場合は利用者に確認のうえ include_quotes: true を指定）" });
      return;
    }
    const key = file.toLowerCase();
    if (!evidenceExists(cfg, outReal, file, logRows)) {
      warnings.push({ index, file_name: file, warning: `証憑ファイル「${file}」が ${OUT_DIR_NAME} フォルダにも実行ログ（rename/copy の記録先）にも見つからないため追記しませんでした（apply_renames の結果のファイル名を指定してください）` });
      return;
    }
    if (idx.files.has(key)) {
      warnings.push({ index, file_name: file, warning: "同じ証憑ファイル名が台帳に登録済みのため追記しませんでした（二重登録の防止）" });
      return;
    }
    idx.files.add(key);
    if (t.value === "納品書") warnings.push({ index, file_name: file, warning: "注意: 納品書は同じ取引の請求書・領収書と二重計上になる可能性があります（追記はしました。不要なら利用者が台帳から外してください）" });
    const k = dupKey(d.value!, vendor, a.value!);
    if (reqDup.has(k)) warnings.push({ index, file_name: file, warning: `重複の可能性: この依頼で追記した「${reqDup.get(k)}」と${DUP_NOTE}（追記はしました）` });
    else reqDup.set(k, file);
    if (ledgerDup.has(k)) warnings.push({ index, file_name: file, warning: `重複の可能性: 台帳に登録済みの「${ledgerDup.get(k)}」と${DUP_NOTE}（追記はしました）` });
    rows.push([
      d.value!, vendor, text(e.account, 50), text(e.description), String(a.value!), text(e.payment_method, 50),
      invoiceFlag(inv.value), inv.value ?? "", file, ratio, t.value!, text(e.source_file, 255), ts,
    ]);
  });
  if (rows.length) appendRows(ledgerPath, LEDGER_HEADER, rows);
  return {
    appended: rows.length,
    ledger: displayPath(cfg, ledgerPath),
    warnings,
    errors,
    note: "科目・経費になるかの判断はしていません。内容の確認は利用者が行ってください。",
  };
}

// ---------- 5. search_ledger ----------
export function searchLedger(cfg: Config, f: { date_from?: string; date_to?: string; amount_min?: unknown; amount_max?: unknown; vendor?: string }) {
  const errs: string[] = [];
  const df = f.date_from ? checkDate(f.date_from, "date_from") : {};
  const dt = f.date_to ? checkDate(f.date_to, "date_to") : {};
  const amin = f.amount_min !== undefined && f.amount_min !== null && f.amount_min !== "" ? checkAmount(f.amount_min, "amount_min") : {};
  const amax = f.amount_max !== undefined && f.amount_max !== null && f.amount_max !== "" ? checkAmount(f.amount_max, "amount_max") : {};
  for (const r of [df, dt, amin, amax] as Array<{ error?: string }>) if (r.error) errs.push(r.error);
  if (errs.length) throw new KeiriError(errs.join(" / "));
  const from = (df as { value?: string }).value;
  const to = (dt as { value?: string }).value;
  const min = (amin as { value?: number }).value;
  const max = (amax as { value?: number }).value;
  if (from && to && from > to) throw new KeiriError("date_from が date_to より後になっています。");
  if (min !== undefined && max !== undefined && min > max) throw new KeiriError("amount_min が amount_max より大きくなっています。");
  const ledgerPath = resolveSafe(cfg, cfg.ledgerPath);
  if (!fs.existsSync(ledgerPath)) return { count: 0, rows: [], note: `台帳がまだありません（${OUT_DIR_NAME}/ledger.csv）。` };
  const { rows } = loadLedger(cfg);
  const v = (f.vendor ?? "").normalize("NFKC").trim().toLowerCase();
  const hit = rows.filter((r) => {
    const date = r[0] ?? "";
    const amt = Number(r[4]);
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (min !== undefined && !(amt >= min)) return false;
    if (max !== undefined && !(amt <= max)) return false;
    if (v && !(r[1] ?? "").normalize("NFKC").toLowerCase().includes(v)) return false;
    return true;
  });
  const out = hit.slice(0, SEARCH_LIMIT).map((r) => Object.fromEntries(LEDGER_HEADER.map((h, i) => [h, r[i] ?? ""])));
  return {
    count: hit.length,
    total_amount: hit.reduce((s, r) => s + (Number(r[4]) || 0), 0),
    shown: out.length,
    truncated: hit.length > out.length,
    rows: out,
  };
}
