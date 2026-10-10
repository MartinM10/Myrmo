#!/usr/bin/env node
// Starts the local Myrmo MCP server over stdio. A plain `npx` entry in .mcp.json fails on Windows
// (npx is a .cmd file there), so the plugin starts it through this launcher on every system.
//
// It asks for one exact version of myrmo-mcp. `@latest` would run whatever npm serves at that moment on every
// user's machine, the first second it is published, and would ask the registry on every session; a bare
// `npx myrmo-mcp` would reuse whatever old version is in the npx cache. release-please moves the version
// below when myrmo-mcp is released (see `extra-files` in release-please-config.json), so the plugin and the
// server it starts stay a pair that was tested together.

import { spawn } from "node:child_process";

const MCP_VERSION = "0.14.1"; // x-release-please-version

const child = spawn("npx", ["-y", `myrmo-mcp@${MCP_VERSION}`], { stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (err) => {
  console.error(`Could not start myrmo-mcp: ${err.message}. Is Node.js 18 or newer installed?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
