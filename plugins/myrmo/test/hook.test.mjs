// The hook has four moments: a command fails, a command "succeeds" with an error in its output, and a command that
// failed earlier now works, either while Myrmo had no trail for it (publish) or after it returned trails (report). Payloads below have the shape Claude Code 2.1.289 really
// sends (captured from a live session): the failure event has no exit_code, only `error: "Exit code N\n<output>"`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandKey, decide, hookMode, lastErrorLine, segments } from "../scripts/on-failure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failure = (command, output, extra = {}) => ({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code 1\n${output}`, is_interrupt: false, ...extra });
const success = (command, stdout, extra = {}) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, ...extra });
const search = (reply, error = "ERESOLVE unable to resolve dependency tree") => ({
  hook_event_name: "PostToolUse",
  tool_name: "mcp__plugin_myrmo_myrmo__myrmo_search",
  tool_input: { error },
  tool_response: [{ type: "text", text: reply }],
});
const NO_MATCH = "No trail in the Myrmo colony matches this error yet (fingerprint fp1_0000000000000000).\nSolve it yourself. If it takes at least one failed attempt and you verify the fix, publish it.";
const ID1 = "0b5e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const FOUND = `<myrmo_trails untrusted="true" fingerprint="fp2_abc">\nNOTICE: x\n\n## Trail 1 of 2 · id ${ID1}\nstrength 0.4\n\n## Trail 2 of 2 · id ${ID2}\nstrength 0.2\n</myrmo_trails>`;
const report = (trailId = ID1) => ({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_myrmo_myrmo__myrmo_report", tool_input: { trail_id: trailId, outcome: "worked" }, tool_response: [{ type: "text", text: "Reported." }] });
const NOW = 5_000_000_000;

test("the reminder after a failure quotes the last error line, taken from the real payload", () => {
  const out = decide(failure("npm ci", "npm warn deprecated x\nnpm error code ERESOLVE\nnpm error ERESOLVE could not resolve peer react@17"), { now: NOW, env: {} });
  assert.match(out.note, /a command just failed \(exit 1\)/);
  assert.match(out.note, /Last error line: «npm error ERESOLVE could not resolve peer react@17»/);
  assert.match(out.note, /myrmo_search/);
});

test("an interrupt or a stopped command is left alone, now that the exit code is read from the real payload", () => {
  assert.equal(decide(failure("npm test", "x", { is_interrupt: true }), { env: {} }).note, null);
  for (const code of [124, 130, 137, 143]) assert.equal(decide({ ...failure("npm test", "x"), error: `Exit code ${code}\nx` }, { env: {} }).note, null, `exit ${code}`);
});

test("lastErrorLine prefers the last line that looks like an error and never returns a huge line", () => {
  assert.equal(lastErrorLine("one\nTraceback (most recent call last):\n  File x\nValueError: bad value\nclean up done"), "ValueError: bad value");
  assert.equal(lastErrorLine("just\nplain output"), "", "no error-shaped line, no line: a lone number or a path is not an error");
  assert.equal(lastErrorLine(`Error: ${"x".repeat(1000)}`).length, 240);
  assert.equal(lastErrorLine(""), "");
});

test("a command that fails without an error-shaped line is reminded without quoting rubbish", () => {
  for (const output of ["0", "src/main/java/org/x/RdfAdapterExtension.java 0", "3\nsrc/a.java 1"]) {
    const out = decide(failure("cd /srv/app && ./check.sh", output), { now: NOW, env: {} });
    assert.match(out.note, /a command just failed \(exit 1\)/, output);
    assert.doesNotMatch(out.note, /Last error line/, output);
  }
});

test("for a failed command, the shapes of build tools are errors too, and 'more help' lines are not", () => {
  const maven = "[INFO] BUILD FAILURE\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile on project app: Compilation failure\n[ERROR] -> [Help 1]\n[ERROR]\n[ERROR] Re-run Maven using the -X switch to enable full debug logging.\n[ERROR] For more information about the errors and possible solutions, please read the following articles:";
  assert.match(lastErrorLine(maven, { loose: true }), /^\[ERROR\] Failed to execute goal/);
  assert.equal(lastErrorLine("make[1]: *** [all] Error 2\nmake: Leaving directory", { loose: true }), "make[1]: *** [all] Error 2");
  assert.equal(lastErrorLine("FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed in 0.3s", { loose: true }), "FAILED tests/test_a.py::test_x - assert 1 == 2");
  assert.equal(lastErrorLine(maven), "", "on exit 0 these shapes are not trusted");
  const out = decide(failure("cd app && mvn -q test", maven), { now: NOW, env: {} });
  assert.match(out.note, /Last error line: «\[ERROR\] Failed to execute goal/);
});

test("an error hidden by a pipe is noticed: exit 0, but the output ends with an error", () => {
  const outputs = [
    "psql: error: connection to server at \"10.0.0.5\", port 5432 failed: FATAL: password authentication failed",
    "Traceback (most recent call last):\n  File \"app.py\", line 3\nValueError: bad value",
    "ERROR:  relation \"users\" does not exist",
    "ModuleNotFoundError: No module named 'yaml'",
    "error[E0382]: borrow of moved value: `label`",
    "command terminated with exit code 1",
    "npm ERR! code E404",
    "java.lang.NullPointerException: Cannot invoke \"x\"",
  ];
  for (const out of outputs) {
    const r = decide(success("kubectl exec -n db pod -- psql -c 'select 1' | tail -1", out), { now: NOW, env: {} });
    assert.match(r.note ?? "", /finished with exit 0, but its output ends with what looks like an error/, out);
    assert.match(r.note, /A pipe, a loop or `\|\| true` can hide the exit code/);
  }
});

test("ordinary output that merely mentions errors is not mistaken for one", () => {
  for (const out of ["Compiled successfully", '{"error": null}', "0 errors, 0 warnings", "All 87 tests passed", "no error found in the logs", "Handled the Exception gracefully", "Retrying after a transient error\nok"]) {
    assert.equal(decide(success("npm run build", out), { now: NOW, env: {} }).note, null, out);
  }
});

test("reading logs or files is not a failure, whatever they contain", () => {
  for (const command of ["docker logs api", "docker compose logs web", "kubectl logs pod-1", "cat app.log", "grep -r ERROR .", "tail -n 50 x.log", "git log --oneline", "journalctl -u svc"]) {
    assert.equal(decide(success(command, "ERROR: something from the log"), { now: NOW, env: {} }).note, null, command);
  }
});

test("a probe stays a probe behind cd, env, loops and pipes, but a real command next to it does not", () => {
  const quiet = ["cd /srv/app && grep -c Foo src/*.java", "cd app; grep -rn Bar . | wc -l", "for f in a b; do grep -c x $f; done", "export X=1 && cat app.log | tail -5", "FOO=1 git show HEAD:README.md", "cd 'my dir' && git diff --stat 2>&1"];
  for (const command of quiet) {
    assert.equal(decide(failure(command, "0"), { now: NOW, env: {} }).note, null, `failure: ${command}`);
    assert.equal(decide(success(command, "ERROR: from a log"), { now: NOW, env: {} }).note, null, `exit 0: ${command}`);
  }
  for (const command of ["cd /srv/app && grep -q x f && mvn test", "cd app && mvn test | grep FAIL", "grep x f; npm ci"]) {
    assert.ok(decide(failure(command, "Error: boom"), { now: NOW, env: {} }).note, command);
  }
});

test("the PowerShell tool is covered the same way", () => {
  const out = decide(success("python app.py", "ModuleNotFoundError: No module named 'x'", { tool_name: "PowerShell" }), { now: NOW, env: {} });
  assert.match(out.note, /finished with exit 0/);
});

test("hook 'failures' keeps only the reminder after a failed command", () => {
  const settings = { hook: "failures" };
  assert.match(decide(failure("npm ci", "Error: boom"), { now: NOW, env: {}, settings }).note ?? "", /just failed/);
  assert.equal(decide(success("npm ci", "ERROR: boom"), { now: NOW, env: {}, settings }).note, null);
  assert.equal(hookMode({ MYRMO_HOOK: "failures" }, {}), "failures");
  assert.equal(hookMode({}, { hook: "off" }), "off");
  assert.equal(hookMode({ MYRMO_HOOK: "on" }, { hook: "off" }), "on", "the environment wins over the file");
  assert.equal(hookMode({}, {}), "on");
  assert.equal(hookMode({ MYRMO_HOOK: "nonsense" }, {}), "on");
});

test("the same error is reminded once, even when its numbers change", () => {
  let state = {};
  const env = { MYRMO_HOOK_MIN_SECONDS: "1" };
  let r = decide(failure("psql", "psql: error: connection to port 5432 failed"), { now: NOW, state, env });
  assert.ok(r.note);
  state = r.state;
  r = decide(failure("psql", "psql: error: connection to port 5433 failed"), { now: NOW + 60_000, state, env });
  assert.equal(r.note, null, "only the port differs");
  r = decide(failure("psql", "psql: error: database \"x\" does not exist"), { now: NOW + 120_000, state: r.state, env });
  assert.ok(r.note, "a different error is a new reminder");
});

test("by default reminders are 20 seconds apart and 30 per session", () => {
  let state = {};
  let r = decide(failure("make", "Error: a"), { now: NOW, state, env: {} });
  assert.ok(r.note);
  state = r.state;
  assert.equal(decide(failure("make", "Error: b"), { now: NOW + 15_000, state, env: {} }).note, null);
  assert.ok(decide(failure("make", "Error: b"), { now: NOW + 25_000, state, env: {} }).note);
  assert.equal(decide(failure("make", "Error: c"), { now: NOW + 99_000_000, state: { count: 30 }, env: {} }).note, null);
  assert.ok(decide(failure("make", "Error: c"), { now: NOW + 99_000_000, state: { count: 29 }, env: {} }).note);
});

test("a search is remembered but never produces a note", () => {
  const none = decide(search(NO_MATCH), { now: NOW, env: {} });
  assert.equal(none.note, null);
  assert.equal(none.state.nomatch.at, NOW);
  const found = decide(search(FOUND), { now: NOW, env: {}, state: none.state });
  assert.equal(found.state.nomatch, null, "a trail was found: nothing to publish");
  assert.equal(decide(search("Myrmo returned 502"), { now: NOW, env: {}, state: none.state }).state.nomatch.at, NOW, "an error reply changes nothing");
});

test("the fix is offered for publishing when the failed command works and Myrmo had nothing", () => {
  let r = decide(failure("npm install", "npm error code ERESOLVE"), { now: NOW, env: {} });
  r = decide(search(NO_MATCH), { now: NOW + 5_000, env: {}, state: r.state });
  const fixed = decide(success("npm install --legacy-peer-deps", "added 120 packages"), { now: NOW + 60_000, env: {}, state: r.state });
  assert.match(fixed.note, /the command that failed earlier now succeeds/);
  assert.match(fixed.note, /may be the first to solve it/);
  assert.match(fixed.note, /publish it with myrmo_publish/);
  assert.match(fixed.note, /the user sees exactly what would be sent and approves it/);
  assert.match(fixed.note, /at least one failed attempt/);
  assert.match(fixed.note, /not in this project's own code/);
  assert.match(fixed.note, /Skip it if the fix was obvious/);
  const again = decide(success("npm install --legacy-peer-deps", "up to date"), { now: NOW + 120_000, env: {}, state: fixed.state });
  assert.equal(again.note, null, "offered once");
});

test("the offer follows the configured minimum of failed attempts", () => {
  let r = decide(failure("pip install x", "Error: boom"), { now: NOW, env: {} });
  r = decide(search(NO_MATCH), { now: NOW + 1_000, env: {}, state: r.state });
  const fixed = decide(success("pip install x --upgrade", "ok"), { now: NOW + 30_000, env: {}, state: r.state, settings: { min_failed_attempts: 3 } });
  assert.match(fixed.note, /3 or more failed attempts/);
});

test("no offer when something else succeeded, a trail was found, it is stale, or the hook is on 'failures'", () => {
  const base = decide(search(NO_MATCH), { now: NOW + 1_000, env: {}, state: decide(failure("npm install", "Error: boom"), { now: NOW, env: {} }).state });
  const run = (event, options = {}) => decide(event, { now: NOW + 30_000, env: {}, state: base.state, ...options }).note;
  assert.equal(run(success("python app.py", "started")), null, "a different program");
  assert.equal(run(success("ls", "a b")), null, "a probe");
  assert.equal(run(success("npm install", "added"), { now: NOW + 46 * 60_000 }), null, "45 minutes later it is another task");
  assert.equal(run(success("npm install", "added"), { settings: { hook: "failures" } }), null);
  assert.equal(run(success("npm install", "added"), { env: { MYRMO_HOOK: "off" } }), null);
  const foundTrail = decide(search(FOUND), { now: NOW + 2_000, env: {}, state: base.state }).state;
  assert.doesNotMatch(decide(success("npm install", "added"), { now: NOW + 30_000, env: {}, state: foundTrail }).note ?? "", /myrmo_publish/, "a trail was found: report, not publish");
  assert.match(run(success("npm install", "added")) ?? "", /publish it with myrmo_publish/, "and the normal case still offers");
});

test("a search that found trails remembers their ids", () => {
  const r = decide(search(FOUND), { now: NOW, env: {} });
  assert.equal(r.note, null);
  assert.deepEqual(r.state.found, { at: NOW, ids: [ID1, ID2] });
});

test("the agent is asked to report when the failed command works after Myrmo returned trails", () => {
  let r = decide(failure("npm install", "npm error code ERESOLVE"), { now: NOW, env: {} });
  r = decide(search(FOUND), { now: NOW + 5_000, env: {}, state: r.state });
  const fixed = decide(success("npm install --legacy-peer-deps", "added 120 packages"), { now: NOW + 60_000, env: {}, state: r.state });
  assert.match(fixed.note, /Myrmo had returned trails for that error/);
  assert.ok(fixed.note.includes(`${ID1}, ${ID2}`), "quotes the trail ids");
  assert.match(fixed.note, /myrmo_report/);
  assert.match(fixed.note, /worked .* partially_worked .* failed .* not_applicable/);
  assert.doesNotMatch(fixed.note, /myrmo_publish/, "a trail existed: nothing to publish");
  assert.equal(decide(success("npm install", "up to date"), { now: NOW + 90_000, env: {}, state: fixed.state }).note, null, "asked once");
});

test("no reminder to report once the agent reported, for another command, when stale or when the hook is quiet", () => {
  let base = decide(failure("pytest", "FAILED tests/test_a.py::test_x"), { now: NOW, env: {} });
  base = decide(search(FOUND), { now: NOW + 1_000, env: {}, state: base.state });
  const run = (event, options = {}) => decide(event, { now: NOW + 30_000, env: {}, state: base.state, ...options }).note;
  const reported = decide(report(), { now: NOW + 20_000, env: {}, state: base.state });
  assert.equal(reported.note, null, "a report says nothing");
  assert.equal(reported.state.found, null);
  assert.equal(decide(success("pytest -q", "3 passed"), { now: NOW + 30_000, env: {}, state: reported.state }).note, null, "already reported");
  assert.equal(run(success("python app.py", "started")), null, "a different program");
  assert.equal(run(success("pytest", "3 passed"), { now: NOW + 46 * 60_000 }), null, "45 minutes later it is another task");
  assert.equal(run(success("pytest", "3 passed"), { settings: { hook: "failures" } }), null);
  assert.equal(run(success("pytest", "3 passed"), { state: { ...base.state, count: 30 } }), null, "the session's notes are spent");
  assert.match(run(success("pytest", "3 passed")) ?? "", /myrmo_report/, "and the normal case still asks");
});

test("a later search with no match replaces the trails to report on", () => {
  let r = decide(failure("make", "Error: a"), { now: NOW, env: {} });
  r = decide(search(FOUND), { now: NOW + 1_000, env: {}, state: r.state });
  r = decide(search(NO_MATCH), { now: NOW + 2_000, env: {}, state: r.state });
  const fixed = decide(success("make", "done"), { now: NOW + 30_000, env: {}, state: r.state });
  assert.match(fixed.note, /publish it with myrmo_publish/);
});

test("commandKey groups a command with its variations", () => {
  assert.equal(commandKey("npm install --legacy-peer-deps"), "npm install");
  assert.equal(commandKey("sudo NODE_ENV=test npm install x"), "npm install");
  assert.equal(commandKey("pip install -r requirements.txt"), "pip install");
  assert.equal(commandKey("make"), "make");
});

test("commandKey looks at the command that does the work, not at cd, flags or redirections", () => {
  assert.equal(commandKey("cd /srv/app && mvn -q test 2>&1 | tail -20"), "mvn test");
  assert.equal(commandKey("cd /srv/app && git show HEAD:x"), "git show");
  assert.equal(commandKey("export JAVA_HOME=/jdk; ./gradlew --no-daemon build"), "./gradlew build");
  assert.equal(commandKey("make > build.log 2>&1"), "make");
  assert.equal(commandKey("cd /srv/app"), "");
  assert.deepEqual(segments("a 'b && c' && d 2>&1 | e"), [["a", "b && c"], ["d", "2>&1"], ["e"]]);
});

test("a later command in the same directory is not taken for the one that failed", () => {
  let r = decide(failure("cd /srv/app && mvn -q test", "[ERROR] Failed to execute goal"), { now: NOW, env: {} });
  r = decide(search(NO_MATCH), { now: NOW + 5_000, env: {}, state: r.state });
  for (const command of ["cd /srv/app && git show HEAD~1 --stat", "cd /srv/app && git add -A", "cd /srv/app && python3 tools/x.py"]) {
    assert.equal(decide(success(command, "done"), { now: NOW + 60_000, env: {}, state: r.state }).note, null, command);
  }
  const fixed = decide(success("cd /srv/app && mvn -q -DskipITs test", "BUILD SUCCESS"), { now: NOW + 90_000, env: {}, state: r.state });
  assert.match(fixed.note, /the command that failed earlier now succeeds/, "the same task, with another flag, is the fix");
});

test("the manifest registers the hook for failures, for successful commands and for Myrmo searches", () => {
  const hooks = JSON.parse(readFileJson(join(root, "hooks", "hooks.json"))).hooks;
  assert.equal(hooks.PostToolUseFailure[0].matcher, "Bash|PowerShell");
  assert.deepEqual(hooks.PostToolUse.map((h) => h.matcher), ["Bash|PowerShell", "mcp__.*myrmo_(search|report)"]);
  const myrmo = new RegExp(`^(?:${hooks.PostToolUse[1].matcher})$`);
  assert.ok(myrmo.test("mcp__plugin_myrmo_myrmo__myrmo_search"), "the plugin's own tool name");
  assert.ok(myrmo.test("mcp__myrmo__myrmo_search"), "and a server added by hand");
  assert.ok(myrmo.test("mcp__plugin_myrmo_myrmo__myrmo_report"), "a report clears the reminder to report");
  assert.ok(!myrmo.test("mcp__plugin_myrmo_myrmo__myrmo_publish"), "not the other tools");
});

test("run as Claude Code runs it, across separate processes: failure, empty search, then the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-hook-flow-"));
  const config = join(dir, "config.json");
  writeFileSync(config, "{}");
  const session = `flow-test-${Date.now()}`;
  const run = (event) => {
    const r = spawnSync(process.execPath, [join(root, "scripts", "on-failure.mjs")], {
      input: JSON.stringify({ session_id: session, ...event }),
      encoding: "utf8",
      env: { ...process.env, MYRMO_CONFIG: config, MYRMO_HOOK: "", MYRMO_HOOK_MIN_SECONDS: "0" },
    });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const first = run(failure("terraform apply", "Error: Invalid provider configuration"));
  assert.equal(first.hookEventName, "PostToolUseFailure");
  assert.match(first.additionalContext, /Last error line: «Error: Invalid provider configuration»/);
  assert.equal(run(search(NO_MATCH, "Error: Invalid provider configuration")), null, "the search itself says nothing");
  const fix = run(success("terraform apply -refresh=false", "Apply complete! Resources: 1 added"));
  assert.equal(fix.hookEventName, "PostToolUse");
  assert.match(fix.additionalContext, /publish it with myrmo_publish/);
  assert.equal(run(success("terraform apply -refresh=false", "No changes")), null, "once");
});

function readFileJson(path) {
  return spawnSync(process.execPath, ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path)}, "utf8"))`], { encoding: "utf8" }).stdout;
}
