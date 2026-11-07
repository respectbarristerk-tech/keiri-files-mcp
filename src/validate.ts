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
