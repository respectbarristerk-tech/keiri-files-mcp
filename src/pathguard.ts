// パスの安全確認: 実パス解決後に許可フォルダ配下かを判定する（../ やシンボリックリンクでの脱出を拒否）。
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export class KeiriError extends Error {}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}

/** 存在しない部分があっても、存在する一番近い親までを実パスにして残りをつなぐ */
export function realpathLoose(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 利用者・AIが渡したパス（主フォルダからの相対 or 絶対）を、許可フォルダ配下の実パスに解決する。外なら例外 */
export function resolveSafe(cfg: Config, p: string | undefined): string {
  const input = (p ?? "").trim();
  const abs = input === "" ? cfg.primary : path.isAbsolute(input) ? path.resolve(input) : path.resolve(cfg.primary, input);
  if (!cfg.roots.some((r) => isInside(abs, r))) {
    throw new KeiriError(`許可フォルダの外は扱えません: ${input}`);
  }
  const real = realpathLoose(abs);
  if (!cfg.roots.some((r) => isInside(real, r))) {
    throw new KeiriError(`リンク先が許可フォルダの外のため扱えません: ${input}`);
  }
  return real;
}

/** 表示用パス: 主フォルダ配下は / 区切りの相対パス、それ以外は絶対パス */
export function displayPath(cfg: Config, abs: string): string {
  if (isInside(abs, cfg.primary)) return path.relative(cfg.primary, abs).split(path.sep).join("/");
  return abs;
}
