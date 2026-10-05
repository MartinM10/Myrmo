// `myrmo-mcp init` sets Myrmo up with one command: it finds the `claude` command wherever it is (the PATH, or the one
// the VS Code extension carries on a remote machine), installs the plugin, and writes the usage rules for the
// clients that need them. All of it runs against a fake `claude` that records what it is asked to do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_BLOCK, findClaudeCli, installPlugin, parseInitArgs, rulesFiles, runInit } from "../dist/init.js";

const newDir = () => mkdtempSync(join(tmpdir(), "myrmo-setup-"));
const lines = () => {
  const out = [];
  out.log = (l) => out.push(l);
  return out;
};

/** A stand-in for `claude`: a script that appends its arguments to a file and exits with the given status. */
function fakeClaude(dir, { status = 0, say = "" } = {}) {
  const calls = join(dir, "calls.txt");
  const bin = join(dir, "fake-claude.mjs");
  writeFileSync(bin, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n"); process.stdout.write(${JSON.stringify(say)}); process.exit(${status});`);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []) };
}

/** The environment init sees: only the fake claude, never the real one on this machine. */
const only = (bin) => ({ PATH: "", ...(bin ? { MYRMO_CLAUDE_BIN: bin } : {}) });

test("the claude command is found on the PATH, and in the extension a remote VS Code machine carries", () => {
  const platform = process.platform;
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const home = newDir();
  const noPath = { PATH: "" };
  assert.equal(findClaudeCli(home, noPath, platform), null);

  const onPath = newDir();
  writeFileSync(join(onPath, exe), "");
  assert.equal(findClaudeCli(home, { PATH: onPath }, platform), join(onPath, exe));

  const extension = (root, version) => {
    const dir = join(home, root, "extensions", `anthropic.claude-code-${version}-x64`, "resources", "native-binary");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, exe), "");
    return join(dir, exe);
  };
  extension(".vscode-server", "2.1.9");
  const newest = extension(".vscode-server", "2.1.100");
  assert.equal(findClaudeCli(home, noPath, platform), newest, "versions compare as numbers, so 2.1.100 beats 2.1.9");

  assert.equal(findClaudeCli(home, { PATH: "", MYRMO_CLAUDE_BIN: join(onPath, exe) }, platform), join(onPath, exe), "an explicit path wins");
});

test("init installs the plugin: the marketplace first, then the plugin", () => {
  const dir = newDir();
  const claude = fakeClaude(dir);
  const out = lines();
  runInit({ env: only(claude.bin), clients: [], dryRun: false, home: dir, log: out.log });
  assert.deepEqual(claude.calls(), ["plugin marketplace add MartinM10/Myrmo", "plugin install myrmo@myrmo"]);
  assert.match(out.join("\n"), /Claude Code: plugin installed/);
});

test("init does the same on a second run, when claude says it is already there", () => {
  const dir = newDir();
  const claude = fakeClaude(dir, { status: 1, say: "Marketplace myrmo is already added" });
  const out = lines();
  const result = runInit({ env: only(claude.bin), clients: ["claude-code"], dryRun: false, home: dir, log: out.log });
  assert.ok(result.configured.includes("Claude Code"), "'already' is a success");
});

test("a failing claude command is reported with the manual way, and nothing else is touched", () => {
  const dir = newDir();
  const claude = fakeClaude(dir, { status: 1, say: "network unreachable" });
  const out = lines();
  const result = runInit({ env: only(claude.bin), clients: ["claude-code"], dryRun: false, home: dir, log: out.log });
  assert.ok(result.skipped.includes("Claude Code"));
  assert.match(out.join("\n"), /\/plugin marketplace add MartinM10\/Myrmo/);
  assert.match(out.join("\n"), /\/plugin install myrmo@myrmo/);
});

test("with no claude command anywhere, init says what to type in Claude Code's chat", () => {
  const home = newDir();
  const out = lines();
  const result = runInit({ env: only(), clients: ["claude-code"], dryRun: false, home, log: out.log });
  assert.ok(result.skipped.includes("Claude Code"));
  assert.match(out.join("\n"), /no "claude" command found/);
  assert.match(out.join("\n"), /\/plugin install myrmo@myrmo/);
});

test("--dry-run shows the plugin commands and runs nothing", () => {
  const dir = newDir();
  const claude = fakeClaude(dir);
  const out = lines();
  runInit({ env: only(claude.bin), clients: [], dryRun: true, home: dir, log: out.log });
  assert.deepEqual(claude.calls(), []);
  assert.match(out.join("\n"), /would run: claude plugin marketplace add MartinM10\/Myrmo && claude plugin install myrmo@myrmo/);
});

test("installPlugin stops at the first real failure", () => {
  const dir = newDir();
  const claude = fakeClaude(dir, { status: 2, say: "boom" });
  assert.equal(installPlugin(claude.bin).ok, false);
  assert.equal(claude.calls().length, 1, "no point installing from a marketplace that could not be added");
});

test("Gemini CLI and Windsurf get the usage rules in their global instructions, once, and a read-only variant on request", () => {
  const home = newDir();
  for (const r of rulesFiles(home)) mkdirSync(r.marker, { recursive: true });
  const [gemini, windsurf] = rulesFiles(home);
  writeFileSync(gemini.file, "# My own Gemini notes\nKeep answers short.\n");

  runInit({ env: only(), clients: [], dryRun: false, home, log: () => {} });
  const first = readFileSync(gemini.file, "utf8");
  assert.match(first, /My own Gemini notes/, "what the user wrote stays");
  assert.match(first, /myrmo:start/);
  assert.match(first, /PRIVACY|Everything published is public/i);
  assert.match(readFileSync(windsurf.file, "utf8"), /myrmo_search/);

  runInit({ env: only(), clients: [], dryRun: false, home, log: () => {} });
  assert.equal(readFileSync(gemini.file, "utf8"), first, "the second run changes nothing");
  assert.equal((first.match(/myrmo:start/g) ?? []).length, 1);

  runInit({ env: only(), clients: [], dryRun: false, home, readOnly: true, log: () => {} });
  assert.match(readFileSync(gemini.file, "utf8"), /do NOT publish/, "the block is replaced in place");
  assert.match(readFileSync(gemini.file, "utf8"), /Keep answers short/);
});

test("--no-rules leaves the instruction files alone, and --dry-run writes nothing", () => {
  const home = newDir();
  for (const r of rulesFiles(home)) mkdirSync(r.marker, { recursive: true });
  const [gemini] = rulesFiles(home);
  runInit({ env: only(), clients: [], dryRun: false, rules: false, home, log: () => {} });
  assert.equal(existsSync(gemini.file), false);
  runInit({ env: only(), clients: [], dryRun: true, home, log: () => {} });
  assert.equal(existsSync(gemini.file), false);
  assert.deepEqual(parseInitArgs(["--no-rules"]), { clients: [], dryRun: false, rules: false });
});

test("the full usage block tells agents about privacy and the environment", () => {
  assert.match(AGENTS_BLOCK, /Everything published is public/);
  assert.match(AGENTS_BLOCK, /never patches from proprietary source/);
  assert.match(AGENTS_BLOCK, /inside a\s+container/);
});

test("init ends by saying nothing else needs configuring, and where the defaults can be changed", () => {
  const home = newDir();
  const out = lines();
  runInit({ env: only(), clients: [], dryRun: true, home, log: out.log });
  assert.match(out.join("\n"), /Nothing else to configure/);
  assert.match(out.join("\n"), /npx myrmo-mcp config/);
});
