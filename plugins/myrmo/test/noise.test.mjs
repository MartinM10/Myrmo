// Fewer notes that ask nothing of the agent: answers that exit non-zero, looking around for files that are not there,
// knowledge already shown in the session, and sharing again what was already published.

import { test } from "node:test";
import assert from "node:assert/strict";
import { answered, decide, decideStop } from "../scripts/on-failure.mjs";
import { briefNote } from "../scripts/lookup.mjs";

const PRIVATE = { MYRMO_PRIVATE: "1", MYRMO_URL: "http://colony.internal:8080" };
const failure = (command, output, code = 1) => ({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code ${code}\n${output}`, is_interrupt: false });
const success = (command, stdout) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false } });
const published = { hook_event_name: "PostToolUse", tool_name: "mcp__plugin_myrmo_myrmo__myrmo_publish", tool_input: {}, tool_response: [{ type: "text", text: "Published." }] };

test("a command whose non-zero exit is its answer is not a failure, other exits of it still are", () => {
  const cases = [
    ["kubectl diff -f deploy/", 1, true],
    ["kubectl diff -f deploy/", 2, false],
    ["gh pr checks 183", 8, true],
    ["gh pr checks 183", 1, false],
    ["cd infra && tofu plan -detailed-exitcode", 2, true],
    ["terraform plan", 2, false],
    ["systemctl is-active nginx", 3, true],
    ["npm test", 1, false],
    ["kubectl apply -f deploy/ && kubectl diff -f deploy/", 1, false],
    ["cd app && mvn test | grep FAIL", 1, false],
  ];
  for (const [command, code, expected] of cases) assert.equal(answered(command, code), expected, `${command} (${code})`);
  assert.equal(decide(failure("kubectl diff -f deploy/", "diff -u -N /tmp/LIVE/x /tmp/MERGED/x", 1), { env: {}, now: 0 }).note, null);
  assert.match(decide(failure("kubectl diff -f deploy/", "error: the server doesn't have a resource type", 2), { env: {}, now: 0 }).note, /a command just failed/);
});

test("looking for a file that is not there inside a pipeline is an answer, a missing command is not", () => {
  const listing = success("ls; ls Makefile* 2>&1 | head", "README.md\nls: cannot access 'Makefile*': No such file or directory");
  assert.equal(decide(listing, { env: {}, now: 0 }).note, null);
  const missing = success("deploy.sh 2>&1 | tail -5", "bash: deploy.sh: command not found");
  assert.match(decide(missing, { env: {}, now: 0 }).note, /an earlier stage could not run/);
  const copy = success("cp build/app.tar /srv/ 2>&1 | tail -1", "cp: cannot stat 'build/app.tar': No such file or directory");
  assert.match(decide(copy, { env: {}, now: 0 }).note, /an earlier stage could not run/, "a command that does work and finds nothing is still worth saying");
});

test("after the agent published, stopping does not ask it to share again", () => {
  const failed = decide(failure("helm upgrade app ./chart", "Error: UPGRADE FAILED: timed out waiting for the condition"), { env: PRIVATE, now: 0 }).state;
  assert.ok(decideStop({}, { env: PRIVATE, state: failed, now: 1 }).reason, "a failure and nothing shared: ask once");
  const after = decide(published, { env: PRIVATE, state: failed, now: 2 }).state;
  assert.equal(decideStop({}, { env: PRIVATE, state: after, now: 3 }).reason, null);
  const again = decide(failure("helm upgrade app ./chart", "Error: another failure"), { env: PRIVATE, state: after, now: 4 }).state;
  assert.ok(decideStop({}, { env: PRIVATE, state: again, now: 5 }).reason, "a failure after the publication is new");
});

test("stopping asks for reports only on the knowledge the agent relied on", () => {
  const state = { brief: { at: 0, ids: ["0b5e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"], reported: false } };
  const reason = decideStop({}, { env: PRIVATE, state, now: 1 }).reason;
  assert.match(reason, /each entry you actually relied on/);
  assert.match(reason, /skip the ones you did not use/);
  assert.doesNotMatch(reason, /not_applicable for the others/);
});

test("knowledge already shown in the session is not shown again", () => {
  const hit = (id, summary) => ({ trail_id: id, kind: "procedure", strength: 0.4, outcomes: {}, trail: { problem: { summary } } });
  const A = "0b5e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
  const B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
  const first = briefNote("rotate the database password", { results: [hit(A, "Rotate the database password")] }, {}, 1);
  assert.match(first.note, new RegExp(A));
  const second = briefNote("now restart the workers", { results: [hit(A, "Rotate the database password")] }, first.state, 2);
  assert.equal(second.note, null, "the same entry on the next prompt is not repeated");
  const third = briefNote("and update the proxy", { results: [hit(A, "Rotate the database password"), hit(B, "Update the proxy")] }, second.state, 3);
  assert.match(third.note, new RegExp(B));
  assert.doesNotMatch(third.note, new RegExp(A));
});
