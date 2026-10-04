// packages/engine/src/commands/mcp.ts
//
// L4 (lifecycle pass) — `spec mcp [platformDir]`: serve the engine's read
// surface as a Model Context Protocol server over stdio. Register it in an
// agent harness (e.g. Claude Code `.mcp.json`) and the agent routes
// through Spec Engine natively — query/resolve/reverse/report/check/propagation/
// next-id — instead of shelling out to the CLI.
//
// STDOUT IS THE PROTOCOL CHANNEL. Every human-facing line (startup notice,
// errors) goes to stderr; writing chrome to stdout would corrupt the
// JSON-RPC stream.
//
// The process serves until stdin closes (the harness disconnecting), which
// is the normal MCP lifecycle — no port, no daemon, loopback-free.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import { assertSpecPlatform, platformName } from "../indexer/discover";
import { buildMcpServer } from "../server/mcp";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { handleNotAPlatform } from "./_shared";

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Serve Spec Engine as an MCP (Model Context Protocol) server over stdio — agent-native query/resolve/check/report tools.",
  },
  args: {
    platformDir: platformDirArg,
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);

    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const server = buildMcpServer(platformDir);
    console.error(`spec mcp: serving ${platformName(platformDir)} over stdio`);
    await server.connect(new StdioServerTransport());
    // connect() resolves once the transport is wired; the stdin listener
    // keeps the event loop alive until the harness disconnects.
  },
});
