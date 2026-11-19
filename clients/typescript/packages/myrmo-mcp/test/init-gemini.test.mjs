// The work log for Gemini CLI: `init --worklog` registers its hooks in ~/.gemini/settings.json, with an absolute node and
// MYRMO_WORKLOG=1 in the command (Gemini CLI runs hooks with a sanitized environment), and keeps the person's own hooks.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiHookNode, workLogChecks } from "../dist/doctor.js";
import { GEMINI_HOOK_EVENTS, GEMINI_HOOK_NAME, HOOK_SCRIPTS, geminiCommand, geminiInstalled, mergeGeminiHooks, runInit } from "../dist/init.js";
import { HOOKS, fakeKit } from "./fake-kit.mjs";

const KEY = `myk_${"e".repeat(64)}`;
const KIT = fakeKit();
let saved;
beforeEach(() => { saved = process.env.MYRMO_CONFIG; });
afterEach(() => { if (saved === undefined) delete process.env.MYRMO_CONFIG; else process.env.MYRMO_CONFIG = saved; });

function machine({ gemini = true, settings } = {}) {
  const home = mkdtempSync(join(tmpdir(), "myrmo-gemini-"));
  if (gemini) mkdirSync(join(home, ".gemini", "tmp"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(home, ".gemini", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  process.env.MYRMO_CONFIG = join(home, ".myrmo", "config.json");
  const out = [];
  return { home, out, log: (l) => out.push(l) };
}
const file = (m) => join(m.home, ".gemini", "settings.json");
const read = (m) => JSON.parse(readFileSync(file(m), "utf8"));
const run = (m, extra = {}) => runInit({ clients: ["gemini"], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal", key: KEY, private: true, hooksSource: HOOKS, kit: KIT, ...extra });
const mine = (settings, event) => (settings.hooks[event] ?? []).filter((d) => d.hooks?.some((h) => h.name === GEMINI_HOOK_NAME));

test("the Gemini CLI hook script is not in this package: it comes with the colony kit", () => {
  assert.ok(!HOOK_SCRIPTS.includes("gemini-hook.mjs"));
  assert.equal(existsSync(join(HOOKS, "gemini-hook.mjs")), false);
});

test("without a kit, --worklog says where the work log comes from and leaves Gemini CLI's settings alone", () => {
  const m = machine({ settings: { theme: "x" } });
  run(m, { worklog: true, kit: null });
  assert.equal(read(m).hooks, undefined, "no hooks registered");
  assert.equal(read(m).theme, "x");
  assert.match(m.out.join("\n"), /Gemini CLI: the work log comes with the kit .*npx myrmo-mcp@latest kit/);
});

test("Gemini CLI is found by its folder's settings, sessions or history", () => {
  assert.equal(geminiInstalled(machine({ gemini: false }).home), false);
  assert.equal(geminiInstalled(machine().home), true);
});

test("the command sets the work log on and starts an absolute node, in bash and in PowerShell", () => {
  const sh = geminiCommand("/opt/node/bin/node", "/home/a/.myrmo/hooks/gemini-hook.mjs", "linux");
  assert.equal(sh, "MYRMO_WORKLOG=1 '/opt/node/bin/node' '/home/a/.myrmo/hooks/gemini-hook.mjs'");
  assert.equal(geminiHookNode(sh), "/opt/node/bin/node");
  const ps = geminiCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a\\.myrmo\\hooks\\gemini-hook.mjs", "win32");
  assert.equal(ps, "$env:MYRMO_WORKLOG = '1'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\a\\.myrmo\\hooks\\gemini-hook.mjs'");
  assert.equal(geminiHookNode(ps), "C:\\Program Files\\nodejs\\node.exe");
});

test("without --worklog nothing is installed and the person is told how", () => {
  const m = machine({ settings: { mcpServers: {} } });
  run(m);
  assert.equal(read(m).hooks, undefined);
  assert.match(m.out.join("\n"), /Gemini CLI: found.*--worklog/);
});

test("with --worklog every event gets the hook, next to the person's own, and the scripts are copied", () => {
  const theirs = { hooks: [{ name: "lint", type: "command", command: "echo hi" }] };
  const m = machine({ settings: { security: { auth: { selectedType: "oauth-personal" } }, hooks: { AfterTool: [theirs] } } });
  run(m, { worklog: true });
  const s = read(m);
  assert.equal(s.security.auth.selectedType, "oauth-personal", "the rest of the settings is kept");
  for (const event of GEMINI_HOOK_EVENTS) {
    const defs = mine(s, event);
    assert.equal(defs.length, 1, event);
    const command = defs[0].hooks[0].command;
    assert.ok(command.includes(process.execPath), "absolute node");
    assert.ok(command.includes(join(m.home, ".myrmo", "hooks", "gemini-hook.mjs")));
    assert.match(command, /MYRMO_WORKLOG( = '|=)1/);
  }
  assert.deepEqual(s.hooks.AfterTool[0], theirs);
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "gemini-hook.mjs")));
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "on-failure.mjs")), "with the kit's shared modules");
  assert.ok(existsSync(`${file(m)}.before-myrmo-worklog`), "a copy of the settings is kept before the first change");
});

test("running it again changes nothing", () => {
  const m = machine({ settings: {} });
  run(m, { worklog: true });
  const before = readFileSync(file(m), "utf8");
  run(m, { worklog: true });
  assert.equal(readFileSync(file(m), "utf8"), before);
  assert.match(m.out.join("\n"), /already in/);
  assert.equal(mergeGeminiHooks(JSON.parse(before), mine(JSON.parse(before), "AfterAgent")[0].hooks[0].command).changed, false);
});

test("damaged settings are left untouched", () => {
  const m = machine({ settings: "{ not json" });
  run(m, { worklog: true });
  assert.equal(readFileSync(file(m), "utf8"), "{ not json");
  assert.match(m.out.join("\n"), /not valid JSON/);
});

test("--dry-run writes nothing", () => {
  const m = machine({ settings: {} });
  run(m, { worklog: true, dryRun: true });
  assert.equal(read(m).hooks, undefined);
  assert.equal(existsSync(join(m.home, ".myrmo", "hooks", "gemini-hook.mjs")), false);
});

test("--client cursor leaves Gemini CLI alone", () => {
  const m = machine({ settings: {} });
  run(m, { worklog: true, clients: ["cursor"] });
  assert.equal(read(m).hooks, undefined);
});

const doctorInput = (home) => ({ url: "http://colony.test:8080", saved: true, apiKey: KEY, privateMode: true, publish: "ask", home, declared: { profile: "organisation", worklog_scopes: ["*"] }, env: {}, platform: "linux" });
const enrolled = async () => new Response("{}", { status: 200 });

test("doctor: Gemini CLI with Myrmo but no hooks is named as not recorded", async () => {
  const m = machine({ settings: { mcpServers: { myrmo: { command: "npx" } } } });
  const checks = await workLogChecks(doctorInput(m.home), enrolled);
  const g = checks.find((c) => c.name.endsWith("Gemini CLI"));
  assert.equal(g.level, "warn");
  assert.match(g.fix, /init --worklog/);
  assert.ok(!checks.some((c) => /Gemini CLI/.test(c.detail ?? "") && c.name.includes("other")), "not listed again among the other agents");
});

test("doctor: with the hooks in place Gemini CLI is recorded, and a vanished node is caught", async () => {
  const m = machine({ settings: { mcpServers: { myrmo: { command: "npx" } } } });
  run(m, { worklog: true });
  let g = (await workLogChecks(doctorInput(m.home), enrolled)).find((c) => c.name.endsWith("Gemini CLI"));
  assert.equal(g.level, "ok");
  const s = read(m);
  s.hooks = mergeGeminiHooks(s, geminiCommand("/nowhere/node", join(m.home, ".myrmo", "hooks", "gemini-hook.mjs"), "linux")).settings.hooks;
  writeFileSync(file(m), JSON.stringify(s));
  g = (await workLogChecks(doctorInput(m.home), enrolled)).find((c) => c.name.endsWith("Gemini CLI"));
  assert.equal(g.level, "warn");
  assert.match(g.detail, /no longer exists|ya no existe/);
});
