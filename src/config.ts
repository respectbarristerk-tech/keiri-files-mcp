// 起動設定: 許可フォルダ（1つ以上）と出力先。ツールはこの配下しか読まない・書かない。
import fs from "node:fs";
import path from "node:path";

export const OUT_DIR_NAME = "整理済み";
export const ENV_NAME = "KEIRI_ALLOWED_DIRS";

export interface Config {
  /** 実パス解決済みの許可フォルダ。先頭が主フォルダ */
  roots: string[];
  primary: string;
  outDir: string;
  ledgerPath: string;
  logPath: string;
}

/** 起動引数（--root を付けても付けなくても可）と環境変数 KEIRI_ALLOWED_DIRS（区切りは ; または :）から設定を作る */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      if (argv[i + 1]) raw.push(argv[++i]);
      continue;
    }
    if (a.startsWith("--")) continue;
    raw.push(a);
  }
  const fromEnv = env[ENV_NAME];
  if (fromEnv) raw.push(...fromEnv.split(path.delimiter));
  const cleaned = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) {
    throw new Error(`許可フォルダが指定されていません。起動引数か環境変数 ${ENV_NAME} で1つ以上指定してください。`);
  }
  const roots: string[] = [];
  for (const r of cleaned) {
    let real: string;
    try {
      real = fs.realpathSync.native(path.resolve(r));
    } catch {
      throw new Error(`許可フォルダが見つかりません: ${r}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`許可フォルダがフォルダではありません: ${r}`);
    if (!roots.includes(real)) roots.push(real);
  }
  const primary = roots[0];
  const outDir = path.join(primary, OUT_DIR_NAME);
  return {
    roots,
    primary,
    outDir,
    ledgerPath: path.join(outDir, "ledger.csv"),
    logPath: path.join(outDir, "log.csv"),
  };
}
