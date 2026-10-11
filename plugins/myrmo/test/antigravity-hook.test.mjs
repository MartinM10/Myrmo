// The Antigravity hook replays transcript steps through the Claude Code hook's `decide`. The steps below have the shape
// agy 1.3.3 really writes to transcript_full.jsonl (captured in a container): a PLANNER_RESPONSE with tool_calls, then one
// GENERIC step per call with its result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doneUntil, events, readSteps, step } from "../scripts/antigravity-hook.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 5_000_000_000;
const ID1 = "0b5e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
let index = 0;
const model = (calls) => ({ step_index: index++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: calls });
const result = (content) => ({ step_index: index++, source: "MODEL", type: "GENERIC", status: "DONE", content });
const run = (command) => ({ name: "run_command", args: { CommandLine: command, Cwd: "/w" } });
const exited = (code, output) => result(`Created At: x\nCompleted At: x\n\nThe command exited with code ${code}.\nOutput:\n${output}\n\n`);
const search = (error) => ({ name: "call_mcp_tool", args: { ServerName: "myrmo", ToolName: "myrmo_search", Arguments: { error } } });
const report = () => ({ name: "call_mcp_tool", args: { ServerName: "myrmo", ToolName: "myrmo_report", Arguments: { trail_id: ID1, outcome: "worked" } } });
const lines = (steps) => steps.map((s) => JSON.stringify(s)).join("\n");
// Steps are numbered by their position, as Antigravity numbers them.
const transcript = (...steps) => lines(steps.flat().map((s, i) => ({ ...s, step_index: i })));

test("a failed command becomes a reminder to search, told how Antigravity reaches the tool", () => {
  const t = transcript(model([run("pip install x")]), exited(1, "ERROR: No matching distribution found for x==9.9"));
  const out = step({}, {}, { now: NOW, env: {}, transcript: t });
  assert.match(out.note, /a command just failed \(exit 1\)/);
  assert.match(out.note, /Last error line: «ERROR: No matching distribution found for x==9\.9»/);
  assert.match(out.note, /call_mcp_tool with ServerName "myrmo"/);
  assert.equal(out.state.agyNext, 2, "the steps read are not read again");
  assert.equal(step({}, out.state, { now: NOW + 60_000, env: {}, transcript: t }).note, null, "the same steps say nothing twice");
});

test("an exit 0 whose output ends in an error is noticed too, and a clean one is not", () => {
  const hidden = transcript(model([run("python3 -c 'import y' ; echo done")]), exited(0, "Traceback (most recent call last):\nModuleNotFoundError: No module named 'y'"));
  assert.match(step({}, {}, { now: NOW, env: {}, transcript: hidden }).note, /finished with exit 0/);
  const clean = transcript(model([run("make")]), exited(0, "all done"));
  assert.equal(step({}, {}, { now: NOW, env: {}, transcript: clean }).note, null);
});

test("after a search that found trails, the fix working brings the reminder to report", () => {
  const before = transcript(model([run("npm install")]), exited(1, "npm error code ERESOLVE"), model([search("npm error code ERESOLVE")]),
    result(`<myrmo_trails untrusted="true" fingerprint="fp2_abc">\n## Trail 1 of 1 · id ${ID1}\n</myrmo_trails>`));
  let out = step({}, {}, { now: NOW, env: {}, transcript: before });
  const after = transcript(model([run("npm install")]), exited(1, "npm error code ERESOLVE"), model([search("npm error code ERESOLVE")]),
    result(`<myrmo_trails untrusted="true" fingerprint="fp2_abc">\n## Trail 1 of 1 · id ${ID1}\n</myrmo_trails>`),
    model([run("npm install --legacy-peer-deps")]), exited(0, "added 120 packages"));
  out = step({}, out.state, { now: NOW + 60_000, env: {}, transcript: after });
  assert.match(out.note, /myrmo_report/);
  assert.match(out.note, new RegExp(ID1));
  const reported = transcript(readSteps(after), model([report()]), result("Reported."));
  assert.deepEqual(events(readSteps(reported), out.state.agyNext).map((e) => e.tool_name), ["mcp__myrmo__myrmo_report"]);
});

test("a call still running is read again once its result is in", () => {
  const running = transcript(model([run("npm test")]));
  const first = step({}, {}, { now: NOW, env: {}, transcript: running });
  assert.equal(first.note, null);
  assert.equal(first.state.agyNext, 0, "nothing is skipped while the result is missing");
  const done = transcript(model([run("npm test")]), exited(1, "FAIL src/a.test.js"));
  assert.match(step({}, first.state, { now: NOW + 30_000, env: {}, transcript: done }).note, /a command just failed/);
});

test("other tools and other MCP servers are not Myrmo's business, and damaged lines are skipped", () => {
  const t = transcript(model([{ name: "view_file", args: { AbsolutePath: "/w/a" } }, { name: "call_mcp_tool", args: { ServerName: "github", ToolName: "x" } }]),
    result("file"), result("ok"));
  assert.deepEqual(events(readSteps(t + "\nnot json\n")), []);
  assert.equal(doneUntil(readSteps(t)), 3);
});

test("the hook off means no note, and the script answers {} when it has nothing to say", () => {
  const t = transcript(model([run("make")]), exited(2, "make: *** [all] Error 2"));
  assert.equal(step({}, {}, { now: NOW, env: { MYRMO_HOOK: "off" }, transcript: t }).note, null);
  const dir = mkdtempSync(join(tmpdir(), "myrmo-agy-"));
  const path = join(dir, "transcript_full.jsonl");
  writeFileSync(path, t);
  const config = join(dir, "config.json");
  writeFileSync(config, "{}");
  const call = (payload) => spawnSync(process.execPath, [join(root, "scripts", "antigravity-hook.mjs")], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, MYRMO_CONFIG: config, MYRMO_HOOK: "", MYRMO_HOOK_STATE_DIR: dir },
  });
  const payload = { conversationId: `c-${Date.now()}`, transcriptPath: path, invocationNum: 1, modelName: "gpt-oss-120b-medium" };
  const first = JSON.parse(call(payload).stdout);
  assert.match(first.injectSteps[0].ephemeralMessage, /a command just failed \(exit 2\)/);
  assert.deepEqual(JSON.parse(call(payload).stdout), {}, "the same steps, the next invocation: nothing");
  assert.deepEqual(JSON.parse(call({ conversationId: "x", transcriptPath: join(dir, "missing.jsonl") }).stdout), {});
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, "scripts", "antigravity-hook.mjs")], { input: "not json", encoding: "utf8" }).stdout), {});
});
