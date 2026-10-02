#!/usr/bin/env node
// Starts the local Myrmo MCP server over stdio. A plain `npx` entry in .mcp.json fails on Windows
// (npx is a .cmd file there), so the plugin starts it through this launcher on every system.

import { spawn } from "node:child_process";

const child = spawn("npx", ["-y", "myrmo-mcp"], { stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (err) => {
  console.error(`Could not start myrmo-mcp: ${err.message}. Is Node.js 18 or newer installed?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
