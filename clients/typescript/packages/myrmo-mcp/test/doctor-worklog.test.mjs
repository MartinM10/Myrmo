// `doctor` and the work log: for every agent on the machine, whether what it does is recorded, and what to do if not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workLogChecks } from "../dist/doctor.js";
import { CLINE_HOOK_EVENTS, clineWrapper } from "../dist/init.js";

const KEY = "myk_" + "b".repeat(64);
const fetchWith = (status) => async () => new Response("{}", { status });
const enrolled = fetchWith(200);
const linux = "linux";

function home({ claude = false, cline = false, hooks = false, node = process.execPath, cursor = false } = {}) {
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
  assert.match(checks[0].fix, /MYRMO_WORKLOG_PEOPLE/);
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
});

test("an agent Myrmo has no work log hook for is named, and warned about only when nothing else records", async () => {
  const alone = byName(await workLogChecks(input(home({ cursor: true })), enrolled), "Work log, other agents");
  assert.equal(alone.level, "warn");
  assert.match(alone.detail, /Cursor: not recorded/);
  assert.match(alone.detail, /myrmo_matters/);
  const withCline = byName(await workLogChecks(input(home({ cursor: true, cline: true, hooks: true })), enrolled), "Work log, other agents");
  assert.equal(withCline.level, "ok");
});

test("a pause is reported", async () => {
  const h = home({ claude: true });
  mkdirSync(join(h, ".myrmo"), { recursive: true });
  writeFileSync(join(h, ".myrmo", "worklog-paused"), "");
  assert.match(byName(await workLogChecks(input(h, { env: { MYRMO_WORKLOG: "1" } }), enrolled), "Work log").detail, /paused/);
});

test("Claude Code recorded both by the plugin and by a hook of its own is a warning", async () => {
  const h = home({ claude: true });
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ env: { MYRMO_WORKLOG: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "MYRMO_WORKLOG=1 node /x/worklog-hook.mjs" }] }] } }));
  const c = byName(await workLogChecks(input(h), enrolled), "Work log, Claude Code");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /twice/);
});
