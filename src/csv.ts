// 最小のCSV読み書き（UTF-8 BOM付き、CRLF、Excelで開ける形）。
import fs from "node:fs";

export const BOM = "﻿";

/** Excelの数式として解釈されないようにし、改行は空白にする */
export function cell(v: string | number | undefined | null): string {
  let s = v === undefined || v === null ? "" : String(v);
  s = s.replace(/[\r\n]+/g, " ");
  if (typeof v === "string" && /^[=+\-@\t]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toLine(fields: Array<string | number | undefined | null>): string {
  return fields.map(cell).join(",") + "\r\n";
}

export function parseCsv(text: string): string[][] {
  if (text.startsWith(BOM)) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function readCsv(file: string): string[][] {
  if (!fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, "utf8"));
}

/** ヘッダー付きCSVに行を追記する。ファイルが無ければBOMとヘッダーを書く */
export function appendRows(file: string, header: string[], rows: Array<Array<string | number | undefined | null>>): void {
  let prefix = "";
  if (!fs.existsSync(file)) prefix = BOM + toLine(header);
  else {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.length > 0 && !cur.endsWith("\n")) prefix = "\r\n";
  }
  fs.appendFileSync(file, prefix + rows.map(toLine).join(""), "utf8");
}
