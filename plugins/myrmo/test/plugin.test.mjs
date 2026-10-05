// The Claude Code plugin: the failure hook must stay quiet unless a search is worth suggesting,
// never break the agent, and the manifests must point at files that exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, readSettings } from "../scripts/on-failure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const fail = (command, exit_code = 1, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, exit_code, error: `Command failed with exit code ${exit_code}`, ...extra });

test("a failing build or install gets a reminder to search first", () => {
  const out = decide(fail("pip install -r requirements.txt"), { env: {} });
  assert.match(out.note, /myrmo_search/);
  assert.match(out.note, /BEFORE you try a fix/);
  assert.match(out.note, /untrusted/);
  assert.equal(out.state.count, 1);
});

test("a failing command run with the PowerShell tool gets the reminder too", () => {
  const out = decide(fail("python -c \"import nada\"", 1, { tool_name: "PowerShell" }), { env: {} });
  assert.match(out.note, /myrmo_search/);
  for (const cmd of ["Select-String foo x.txt", "Get-ChildItem missing", "Test-Path x", "gc nofile"]) {
    assert.equal(decide(fail(cmd, 1, { tool_name: "PowerShell" }), { env: {} }).note, null, cmd);
  }
});

test("probes, interruptions and other tools are left alone", () => {
  for (const cmd of ["grep -r foo src", "diff a b", "test -f x", "git diff --quiet", "ls missing", "rg TODO", "npx myrmo-mcp config"]) {
    assert.equal(decide(fail(cmd), { env: {} }).note, null, cmd);
  }
  for (const code of [130, 143, 137, 124]) assert.equal(decide(fail("npm test", code), { env: {} }).note, null, `exit ${code}`);
  assert.equal(decide({ tool_name: "Edit", exit_code: 1 }, { env: {} }).note, null);
});

test("reminders are spaced out and capped per session", () => {
  let state = {};
  const env = { MYRMO_HOOK_MIN_SECONDS: "45", MYRMO_HOOK_MAX: "2" };
  // Each failure is a different error: the same one is only ever reminded once (see hook.test.mjs).
  const failing = (n) => fail("npm test", 1, { error: `Exit code 1
Error: problem number ${"abcdef"[n]} happened` });
  let r = decide(failing(0), { now: 1_000_000, state, env });
  assert.ok(r.note);
  state = r.state;
  r = decide(failing(1), { now: 1_000_000 + 10_000, state, env });
  assert.equal(r.note, null, "ten seconds later is too soon");
  r = decide(failing(2), { now: 1_000_000 + 60_000, state, env });
  assert.ok(r.note, "a minute later is fine");
  state = r.state;
  r = decide(failing(3), { now: 1_000_000 + 600_000, state, env });
  assert.equal(r.note, null, "the cap of two per session is reached");
});

test("the user can switch it off", () => {
  assert.equal(decide(fail("npm test"), { env: { MYRMO_HOOK: "off" } }).note, null);
});

test("the script speaks the hook protocol and exits 0 whatever it receives", () => {
  const run = (input) => spawnSync(process.execPath, [join(root, "scripts", "on-failure.mjs")], { input, encoding: "utf8", env: { ...process.env, MYRMO_HOOK: "" } });
  const ok = run(JSON.stringify({ ...fail("cargo build"), session_id: `test-${Date.now()}` }));
  assert.equal(ok.status, 0);
  const body = JSON.parse(ok.stdout);
  assert.equal(body.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(body.hookSpecificOutput.additionalContext, /myrmo_search/);
  for (const bad of ["", "not json", "null", "[]"]) {
    const r = run(bad);
    assert.equal(r.status, 0, `input ${JSON.stringify(bad)}`);
    assert.equal(r.stdout, "");
  }
});

test("manifests are valid and point at files that exist", () => {
  const plugin = json(join(root, ".claude-plugin", "plugin.json"));
  assert.equal(plugin.name, "myrmo");
  assert.ok(!/^(claude|anthropic)/i.test(plugin.name), "names that pass as Anthropic's own are reserved");

  const market = json(join(repo, ".claude-plugin", "marketplace.json"));
  assert.ok(market.name && market.owner?.name);
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, "the marketplace lists the plugin under its manifest name");
  assert.ok(existsSync(join(repo, entry.source, ".claude-plugin", "plugin.json")), "the entry's source is the plugin directory");
  assert.ok(!entry.source.includes(".."));

  const hooks = json(join(root, "hooks", "hooks.json"));
  const hook = hooks.hooks.PostToolUseFailure[0];
  assert.equal(hook.matcher, "Bash|PowerShell", "Claude Code on Windows runs commands with the PowerShell tool");
  const script = hook.hooks[0].args[0].replace("${CLAUDE_PLUGIN_ROOT}", root);
  assert.ok(existsSync(script), "the hook script exists");

  const mcp = json(join(root, ".mcp.json"));
  assert.ok(existsSync(mcp.mcpServers.myrmo.args[0].replace("${CLAUDE_PLUGIN_ROOT}", root)), "the MCP launcher exists");
});

test("the skill has the front matter Claude Code needs", () => {
  const text = readFileSync(join(root, "skills", "myrmo", "SKILL.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  assert.match(front, /^name: myrmo$/m);
  assert.match(front, /^description: .{40,}/m);
});

test("the settings file can switch the hook off, and the environment variable still wins", () => {
  const off = { settings: { hook: "off" } };
  assert.equal(decide(fail("npm test"), { env: {}, ...off }).note, null);
  assert.match(decide(fail("npm test"), { env: { MYRMO_HOOK: "on" }, ...off }).note, /myrmo_search/, "MYRMO_HOOK=on beats hook: off in the file");
  assert.equal(decide(fail("npm test"), { env: { MYRMO_HOOK: "off" }, settings: { hook: "on" } }).note, null);
  assert.match(decide(fail("npm test"), { env: {}, settings: { hook: "on" } }).note, /myrmo_search/);
  assert.match(decide(fail("npm test"), { env: {} }).note, /myrmo_search/, "no settings at all means on");
});

test("readSettings reads the shared file, and a missing or damaged one means the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-hook-settings-"));
  const file = join(dir, "config.json");
  assert.deepEqual(readSettings({ MYRMO_CONFIG: file }), {});
  writeFileSync(file, JSON.stringify({ hook: "off", agent_id: "x".repeat(20) }));
  assert.equal(readSettings({ MYRMO_CONFIG: file }).hook, "off");
  writeFileSync(file, "{ not json");
  assert.deepEqual(readSettings({ MYRMO_CONFIG: file }), {});
});

test("the hook script, run like Claude Code runs it, honours the settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-hook-run-"));
  const file = join(dir, "config.json");
  const input = JSON.stringify({ session_id: "settings-test-" + Date.now(), ...fail("npm test") });
  const run = () => spawnSync(process.execPath, [join(root, "scripts", "on-failure.mjs")], { input, encoding: "utf8", env: { ...process.env, MYRMO_CONFIG: file, MYRMO_HOOK: "" } });
  writeFileSync(file, JSON.stringify({ hook: "off" }));
  assert.equal(run().stdout, "");
  writeFileSync(file, JSON.stringify({ hook: "on" }));
  assert.match(run().stdout, /myrmo_search/);
});
