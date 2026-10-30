// myrmo-mcp declares which myrmo SDK versions it accepts. If the lowest one is too low, an npm install that
// resolves to it (for example from a stale cache) gives a server that does not even start: myrmo-mcp 0.6.0
// imported a function that exists only from myrmo 0.5.0 while declaring ">=0.3.0".
//
// This installs the lowest accepted myrmo next to the freshly built myrmo-mcp and starts it, so that the
// range says what the code needs. Usage: node scripts/check-sdk-floor.mjs [floor-version]

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mcp = join(here, "..", "packages", "myrmo-mcp");
const pkg = JSON.parse(readFileSync(join(mcp, "package.json"), "utf8"));
const range = pkg.dependencies.myrmo;
const floor = process.argv[2] ?? /^>=\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
if (!floor) {
  console.error(`Cannot find the lowest version in the range "${range}".`);
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// On Windows npm is a .cmd file and needs a shell, where "^" in a range such as ^3.25.0 is an escape character:
// quote every argument so that the range reaches npm as written.
const run = (args, options = {}) =>
  process.platform === "win32"
    ? spawnSync(npm, args.map((a) => `"${a}"`), { encoding: "utf8", shell: true, ...options })
    : spawnSync(npm, args, { encoding: "utf8", ...options });

const published = run(["view", `myrmo@${floor}`, "version"]);
if (published.status !== 0 || !published.stdout.trim()) {
  console.log(`myrmo@${floor} is not on npm yet (it ships together with this change): nothing to check.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "myrmo-floor-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "floor-check", private: true, type: "module" }));
const install = run(
  ["install", `myrmo@${floor}`, `@modelcontextprotocol/sdk@${pkg.dependencies["@modelcontextprotocol/sdk"]}`, `zod@${pkg.dependencies.zod}`, "--no-audit", "--no-fund", "--loglevel=error"],
  { cwd: dir },
);
if (install.status !== 0) {
  console.error(`Could not install myrmo@${floor}:\n${install.stdout}${install.stderr}`);
  process.exit(2);
}
cpSync(join(mcp, "dist"), join(dir, "dist"), { recursive: true });

const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "floor-check", version: "1" } } }) + "\n";
const started = spawnSync(process.execPath, [join(dir, "dist", "index.js")], {
  input: request,
  encoding: "utf8",
  timeout: 30_000,
  env: { ...process.env, MYRMO_CONFIG: join(dir, "settings.json"), MYRMO_URL: "http://127.0.0.1:1" },
});
if (started.status !== 0 && !started.stdout.includes('"serverInfo"')) {
  console.error(`myrmo-mcp does not start with myrmo@${floor}, the lowest version its package.json accepts ("${range}"):`);
  console.error((started.stderr || started.stdout).split("\n").slice(0, 8).join("\n"));
  console.error(`Raise the lower bound of the "myrmo" dependency in packages/myrmo-mcp/package.json.`);
  process.exit(1);
}
if (!started.stdout.includes('"serverInfo"')) {
  console.error(`myrmo-mcp started with myrmo@${floor} but did not answer initialize:\n${started.stdout}${started.stderr}`);
  process.exit(1);
}
console.log(`myrmo-mcp ${pkg.version} starts with myrmo@${floor}, the lowest version it accepts.`);
