// `myrmo-mcp init --url <colony> [--key <key>] [--private] [--publish ...]`: one command points a person's machine at
// their organisation's colony. The colony goes into the settings file with what belongs to it, the private rules are
// written, and Antigravity gets the hook that looks errors up in that colony.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_BLOCK_PRIVATE, mergeHooks, parseInitArgs, runInit } from "../dist/init.js";

const KEY = `myk_${"c".repeat(64)}`;
const HOOKS = fileURLToPath(new URL("../dist/hooks", import.meta.url));
let saved;
beforeEach(() => {
  saved = process.env.MYRMO_CONFIG;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MYRMO_CONFIG;
  else process.env.MYRMO_CONFIG = saved;
});

function machine() {
  const home = mkdtempSync(join(tmpdir(), "myrmo-colony-"));
  mkdirSync(join(home, ".gemini", "config"), { recursive: true }); // Antigravity is installed
  process.env.MYRMO_CONFIG = join(home, ".myrmo", "config.json");
  const out = [];
  return { home, out, log: (l) => out.push(l) };
}

test("the options belong to one colony, and private mode or a key never go to the public one", () => {
  const opts = parseInitArgs(["--url", "https://myrmo.example.internal", "--key", KEY, "--private", "--publish", "auto"]);
  assert.equal(opts.url, "https://myrmo.example.internal");
  assert.equal(opts.key, KEY);
  assert.equal(opts.private, true);
  assert.equal(opts.publish, "auto");
  assert.match(parseInitArgs(["--key", KEY]), /go with --url/);
  assert.match(parseInitArgs(["--url", "ftp://x"]), /colony address/);
  assert.match(parseInitArgs(["--url", "https://myrmo.dev", "--private"]), /not the public one/);
  assert.match(parseInitArgs(["--url", "https://myrmo.example.internal", "--publish", "always"]), /auto, ask or off/);
  assert.match(parseInitArgs(["--url"]), /needs a value/);
});

test("init saves the colony, writes the private rules and installs the Antigravity hook", () => {
  const m = machine();
  runInit({ clients: ["antigravity"], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal/", key: KEY, private: true, publish: "auto", hooksSource: HOOKS });
  const config = JSON.parse(readFileSync(process.env.MYRMO_CONFIG, "utf8"));
  assert.deepEqual(config.colony, { url: "https://myrmo.example.internal", api_key: KEY, private: true, publish: "auto" });
  assert.equal(config.publish, undefined, "the public colony's choice is untouched");
  assert.ok(readFileSync(join(m.home, ".gemini", "GEMINI.md"), "utf8").includes(AGENTS_BLOCK_PRIVATE.split("\n")[1]));
  for (const f of ["antigravity-hook.mjs", "on-failure.mjs", "lookup.mjs", "effort.mjs"]) assert.ok(existsSync(join(m.home, ".myrmo", "hooks", f)), f);
  const hooks = JSON.parse(readFileSync(join(m.home, ".gemini", "config", "hooks.json"), "utf8"));
  assert.match(hooks.myrmo.PreInvocation[0].command, /^node ".*antigravity-hook\.mjs"$/);
  assert.ok(!m.out.join("\n").includes(KEY), "the key is never printed");
});

test("a dry run saves and installs nothing", () => {
  const m = machine();
  runInit({ clients: ["antigravity"], dryRun: true, home: m.home, log: m.log, url: "https://myrmo.example.internal", key: KEY, private: true, hooksSource: HOOKS });
  assert.equal(existsSync(process.env.MYRMO_CONFIG), false);
  assert.equal(existsSync(join(m.home, ".myrmo", "hooks")), false);
  assert.match(m.out.join("\n"), /would save https:\/\/myrmo\.example\.internal with its access key, private mode/);
});

test("the hook entry keeps the user's other hooks, and a damaged hooks.json is left alone", () => {
  const other = JSON.stringify({ mine: { PreInvocation: [{ type: "command", command: "echo hi" }] } });
  const merged = mergeHooks(other, 'node "/h/antigravity-hook.mjs"');
  assert.deepEqual(Object.keys(JSON.parse(merged.text)).sort(), ["mine", "myrmo"]);
  assert.equal(mergeHooks(merged.text, 'node "/h/antigravity-hook.mjs"').changed, false);
  assert.equal(mergeHooks("{ not json", "x"), null);
  assert.equal(mergeHooks("[1]", "x"), null);

  const m = machine();
  writeFileSync(join(m.home, ".gemini", "config", "hooks.json"), "{ broken");
  runInit({ clients: ["antigravity"], dryRun: false, home: m.home, log: m.log, url: "https://myrmo.example.internal", private: true, hooksSource: HOOKS });
  assert.equal(readFileSync(join(m.home, ".gemini", "config", "hooks.json"), "utf8"), "{ broken");
  assert.match(m.out.join("\n"), /not valid JSON, left untouched/);
});
