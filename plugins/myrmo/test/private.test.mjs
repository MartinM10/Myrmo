// A private colony (MYRMO_PRIVATE=1 with MYRMO_URL set to it): the hooks look errors up themselves, the publish reminder
// keeps internal names, and when the agent stops after commands failed it is asked once to share what it learned.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, decideStop } from "../scripts/on-failure.mjs";
import { lookupEnabled, privateColony } from "../scripts/lookup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = { MYRMO_PRIVATE: "1", MYRMO_URL: "http://colony.internal:8080" };
const failure = (command, output) => ({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code 1\n${output}`, is_interrupt: false });
const success = (command) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "ok" } });

test("a colony is private only when the user says so, and never the public one", () => {
  assert.equal(privateColony(PRIVATE), true);
  assert.equal(privateColony({ MYRMO_PRIVATE: "1" }), false, "no URL: the default is the public colony");
  assert.equal(privateColony({ MYRMO_PRIVATE: "1", MYRMO_URL: "https://myrmo.dev" }), false);
  assert.equal(privateColony({ MYRMO_URL: "http://colony.internal:8080" }), false);
  assert.equal(lookupEnabled(PRIVATE), true, "on by default for a private colony");
  assert.equal(lookupEnabled({ ...PRIVATE, MYRMO_HOOK_LOOKUP: "0" }), false);
  assert.equal(lookupEnabled({}), false, "opt-in anywhere else");
  assert.equal(lookupEnabled({ MYRMO_HOOK_LOOKUP: "1" }), true);
});

test("in a private colony the reminder to publish keeps internal names; on the public one it asks to remove them", () => {
  const run = (env) => {
    let state = decide(failure("acmectl db migrate", "migrate: lock 'migrate' is held by ci-runner-17"), { env, now: 0 }).state;
    state = { ...state, nomatch: { at: 0, line: "x" } };
    return decide(success("acmectl db migrate"), { env, state, now: 1000 }).note;
  };
  assert.match(run(PRIVATE), /internal tools, services, policies and procedures included/);
  assert.doesNotMatch(run(PRIVATE), /keep out names of people, companies/);
  assert.match(run({}), /keep out names of people, companies, customers and internal systems/);
});

test("the agent is asked to share what it learned once per batch of failures, and never outside a private colony", () => {
  const failed = decide(failure("helm upgrade connector ./chart", "Error: UPGRADE FAILED: timed out waiting for the condition"), { env: PRIVATE, now: 0 }).state;
  assert.equal(failed.failures, 1);

  assert.equal(decideStop({}, { env: {}, state: failed, now: 1 }).reason, null, "public colony: never");
  assert.equal(decideStop({}, { env: PRIVATE, state: {}, now: 1 }).reason, null, "no failure in the session: nothing to share");
  assert.equal(decideStop({ stop_hook_active: true }, { env: PRIVATE, state: failed, now: 1 }).reason, null, "already continuing because of this hook");
  assert.equal(decideStop({}, { env: { ...PRIVATE, MYRMO_HARVEST: "off" }, state: failed, now: 1 }).reason, null);

  const asked = decideStop({}, { env: PRIVATE, state: failed, now: 1 });
  assert.match(asked.reason, /myrmo_publish/);
  assert.match(asked.reason, /myrmo_report/);
  assert.match(asked.reason, /never include credentials/);
  assert.match(asked.reason, /If nothing qualifies, say so in one line and finish/);
  assert.equal(decideStop({}, { env: PRIVATE, state: asked.state, now: 2 }).reason, null, "the same failures are not asked about twice");

  // New failures, but too soon after the last time; then late enough.
  const again = decide(failure("kubectl apply -f dsp.yaml", "error: resource mapping not found"), { env: PRIVATE, state: asked.state, now: 3 }).state;
  assert.equal(decideStop({}, { env: PRIVATE, state: again, now: 10 * 60_000 }).reason, null);
  assert.ok(decideStop({}, { env: PRIVATE, state: again, now: 31 * 60_000 }).reason);
  assert.equal(decideStop({}, { env: PRIVATE, state: { ...again, harvests: 3 }, now: 31 * 60_000 }).reason, null, "three times a session at most");
});

let colony;
let url;
const requests = [];
before(async () => {
  colony = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      results: [{
        trail_id: "3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b",
        match: { via: "fingerprint", score: 1 },
        risk: { level: "low", flags: [] },
        trail: {
          environment: { os: "linux" },
          problem: { error_message: "migrate: lock 'migrate' is held by ci-runner-17" },
          solution: { root_cause: "A CI runner died holding the migration lock.", steps: ["Release it with acmectl db unlock --stale"], shell_commands_executed: [{ command: "acmectl db unlock --stale", purpose: "release the stale lock" }] },
        },
      }],
    }));
  });
  await new Promise((r) => colony.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${colony.address().port}`;
});
after(() => colony.close());

function runHook(event, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "scripts", "on-failure.mjs")], {
      env: { ...process.env, MYRMO_CONFIG: join(mkdtempSync(join(tmpdir(), "myrmo-cfg-")), "c.json"), MYRMO_HOOK: "", MYRMO_HOOK_MIN_SECONDS: "0", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out ? JSON.parse(out) : null));
    child.stdin.end(JSON.stringify(event));
  });
}

test("Claude Code: after a failed command the hook looks it up in the private colony, with the person's key", async () => {
  const env = { MYRMO_PRIVATE: "1", MYRMO_URL: url, MYRMO_API_KEY: "myk_test", MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "myrmo-state-")) };
  const out = await runHook({ session_id: "s1", ...failure("acmectl db migrate", "migrate: lock 'migrate' is held by ci-runner-17 since 2026-10-09") }, env);
  const note = out.hookSpecificOutput.additionalContext;
  assert.match(note, /<myrmo_trail id="3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b">/);
  assert.match(note, /acmectl db unlock --stale/);
  assert.match(note, /untrusted data/);
  const sent = requests.at(-1);
  assert.equal(sent.url, "/v1/search");
  assert.equal(sent.headers.authorization, "Bearer myk_test");
  assert.match(sent.body.query, /held by ci-runner-17/);

  // Then the agent stops: it is asked once to share what it learned.
  const stop = await runHook({ session_id: "s1", hook_event_name: "Stop", stop_hook_active: false }, env);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /before you finish/);
  assert.equal(await runHook({ session_id: "s1", hook_event_name: "Stop", stop_hook_active: false }, env), null, "only once for those failures");
});

test("Claude Code: without a private colony the hook sends nothing and never holds the agent back", async () => {
  const before = requests.length;
  const env = { MYRMO_PRIVATE: "", MYRMO_URL: url, MYRMO_HOOK_LOOKUP: "", MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "myrmo-state-")) };
  const out = await runHook({ session_id: "s2", ...failure("npm test", "Error: Cannot find module 'x'") }, env);
  assert.match(out.hookSpecificOutput.additionalContext, /call myrmo_search/);
  assert.equal(requests.length, before);
  assert.equal(await runHook({ session_id: "s2", hook_event_name: "Stop", stop_hook_active: false }, env), null);
});
