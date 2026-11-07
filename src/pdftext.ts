// PDF の埋め込みテキストを取り出す（依存なしの簡易版。node:zlib のみ使用）。
// 対応: FlateDecode／無圧縮のコンテンツストリーム、オブジェクトストリーム、ToUnicode CMap（bfchar/bfrange）、
//       Tj/TJ/'/" 演算子。暗号化PDF・画像だけのPDF（スキャン）・特殊なエンコーディングは取り出せない（空を返す）。
import zlib from "node:zlib";

interface PdfObj { dict: string; stream?: Buffer; }
type CMap = { map: Map<string, string>; bytes: number };
/** フォントごとの文字コードの読み方。cmap があればそれ、2バイトの UCS2 系エンコーディングなら UTF-16BE、2バイトで不明なら読まない */
type FontInfo = { cmap?: CMap; ucs2?: boolean; unknown2byte?: boolean };

// 展開後の大きさに上限を設ける（圧縮爆弾でメモリを使い切らないように）
function inflate(buf: Buffer): Buffer | undefined {
  try {
    return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    try {
      return zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  }
}

function ascii85(buf: Buffer): Buffer {
  const s = buf.toString("latin1").replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let group: number[] = [];
  const flush = (g: number[], n: number) => {
    let v = 0;
    for (const c of g) v = v * 85 + c;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n));
  };
  for (const ch of s) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) { flush(group, 4); group = []; }
  }
  if (group.length) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(group, n);
  }
  return Buffer.from(out);
}

function asciiHex(buf: Buffer): Buffer {
  let h = buf.toString("latin1").replace(/>[\s\S]*$/, "").replace(/[^0-9A-Fa-f]/g, "");
  if (h.length % 2) h += "0";
  return Buffer.from(h, "hex");
}

/** ストリームを復号する。FlateDecode・ASCII85Decode・ASCIIHexDecode と無圧縮だけ。それ以外は undefined */
function decodeStream(dict: string, raw: Buffer): Buffer | undefined {
  const f = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!f) return raw;
  const filters = f[1].match(/\/[A-Za-z0-9]+/g) ?? [];
  let out: Buffer | undefined = raw;
  for (const name of filters) {
    if (!out) return undefined;
    if (name === "/FlateDecode" || name === "/Fl") out = inflate(out);
    else if (name === "/ASCII85Decode" || name === "/A85") out = ascii85(out);
    else if (name === "/ASCIIHexDecode" || name === "/AHx") out = asciiHex(out);
    else return undefined;
  }
  return out;
}

function parseObjects(buf: Buffer): Map<number, PdfObj> {
  const s = buf.toString("latin1");
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const sIdx = s.indexOf("stream", start);
    const eIdx = s.indexOf("endobj", start);
    if (eIdx < 0) break;
    let dict: string;
    let stream: Buffer | undefined;
    if (sIdx >= 0 && sIdx < eIdx && s.slice(sIdx - 3, sIdx) !== "end") {
      dict = s.slice(start, sIdx);
      let dataStart = sIdx + 6;
      if (s[dataStart] === "\r") dataStart++;
      if (s[dataStart] === "\n") dataStart++;
      // /Length が直接の数値で、その位置に endstream があればそれを使う。なければ endstream を探す
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = -1;
      if (len) {
        const e = dataStart + Number(len[1]);
        if (/^\s*endstream/.test(s.slice(e, e + 20))) dataEnd = e;
      }
      if (dataEnd < 0) {
        dataEnd = s.indexOf("endstream", dataStart);
        if (dataEnd < 0) dataEnd = eIdx;
        if (s[dataEnd - 1] === "\n") dataEnd--;
        if (s[dataEnd - 1] === "\r") dataEnd--;
      }
      stream = buf.subarray(dataStart, dataEnd);
      const realEnd = s.indexOf("endobj", s.indexOf("endstream", dataStart));
      re.lastIndex = realEnd > 0 ? realEnd : eIdx;
    } else {
      dict = s.slice(start, eIdx);
      re.lastIndex = eIdx;
    }
    objs.set(Number(m[1]), { dict, stream });
  }
  // オブジェクトストリーム（PDF 1.5 以降）の中身を展開
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(o.dict) || !o.stream) continue;
    const data = decodeStream(o.dict, o.stream);
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    if (!data || !n) continue;
    const t = data.toString("latin1");
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && 2 * i + 1 < nums.length; i++) {
      const num = nums[2 * i];
      const off = first + nums[2 * i + 1];
      const end = i + 1 < n && 2 * i + 3 < nums.length ? first + nums[2 * i + 3] : t.length;
      if (!objs.has(num)) objs.set(num, { dict: t.slice(off, end) });
    }
  }
  return objs;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : undefined;
};

function utf16be(hex: string): string {
  let out = "";
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

function parseCMap(text: string): CMap {
  const map = new Map<string, string>();
  let bytes = 0;
  const cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(text);
  if (cs) bytes = cs[1].length / 2;
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(p[1].toUpperCase(), utf16be(p[2]));
      bytes ||= p[1].length / 2;
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16), w = p[1].length;
      bytes ||= w / 2;
      if (hi - lo > 65535) continue;
      if (p[3].startsWith("[")) {
        const arr = [...p[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => x[1]);
        arr.forEach((h, k) => map.set((lo + k).toString(16).toUpperCase().padStart(w, "0"), utf16be(h)));
      } else {
        const base = p[3].slice(1, -1);
        const head = base.slice(0, -4), last = parseInt(base.slice(-4) || "0", 16);
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).toUpperCase().padStart(w, "0"), utf16be(head + (last + c - lo).toString(16).padStart(4, "0")));
      }
    }
  }
  return { map, bytes: bytes || 1 };
}

// ---- コンテンツストリームの字句解析 ----
type Tok = { t: "str"; v: Buffer } | { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string } | { t: "arr"; v: Tok[] };

function tokenize(b: Buffer): Tok[] {
  const stack: Tok[][] = [[]];
  const push = (x: Tok) => stack[stack.length - 1].push(x);
  const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  const isDelim = (c: number) => "()<>[]{}/%".includes(String.fromCharCode(c));
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (isWs(c)) { i++; continue; }
    if (c === 0x25) { while (i < b.length && b[i] !== 0x0a && b[i] !== 0x0d) i++; continue; } // %
    if (c === 0x28) { // ( literal string
      const out: number[] = [];
      let depth = 1; i++;
      while (i < b.length && depth > 0) {
        const d = b[i];
        if (d === 0x5c) { // backslash
          const e = b[i + 1];
          const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
          if (e !== undefined && map[e] !== undefined) { out.push(map[e]); i += 2; }
          else if (e !== undefined && e >= 0x30 && e <= 0x37) {
            let j = i + 1, oct = "";
            while (j < b.length && oct.length < 3 && b[j] >= 0x30 && b[j] <= 0x37) oct += String.fromCharCode(b[j++]);
            out.push(parseInt(oct, 8) & 0xff); i = j;
          } else if (e === 0x0d || e === 0x0a) { i += 2; if (e === 0x0d && b[i] === 0x0a) i++; }
          else i += 2;
          continue;
        }
        if (d === 0x28) depth++;
        if (d === 0x29 && --depth === 0) { i++; break; }
        out.push(d); i++;
      }
      push({ t: "str", v: Buffer.from(out) });
      continue;
    }
    if (c === 0x3c && b[i + 1] === 0x3c) { i += 2; continue; } // << 辞書は読み飛ばし（中身はトークンとして流れる）
    if (c === 0x3e && b[i + 1] === 0x3e) { i += 2; continue; }
    if (c === 0x3c) { // <hex>
      let j = i + 1, hex = "";
      while (j < b.length && b[j] !== 0x3e) { const ch = String.fromCharCode(b[j++]); if (/[0-9A-Fa-f]/.test(ch)) hex += ch; }
      if (hex.length % 2) hex += "0";
      push({ t: "str", v: Buffer.from(hex, "hex") });
      i = j + 1;
      continue;
    }
    if (c === 0x5b) { stack.push([]); i++; continue; }
    if (c === 0x5d) { const a = stack.length > 1 ? stack.pop()! : []; push({ t: "arr", v: a }); i++; continue; }
    if (c === 0x2f) { // /name
      let j = i + 1;
      while (j < b.length && !isWs(b[j]) && !isDelim(b[j])) j++;
      push({ t: "name", v: b.toString("latin1", i + 1, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < b.length && !isWs(b[j]) && !isDelim(b[j])) j++;
    if (j === i) { i++; continue; }
    const word = b.toString("latin1", i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ t: "num", v: Number(word) });
    else if (word === "BI") { // インライン画像は EI まで読み飛ばす
      const k = b.indexOf("EI", i, "latin1");
      i = k < 0 ? b.length : k + 2;
    } else push({ t: "op", v: word });
  }
  return stack[0];
}

function decodeString(bytes: Buffer, fi: FontInfo | undefined): string {
  const cmap = fi?.cmap;
  if (!cmap) {
    if (fi?.ucs2) return bytes.length % 2 === 0 ? Buffer.from(bytes).swap16().toString("utf16le") : "";
    if (fi?.unknown2byte) return "";
    return bytes.toString("latin1");
  }
  let out = "";
  const w = cmap.bytes;
  for (let i = 0; i < bytes.length; i += w) {
    const key = bytes.subarray(i, i + w).toString("hex").toUpperCase();
    const v = cmap.map.get(key);
    if (v !== undefined) out += v;
    else if (w === 1) out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function textOf(content: Buffer, fonts: Map<string, FontInfo | undefined>): string {
  const toks = tokenize(content);
  let out = "";
  let font: FontInfo | undefined;
  let lastY: number | undefined;
  let size = 10; // 直前の Tf のフォントサイズ（行が変わったかの判定に使う）
  const ops: Tok[] = [];
  const nl = () => { if (out && !out.endsWith("\n")) out += "\n"; };
  for (const tk of toks) {
    if (tk.t !== "op") { ops.push(tk); continue; }
    const args = ops.splice(0);
    switch (tk.v) {
      case "Tf": {
        const n = args.find((a) => a.t === "name");
        font = n ? fonts.get(n.v as string) : undefined;
        const sz = args.filter((a) => a.t === "num").pop();
        if (sz && Math.abs(sz.v as number) > 0) size = Math.abs(sz.v as number);
        break;
      }
      case "Tj": case "'": case '"': {
        if (tk.v !== "Tj") nl();
        const s = args.filter((a) => a.t === "str").pop();
        if (s) out += decodeString(s.v as Buffer, font);
        break;
      }
      case "TJ": {
        const arr = args.find((a) => a.t === "arr");
        if (arr) for (const a of arr.v as Tok[]) {
          if (a.t === "str") out += decodeString(a.v, font);
          else if (a.t === "num" && a.v < -250 && !out.endsWith(" ")) out += " ";
        }
        break;
      }
      case "Td": case "TD": {
        const nums = args.filter((a) => a.t === "num").map((a) => a.v as number);
        if (nums.length >= 2 && Math.abs(nums[1]) > 0.01) nl();
        else if (nums.length >= 1 && nums[0] > 0 && out && !/\s$/.test(out)) out += " ";
        break;
      }
      case "Tm": {
        const nums = args.filter((a) => a.t === "num").map((a) => a.v as number);
        if (nums.length >= 6) {
          // 同じ行で書体が切り替わると基準線が少しずれるため、文字の高さの半分を超えたら改行とみなす
          if (lastY !== undefined && Math.abs(nums[5] - lastY) > 0.5 * size * (Math.abs(nums[3]) || 1)) nl();
          lastY = nums[5];
        }
        break;
      }
      case "T*": nl(); break;
      default: break;
    }
  }
  return out;
}

/** PDF のバイト列から埋め込みテキストを取り出す。取り出せなければ空文字 */
export function extractPdfText(buf: Buffer, maxChars = 50000): string {
  if (!buf.subarray(0, 1024).toString("latin1").includes("%PDF")) return "";
  const s = buf.toString("latin1");
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s) || /\/Encrypt\s*<</.test(s)) return "";
  const objs = parseObjects(buf);
  // フォント名 → ToUnicode CMap
  const cmapCache = new Map<number, FontInfo | undefined>();
  const cmapOfFont = (fontObj: number): FontInfo | undefined => {
    if (cmapCache.has(fontObj)) return cmapCache.get(fontObj);
    let cm: CMap | undefined;
    const fo = objs.get(fontObj);
    const type0 = !!fo && /\/Subtype\s*\/Type0\b/.test(fo.dict);
    const enc = fo ? /\/Encoding\s*\/([^\s/<>\[\]()]+)/.exec(fo.dict)?.[1] ?? "" : "";
    const tu = fo ? ref(fo.dict, "ToUnicode") : undefined;
    const st = tu !== undefined ? objs.get(tu) : undefined;
    if (st?.stream) {
      const d = decodeStream(st.dict, st.stream);
      if (d) cm = parseCMap(d.toString("latin1"));
    }
    const info: FontInfo = cm ? { cmap: cm } : type0 && /UCS2|UTF16/i.test(enc) ? { ucs2: true } : type0 ? { unknown2byte: true } : {};
    cmapCache.set(fontObj, info);
    return info;
  };
  const fonts = new Map<string, FontInfo | undefined>();
  const addFontDict = (body: string) => {
    for (const p of body.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) if (!fonts.has(p[1])) fonts.set(p[1], cmapOfFont(Number(p[2])));
  };
  for (const o of objs.values()) {
    for (const m of o.dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) addFontDict(m[1]);
    for (const m of o.dict.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) { const fd = objs.get(Number(m[1])); if (fd) addFontDict(fd.dict); }
  }
  // ページ順にコンテンツを並べる（ページツリーが読めなければ BT を含むストリームを順に）
  const pages: number[] = [];
  const rootPages = [...objs.entries()].find(([, o]) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\s/.test(o.dict));
  const walk = (n: number, depth: number) => {
    const o = objs.get(n);
    if (!o || depth > 50 || pages.length > 2000) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? "";
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);
  };
  if (rootPages) walk(rootPages[0], 0);
  const contentIds: number[] = [];
  for (const p of pages) {
    const d = objs.get(p)!.dict;
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(d);
    if (arr) for (const k of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentIds.push(Number(k[1]));
    else { const r = ref(d, "Contents"); if (r !== undefined) contentIds.push(r); }
  }
  const streams = contentIds.length
    ? contentIds.map((id) => objs.get(id)).filter((o): o is PdfObj => !!o?.stream)
    : [...objs.values()].filter((o) => o.stream && !/\/Type\s*\/(XObject|ObjStm|XRef)\b/.test(o.dict) && !/\/Subtype\s*\/Image\b/.test(o.dict));
  let text = "";
  for (const o of streams) {
    const d = decodeStream(o.dict, o.stream!);
    if (!d || !/\bBT\b/.test(d.toString("latin1"))) continue;
    text += textOf(d, fonts) + "\n";
    if (text.length > maxChars) break;
  }
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f�]/g, "")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
    .slice(0, maxChars);
}
