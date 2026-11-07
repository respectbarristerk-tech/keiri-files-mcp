#!/usr/bin/env node
// 起動: node dist/index.js <許可フォルダ> [<許可フォルダ2> ...]
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  let cfg;
  try {
    cfg = loadConfig(process.argv.slice(2));
  } catch (e) {
    console.error("[keiri-files-mcp] " + (e as Error).message);
    process.exit(1);
  }
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(`[keiri-files-mcp] 起動しました（許可フォルダ ${cfg.roots.length} 件）`);
}
main();
