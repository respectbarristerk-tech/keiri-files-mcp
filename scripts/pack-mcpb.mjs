// .mcpb を作る（npm run pack）。事前に npm run build が必要。
// 一時フォルダに配布に必要なファイルだけをコピーし、本番用の依存だけを入れてから pack する。
// 開発用の依存（typescript・架空証憑づくりの pdfkit 等）と package.json の devDependencies は .mcpb に入らない。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (pkg.version !== manifest.version) {
  throw new Error(`package.json (${pkg.version}) と manifest.json (${manifest.version}) の version が違います`);
}
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  throw new Error("dist/index.js がありません。先に npm run build を実行してください");
}
const mcpbCli = path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
if (!fs.existsSync(mcpbCli)) {
  throw new Error("@anthropic-ai/mcpb がありません。先に npm ci を実行してください");
}

const out = path.join(root, `keiri-files-mcp-${pkg.version}.mcpb`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "keiri-files-mcp-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  for (const f of ["dist", "manifest.json", "README.md", "SKILL.md", "PRIVACY.md", "LICENSE", "package.json", "package-lock.json"]) {
    fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  }
  execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  // .mcpb 内の package.json は本番用だけにする
  const slim = { ...pkg };
  delete slim.devDependencies;
  delete slim.scripts;
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(slim, null, 2) + "\n");
  execFileSync(process.execPath, [mcpbCli, "validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
  execFileSync(process.execPath, [mcpbCli, "pack", stage, out], { stdio: "inherit" });
  console.log(`作成: ${path.basename(out)}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
