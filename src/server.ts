#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLearnMcpServer } from "./mcpServer.js";

const { server, browser } = createLearnMcpServer();

process.on("SIGINT", async () => {
  await browser.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await browser.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
