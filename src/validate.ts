// 入力の形式チェックとファイル名用の整形。
export const DOC_TYPES = ["領収書", "請求書", "見積書", "納品書", "その他"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const EXTS = [".pdf", ".jpg", ".jpeg", ".png", ".heic"];

const nfkc = (v: unknown) => String(v ?? "").normalize("NFKC").trim();

export function checkDate(v: unknown, label = "日付"): { value?: string; error?: string } {
  const s = nfkc(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { error: `${label}は YYYY-MM-DD 形式で指定してください（受け取った値: ${s || "空"}）` };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { error: `${label}が存在しない日付です: ${s}` };
  }
  return { value: s };
}

export function checkAmount(v: unknown, label = "金額"): { value?: number; error?: string } {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v > 1e12) return { error: `${label}は0以上の整数（円）で指定してください（受け取った値: ${v}）` };
    return { value: v };
  }
  const s = nfkc(v).replace(/[,，\s円¥￥]/g, "");
  if (!/^\d+$/.test(s) || Number(s) > 1e12) {
    return { error: `${label}は0以上の整数（円）で指定してください（受け取った値: ${nfkc(v) || "空"}）` };
  }
  return { value: Number(s) };
}

/** 適格請求書発行事業者の登録番号: T + 13桁（形式のみ確認。実在確認はしない） */
export function checkInvoiceNo(v: unknown): { value?: string; error?: string } {
  const s = nfkc(v).replace(/[\s-]/g, "").toUpperCase();
  if (s === "") return { value: "" };
  if (!/^T\d{13}$/.test(s)) return { error: `登録番号は T＋13桁の数字で指定してください（受け取った値: ${nfkc(v)}）` };
  return { value: s };
}

export function checkDocType(v: unknown): { value?: DocType; error?: string } {
  const s = nfkc(v);
  if ((DOC_TYPES as readonly string[]).includes(s)) return { value: s as DocType };
  return { error: `書類種別は ${DOC_TYPES.join("・")} のどれかにしてください（受け取った値: ${s || "空"}）` };
}

/** ファイル名の一部に使えるよう整える（使えない文字・区切りの _・空白を - に置換） */
export function sanitizePart(v: unknown, maxLen: number): string {
  let s = nfkc(v)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
  if ([...s].length > maxLen) s = [...s].slice(0, maxLen).join("").replace(/[-.\s]+$/g, "");
  return s;
}

/** Windows の予約名（CON, PRN, AUX, NUL, COM1〜9, LPT1〜9。大小文字・拡張子付きも）なら先頭に _ を付ける */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
export function avoidReserved(part: string): string {
  return RESERVED.test(part.trim()) ? "_" + part : part;
}

// ---------- カード番号らしきもの（v0.4.1 で validate.ts へ移し、表記ゆれを追加） ----------
// 台帳・確認待ち・質問ファイル・回答に書かない。金額・日付・電話番号・登録番号（T+13桁）は誤検出しない。
const CARD_SEP = "[\\s\\-./]";
const CARD_DIGITS = new RegExp(`(?<!\\d)\\d{4}${CARD_SEP}?\\d{4}${CARD_SEP}?\\d{4}${CARD_SEP}?\\d{2,4}`, "g");
const CARD_PATTERNS = [
  /[*xX×●•]{3,}[\s\-./]?\d{3,4}/, // ****1234・xxxx-1234
  /(下|末尾|最後の?)\s*(4|四)\s*(桁|ケタ|けた)/, // 下4桁・下四桁・末尾4桁
  /(末尾|最後)[はがの:\s]*\d{4}(?![\d円,.\-/年月日])/, // 末尾1234・最後は1234
  /カード\s*(番号|No\.?|#)[^\d]{0,12}\d{4}(?![\d円,.\-/年月日])/i, // カード番号の最後は1234
  /card\s*(ending|no\.?|number|#)(\s*in)?[\s:#.]*\d{4}(?!\d)/i, // card ending 1234
  /last\s*(4|four)\s*digits?/i,
];
/** 区切りのない数字の先頭8桁が YYYYMMDD の日付なら、撮影日時などの連番とみなす（19xx/20xx で始まるカード番号はない） */
function isDateStamp(m: string): boolean {
  if (!/^\d+$/.test(m)) return false;
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(4, 6)), d = Number(m.slice(6, 8));
  if (y < 1900 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
export function looksLikeCardNumber(s: string): boolean {
  const t = String(s ?? "").normalize("NFKC");
  for (const m of t.matchAll(CARD_DIGITS)) if (!isDateStamp(m[0])) return true;
  return CARD_PATTERNS.some((re) => re.test(t));
}
