#!/usr/bin/env node
// imagegen-mcp — 把 chatgpt2api 的生图能力暴露给 DSH。
//
// stdio 传输，由 DSH 拉起。stdout 只能有 JSON-RPC，日志一律走 stderr。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BASE_URL, OUTPUT_ROOT, PKG_VERSION } from "./config.mjs";
import { registerTools } from "./tools.mjs";

const server = new McpServer({ name: "imagegen-mcp", version: PKG_VERSION }, { capabilities: { tools: {} } });

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`imagegen-mcp ${PKG_VERSION} ready | upstream=${BASE_URL} | output=${OUTPUT_ROOT}\n`);
}

main().catch((error) => {
  process.stderr.write(`imagegen-mcp fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
