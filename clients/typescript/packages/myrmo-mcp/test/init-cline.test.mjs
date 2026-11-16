// The work log for Cline: `init --worklog` puts the hooks Cline runs in ~/Documents/Cline/Hooks, with an absolute node,
// and never over a hook the person wrote.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLINE_HOOK_EVENTS, HOOK_SCRIPTS, clineInstalled, clineWrapper, parseInitArgs, runInit } from "../dist/init.js";

const KEY = `myk_${"d".repeat(64)}`;
const HOOKS = fileURLToPath(new URL("../dist/hooks", import.meta.url));
let saved;
beforeEach(() => { saved = process.env.MYRMO_CONFIG; });
afterEach(() => { if (saved === undefined) delete process.env.MYRMO_CONFIG; else process.env.MYRMO_CONFIG = saved; });

function machine({ cline = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "myrmo-cline-"));
  if (cline) mkdirSync(join(home, ".cline", "data"), { recursive: true });
  process.env.MYRMO_CONFIG = join(home, ".myrmo", "config.json");
  const out = [];
  return { home, out, log: (l) => out.push(l) };
}
/** The file Cline runs for an event: named after it, with .ps1 on Windows. */
const hookFile = (home, event) => join(home, "Documents", "Cline", "Hooks", process.platform === "win32" ? `${event}.ps1` : event);
const run = (m, extra = {}) => runInit({ clients: [], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal", key: KEY, private: true, hooksSource: HOOKS, ...extra });

test("--worklog is an option, and the Cline hook script travels with the others", () => {
  assert.equal(parseInitArgs(["--worklog"]).worklog, true);
  assert.ok(HOOK_SCRIPTS.includes("cline-hook.mjs"));
  assert.ok(existsSync(join(HOOKS, "cline-hook.mjs")), "dist/hooks has the script (npm run build copies it)");
});

test("Cline is found by its folders or its VS Code extension", () => {
  assert.equal(clineInstalled(machine({ cline: false }).home), false);
  assert.equal(clineInstalled(machine().home), true);
  const ext = machine({ cline: false });
  mkdirSync(join(ext.home, ".vscode-server", "extensions", "saoudrizwan.claude-dev-4.1.26"), { recursive: true });
  assert.equal(clineInstalled(ext.home), true);
});

test("without --worklog nothing is installed and the person is told how", () => {
  const m = machine();
  run(m);
  assert.equal(existsSync(join(m.home, "Documents", "Cline", "Hooks")), false);
  assert.match(m.out.join("\n"), /--worklog/);
});

test("with --worklog the four hooks are written, executable, with an absolute node and the work log switched on", () => {
  const m = machine();
  run(m, { worklog: true });
  const dir = join(m.home, "Documents", "Cline", "Hooks");
  for (const event of CLINE_HOOK_EVENTS) {
    const file = hookFile(m.home, event);
    assert.ok(existsSync(file), event);
    if (process.platform !== "win32") assert.ok(statSync(file).mode & 0o100, `${event} is executable`);
    const text = readFileSync(file, "utf8");
    assert.match(text, /MYRMO_WORKLOG( = '|=)1/);
    assert.ok(text.includes(process.execPath), "absolute node");
    assert.ok(text.includes(join(m.home, ".myrmo", "hooks", "cline-hook.mjs")));
  }
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "cline-hook.mjs")));
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "worklog.mjs")));
});

test("running it again changes nothing, and a hook of the person's own is left alone", () => {
  const m = machine();
  const dir = join(m.home, "Documents", "Cline", "Hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(hookFile(m.home, "TaskComplete"), "#!/bin/sh\necho mine\n");
  run(m, { worklog: true });
  assert.equal(readFileSync(hookFile(m.home, "TaskComplete"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.match(m.out.join("\n"), /TaskComplete.*hooks of your own/);
  const before = readFileSync(hookFile(m.home, "PostToolUse"), "utf8");
  run(m, { worklog: true });
  assert.equal(readFileSync(hookFile(m.home, "PostToolUse"), "utf8"), before);
});

test("--dry-run writes nothing", () => {
  const m = machine();
  run(m, { worklog: true, dryRun: true });
  assert.equal(existsSync(join(m.home, "Documents", "Cline", "Hooks")), false);
  assert.equal(existsSync(join(m.home, ".myrmo", "hooks", "cline-hook.mjs")), false);
});

test("without a private colony there is no work log", () => {
  const m = machine();
  runInit({ clients: [], dryRun: false, home: m.home, log: m.log, hooksSource: HOOKS, worklog: true });
  assert.equal(existsSync(join(m.home, "Documents", "Cline", "Hooks")), false);
});

test("the wrapper quotes paths with spaces and has a Windows form", () => {
  assert.match(clineWrapper("/opt/my node/bin/node", "/home/a b/.myrmo/hooks/cline-hook.mjs", "linux"), /exec '\/opt\/my node\/bin\/node' '\/home\/a b\/.myrmo\/hooks\/cline-hook.mjs'/);
  const win = clineWrapper("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a\\.myrmo\\hooks\\cline-hook.mjs", "win32");
  assert.match(win, /\$env:MYRMO_WORKLOG = '1'/);
  assert.match(win, /\$input \| &/);
});

test("running init again for the same colony keeps its key and publish choice", () => {
  const m = machine();
  run(m, { publish: "ask" });
  runInit({ clients: [], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal/", private: true, hooksSource: HOOKS, worklog: true });
  const saved = JSON.parse(readFileSync(process.env.MYRMO_CONFIG, "utf8")).colony;
  assert.equal(saved.api_key, KEY);
  assert.equal(saved.publish, "ask");
  assert.ok(existsSync(hookFile(m.home, "TaskComplete")));
});

test("another colony's url does not inherit the saved key", () => {
  const m = machine();
  run(m);
  runInit({ clients: [], dryRun: false, home: m.home, log: m.log, url: "https://other.example.internal", hooksSource: HOOKS });
  assert.equal(JSON.parse(readFileSync(process.env.MYRMO_CONFIG, "utf8")).colony.api_key, undefined);
});

test("init --worklog alone uses the colony already saved, and refuses without one", () => {
  const m = machine();
  run(m);
  runInit({ clients: [], dryRun: false, home: m.home, log: m.log, hooksSource: HOOKS, worklog: true });
  assert.ok(existsSync(hookFile(m.home, "UserPromptSubmit")));
  const bare = machine();
  runInit({ clients: [], dryRun: false, home: bare.home, log: bare.log, hooksSource: HOOKS, worklog: true });
  assert.equal(existsSync(join(bare.home, "Documents", "Cline", "Hooks")), false);
  assert.match(bare.out.join("\n"), /needs your organisation's colony/);
});
