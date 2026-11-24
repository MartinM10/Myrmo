// `doctor` and the work log: for every agent on the machine, whether what it does is recorded, and what to do if not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitCheck, privacyCheck, workLogChecks } from "../dist/doctor.js";
import { CLINE_HOOK_EVENTS, clineWrapper } from "../dist/init.js";

const KEY = "myk_" + "b".repeat(64);
const fetchWith = (status) => async () => new Response("{}", { status });
const enrolled = fetchWith(200);
const linux = "linux";

function home({ claude = false, cline = false, hooks = false, node = process.execPath, cursor = false, script = true } = {}) {
  const h = mkdtempSync(join(tmpdir(), "doctor-wl-"));
  if (claude) {
    mkdirSync(join(h, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "myrmo@myrmo": [{}] } }));
  }
  if (cline) mkdirSync(join(h, ".cline", "data"), { recursive: true });
  if (hooks) {
    const dir = join(h, "Documents", "Cline", "Hooks");
    mkdirSync(dir, { recursive: true });
    for (const e of CLINE_HOOK_EVENTS) writeFileSync(join(dir, e), clineWrapper(node, join(h, ".myrmo", "hooks", "cline-hook.mjs"), linux));
    // The script they run, which init copies from the colony kit.
    if (script) {
      mkdirSync(join(h, ".myrmo", "hooks"), { recursive: true });
      writeFileSync(join(h, ".myrmo", "hooks", "cline-hook.mjs"), "export {};\n");
    }
  }
  if (cursor) {
    mkdirSync(join(h, ".cursor"), { recursive: true });
    writeFileSync(join(h, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { myrmo: { command: "npx" } } }));
  }
  return h;
}
const input = (h, extra = {}) => ({ url: "http://colony.test:8080", saved: true, apiKey: KEY, privateMode: true, publish: "ask", home: h, declared: { profile: "organisation", worklog_scopes: ["*"] }, env: {}, platform: linux, ...extra });
const byName = (checks, name) => checks.find((c) => c.name === name);

test("a colony without a work log, or a public one, adds no line", async () => {
  const h = home({ claude: true });
  assert.deepEqual(await workLogChecks(input(h, { declared: { profile: "organisation" } }), enrolled), []);
  assert.deepEqual(await workLogChecks(input(h, { privateMode: false }), enrolled), []);
});

test("a key that is not enrolled is told whom to ask, and nothing else is checked", async () => {
  const checks = await workLogChecks(input(home({ claude: true, cline: true })), fetchWith(403));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "warn");
  assert.match(checks[0].fix, /enrol your key/);
});

test("Claude Code is recorded with MYRMO_WORKLOG=1 in its settings, in a work log hook or in the shell", async () => {
  const h = home({ claude: true });
  const off = byName(await workLogChecks(input(h), enrolled), "Work log, Claude Code");
  assert.equal(off.level, "warn");
  assert.match(off.fix, /"MYRMO_WORKLOG": "1"/);
  assert.equal(byName(await workLogChecks(input(h, { env: { MYRMO_WORKLOG: "1" } }), enrolled), "Work log, Claude Code").level, "ok");
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ env: { MYRMO_WORKLOG: "1" } }));
  assert.match(byName(await workLogChecks(input(h), enrolled), "Work log, Claude Code").detail, /settings\.json/);
  const hooked = home({ claude: true });
  writeFileSync(join(hooked, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "MYRMO_WORKLOG=1 node /x/.myrmo/worklog-hook/worklog-hook.mjs" }] }] } }));
  assert.match(byName(await workLogChecks(input(hooked), enrolled), "Work log, Claude Code").detail, /work log hook/);
});

test("Cline: no hooks, hooks in place, and hooks whose node is gone", async () => {
  const none = byName(await workLogChecks(input(home({ cline: true })), enrolled), "Work log, Cline");
  assert.equal(none.level, "warn");
  assert.match(none.fix, /init --worklog/);
  const ok = byName(await workLogChecks(input(home({ cline: true, hooks: true })), enrolled), "Work log, Cline");
  assert.equal(ok.level, "ok");
  const gone = byName(await workLogChecks(input(home({ cline: true, hooks: true, node: "/no/such/node" })), enrolled), "Work log, Cline");
  assert.equal(gone.level, "warn");
  assert.match(gone.detail, /no longer exists/);
  const noScript = byName(await workLogChecks(input(home({ cline: true, hooks: true, script: false })), enrolled), "Work log, Cline");
  assert.equal(noScript.level, "warn");
  assert.match(noScript.detail, /comes with the colony kit/);
  assert.match(noScript.fix, /npx myrmo-mcp@latest kit/);
});

test("an agent Myrmo has no work log hook for is named, and warned about only when nothing else records", async () => {
  const alone = byName(await workLogChecks(input(home({ cursor: true })), enrolled), "Work log, other agents");
  assert.equal(alone.level, "warn");
  assert.match(alone.detail, /Cursor: not recorded/);
  const withCline = byName(await workLogChecks(input(home({ cursor: true, cline: true, hooks: true })), enrolled), "Work log, other agents");
  assert.equal(withCline.level, "ok");
});

test("the colony kit: installed, out of date, offered but missing, in development, or none", () => {
  const kit = { version: "1.2.3-abcdef1234", dir: "/k" };
  assert.equal(kitCheck(kit, undefined, true).level, "ok");
  assert.match(kitCheck(kit, "1.2.3-abcdef1234", true).detail, /1\.2\.3-abcdef1234 installed/);
  const old = kitCheck(kit, "1.2.4-0000000000", true);
  assert.equal(old.level, "warn");
  assert.match(old.fix, /npx myrmo-mcp@latest kit/);
  const missing = kitCheck(null, "1.2.4-0000000000", true);
  assert.equal(missing.level, "warn");
  assert.match(missing.detail, /none installed; this colony offers 1\.2\.4-0000000000/);
  const dev = kitCheck({ version: "dev", dir: "/src/kit", dev: true }, undefined, true);
  assert.equal(dev.level, "warn");
  assert.match(dev.detail, /MYRMO_KIT_DEV=\/src\/kit/);
  assert.equal(kitCheck(null, undefined, true).level, "ok");
  assert.equal(kitCheck(null, undefined, false), null, "nothing to say for a colony that is not an organisation's");
});

test("Claude Code recorded both by the plugin and by a hook of its own is a warning", async () => {
  const h = home({ claude: true });
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ env: { MYRMO_WORKLOG: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "MYRMO_WORKLOG=1 node /x/worklog-hook.mjs" }] }] } }));
  const c = byName(await workLogChecks(input(h), enrolled), "Work log, Claude Code");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /twice/);
});

test("doctor says when the machine is paused, which stops all of Myrmo, and counts the private sessions", () => {
  const h = home();
  assert.equal(privacyCheck(h, {}), null, "nothing private: nothing said");
  assert.equal(privacyCheck(h, { MYRMO_WORKLOG_PAUSE: "1" }).level, "warn");
  mkdirSync(join(h, ".myrmo", "private"), { recursive: true });
  writeFileSync(join(h, ".myrmo", "private", "claude-a.json"), "{}");
  writeFileSync(join(h, ".myrmo", "private", "cline-b.json"), "{}");
  assert.match(privacyCheck(h, {}).detail, /^2 sessions made private/);
  writeFileSync(join(h, ".myrmo", "worklog-paused"), "");
  const paused = privacyCheck(h, {});
  assert.equal(paused.level, "warn");
  assert.match(paused.detail, /no session sends anything/);
  assert.match(paused.fix, /worklog-paused to share again/);
});

test("a Cline missing the PreToolUse hook is told that //privado cannot stop a call to Myrmo", async () => {
  const h = home({ cline: true, hooks: true });
  const { rmSync } = await import("node:fs");
  rmSync(join(h, "Documents", "Cline", "Hooks", "PreToolUse"));
  const cline = byName(await workLogChecks(input(h), enrolled), "Work log, Cline");
  assert.match(cline.detail, /PreToolUse missing \(without it, \/\/privado cannot stop a call to Myrmo\)/);
});
