// The work log for Antigravity: `init --worklog` adds its own group to ~/.gemini/config/hooks.json, next to the error
// lookup hook and to anyone else's, with the event as an argument (Antigravity does not say which event it runs).
// Also: Cline's hooks go to the Documents folder Cline itself uses.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agyHookNode, workLogChecks } from "../dist/doctor.js";
import { AGY_WORKLOG_EVENTS, AGY_WORKLOG_GROUP, HOOK_SCRIPTS, agyWorkLogCommand, documentsDir, mergeAgyWorkLog, runInit } from "../dist/init.js";
import { HOOKS, KIT_COPY, fakeKit } from "./fake-kit.mjs";

const KEY = `myk_${"e".repeat(64)}`;
const KIT = fakeKit();
let saved;
beforeEach(() => { saved = process.env.MYRMO_CONFIG; });
afterEach(() => { if (saved === undefined) delete process.env.MYRMO_CONFIG; else process.env.MYRMO_CONFIG = saved; });

function machine({ agy = true, hooks, mcp } = {}) {
  const home = mkdtempSync(join(tmpdir(), "myrmo-agy-"));
  if (agy) mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  if (hooks !== undefined) writeFileSync(join(home, ".gemini", "config", "hooks.json"), typeof hooks === "string" ? hooks : JSON.stringify(hooks));
  if (mcp) writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify(mcp));
  process.env.MYRMO_CONFIG = join(home, ".myrmo", "config.json");
  const out = [];
  return { home, out, log: (l) => out.push(l) };
}
const file = (m) => join(m.home, ".gemini", "config", "hooks.json");
const read = (m) => JSON.parse(readFileSync(file(m), "utf8"));
const run = (m, extra = {}) => runInit({ clients: ["antigravity"], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal", key: KEY, private: true, hooksSource: HOOKS, kit: KIT, ...extra });

test("the Antigravity work log script is not in this package: it comes with the colony kit", () => {
  assert.ok(!HOOK_SCRIPTS.includes("antigravity-worklog.mjs"));
  assert.equal(existsSync(join(HOOKS, "antigravity-worklog.mjs")), false);
});

test("without a kit, the error lookup hook is still installed from the package, and the work log is not", () => {
  const m = machine({ hooks: {} });
  run(m, { worklog: true, kit: null });
  const hooks = read(m);
  assert.equal(hooks[AGY_WORKLOG_GROUP], undefined, "no work log group");
  assert.ok(hooks.myrmo, "the error lookup hook is registered");
  for (const f of HOOK_SCRIPTS) assert.ok(existsSync(join(m.home, ".myrmo", "hooks", f)), f);
  assert.ok(!readFileSync(join(m.home, ".myrmo", "hooks", "lookup.mjs"), "utf8").includes(KIT_COPY), "the package's own copy");
  assert.match(m.out.join("\n"), /Antigravity: the work log comes with the kit .*npx myrmo-mcp@latest kit/);
});

test("with a kit, the error lookup hook runs from the kit's set too, never a mix", () => {
  const m = machine({ hooks: {} });
  run(m, { worklog: true });
  assert.ok(read(m).myrmo && read(m)[AGY_WORKLOG_GROUP]);
  assert.ok(readFileSync(join(m.home, ".myrmo", "hooks", "lookup.mjs"), "utf8").includes(KIT_COPY), "the kit's copy, not the package's");
});

test("the command names its event and turns the work log on, in sh and in cmd", () => {
  const sh = agyWorkLogCommand("/opt/node/bin/node", "/home/a/.myrmo/hooks/antigravity-worklog.mjs", "Stop", "linux");
  assert.equal(sh, "'/opt/node/bin/node' '/home/a/.myrmo/hooks/antigravity-worklog.mjs' Stop --worklog");
  assert.equal(agyHookNode(sh), "/opt/node/bin/node");
  const cmd = agyWorkLogCommand("C:\\nodejs\\node.exe", "C:\\Users\\Ana Gil\\.myrmo\\hooks\\antigravity-worklog.mjs", "Stop", "win32");
  assert.equal(cmd, 'C:\\nodejs\\node.exe "C:\\Users\\Ana Gil\\.myrmo\\hooks\\antigravity-worklog.mjs" Stop --worklog');
  assert.ok(!cmd.startsWith('"'), "cmd /c would strip the first and last quotes");
  assert.equal(agyHookNode(cmd), "C:\\nodejs\\node.exe");
  const spaced = agyWorkLogCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\x.mjs", "Stop", "win32");
  assert.equal(spaced, 'node "C:\\x.mjs" Stop --worklog');
  assert.equal(agyHookNode(spaced), undefined);
});

test("without --worklog only the error lookup is registered, and the person is told how", () => {
  const m = machine();
  run(m);
  assert.equal(read(m)[AGY_WORKLOG_GROUP], undefined);
  assert.ok(read(m).myrmo, "the error lookup hook is still registered");
  assert.match(m.out.join("\n"), /Antigravity: found.*--worklog/);
});

test("with --worklog its own group is added next to everyone else's, and the scripts are copied", () => {
  const theirs = { PreInvocation: [{ type: "command", command: "./scripts/reminder.sh" }] };
  const m = machine({ hooks: { reminder: theirs } });
  run(m, { worklog: true });
  const h = read(m);
  assert.deepEqual(h.reminder, theirs);
  assert.ok(h.myrmo?.PreInvocation, "the error lookup hook too");
  for (const event of AGY_WORKLOG_EVENTS) {
    const command = h[AGY_WORKLOG_GROUP][event][0].command;
    assert.ok(command.includes(process.execPath), "absolute node");
    assert.ok(command.includes(join(m.home, ".myrmo", "hooks", "antigravity-worklog.mjs")));
    assert.ok(command.endsWith(`${event} --worklog`), event);
  }
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "antigravity-worklog.mjs")));
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "antigravity-hook.mjs")), "it reads the transcript with the lookup hook's reader");
  assert.ok(existsSync(join(m.home, ".myrmo", "hooks", "gemini-hook.mjs")), "and asks the colony what it is with Gemini's");
  assert.ok(existsSync(`${file(m)}.before-myrmo-worklog`), "a copy is kept before the first change");
});

test("running it again changes nothing; damaged hooks.json is left alone", () => {
  const m = machine({ hooks: {} });
  run(m, { worklog: true });
  const before = readFileSync(file(m), "utf8");
  run(m, { worklog: true });
  assert.equal(readFileSync(file(m), "utf8"), before);
  assert.match(m.out.join("\n"), /work log hook is already in/);
  assert.equal(mergeAgyWorkLog(before, (e) => read(m)[AGY_WORKLOG_GROUP][e][0].command).changed, false);
  const bad = machine({ hooks: "{ not json" });
  run(bad, { worklog: true });
  assert.equal(readFileSync(file(bad), "utf8"), "{ not json");
});

test("--dry-run writes nothing", () => {
  const m = machine({ hooks: {} });
  run(m, { worklog: true, dryRun: true });
  assert.deepEqual(read(m), {});
  assert.equal(existsSync(join(m.home, ".myrmo", "hooks", "antigravity-worklog.mjs")), false);
});

const doctorInput = (home) => ({ url: "http://colony.test:8080", saved: true, apiKey: KEY, privateMode: true, publish: "ask", home, declared: { profile: "organisation", worklog_scopes: ["*"] }, env: {}, platform: "linux" });
const enrolled = async () => new Response("{}", { status: 200 });

test("doctor: Antigravity with Myrmo but no work log hook is named as not recorded, not among the others", async () => {
  const m = machine({ mcp: { mcpServers: { myrmo: { command: "npx" } } } });
  const checks = await workLogChecks(doctorInput(m.home), enrolled);
  const a = checks.find((c) => c.name.endsWith("Antigravity"));
  assert.equal(a.level, "warn");
  assert.match(a.fix, /init --worklog/);
  assert.ok(!checks.some((c) => /otros|other/.test(c.name) && /Antigravity/.test(c.detail)));
});

test("doctor: with the hook in place Antigravity is recorded, and a vanished node is caught", async () => {
  const m = machine({ mcp: { mcpServers: { myrmo: { command: "npx" } } } });
  run(m, { worklog: true });
  let a = (await workLogChecks(doctorInput(m.home), enrolled)).find((c) => c.name.endsWith("Antigravity"));
  assert.equal(a.level, "ok");
  const h = mergeAgyWorkLog(readFileSync(file(m), "utf8"), (e) => agyWorkLogCommand("/nowhere/node", "/x/antigravity-worklog.mjs", e, "linux"));
  writeFileSync(file(m), h.text);
  a = (await workLogChecks(doctorInput(m.home), enrolled)).find((c) => c.name.endsWith("Antigravity"));
  assert.equal(a.level, "warn");
  assert.match(a.detail, /no longer exists|ya no existe/);
});

test("Cline's Documents folder is the one the system names, and only the real home asks the system", () => {
  const home = homedir();
  assert.equal(documentsDir(home, "win32", () => "C:\\Users\\ana\\OneDrive\\Documentos\r\n"), "C:\\Users\\ana\\OneDrive\\Documentos");
  assert.equal(documentsDir(home, "linux", () => "/home/ana/Documentos\n"), "/home/ana/Documentos");
  assert.equal(documentsDir(home, "linux", () => { throw new Error("no xdg-user-dir"); }), join(home, "Documents"));
  assert.equal(documentsDir(home, "darwin", () => "/never"), join(home, "Documents"));
  assert.equal(documentsDir("/tmp/some-home", "win32", () => "C:\\never"), join("/tmp/some-home", "Documents"));
});
