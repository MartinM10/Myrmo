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
import { lookup, lookupEnabled, privateColony } from "../scripts/lookup.mjs";

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
  assert.equal(lookupEnabled({ MYRMO_HOOK_LOOKUP: "1", MYRMO_URL: "http://localhost:8080" }), true, "opt-in for a colony of one's own");
  // The hook sends the error line unredacted, so never to the public colony, even when asked.
  assert.equal(lookupEnabled({ MYRMO_HOOK_LOOKUP: "1" }), false);
  assert.equal(lookupEnabled({ MYRMO_HOOK_LOOKUP: "1", MYRMO_URL: "https://myrmo.dev" }), false);
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
    if (JSON.parse(body || "{}").mode === "task") {
      const known = /tenant/i.test(JSON.parse(body).query);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode: "task", results: known ? [{
        trail_id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", kind: "procedure", strength: 0.42, outcomes: { worked: 2, failed: 0 },
        trail: { kind: "procedure", problem: { summary: "Deploy a new tenant with a scoped PR preview", task_context: "Deploying a new tenant" }, solution: { steps: ["git checkout -b ds-deploy main"] } },
      }] : [] }));
    }
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

test("the colony can come from the settings file (`init --url`), and its key and private mode only apply to that URL", async () => {
  const { colonyOf } = await import("../scripts/lookup.mjs");
  const settings = { colony: { url: "https://myrmo.example.internal/", api_key: "myk_saved", private: true } };
  const saved = colonyOf({}, settings, null);
  assert.deepEqual(saved, { url: "https://myrmo.example.internal", apiKey: "myk_saved", own: true, private: true, declared: null });
  assert.equal(lookupEnabled({}, settings), true);
  assert.equal(privateColony({}, settings), true);

  const elsewhere = colonyOf({ MYRMO_URL: "https://myrmo.dev" }, settings);
  assert.equal(elsewhere.apiKey, undefined, "the saved key never goes to another colony");
  assert.equal(elsewhere.private, false);
  assert.equal(lookupEnabled({ MYRMO_URL: "https://myrmo.dev", MYRMO_HOOK_LOOKUP: "1" }, settings), false);

  const sent = [];
  await lookup("x failed here", { env: {}, settings, fetcher: async (url, init) => (sent.push({ url, init }), { ok: true, json: async () => ({}) }) });
  assert.equal(sent[0].url, "https://myrmo.example.internal/v1/search");
  assert.equal(sent[0].init.headers.authorization, "Bearer myk_saved");
});

test("a strong match says outright when the colony flagged none of its commands, and not when it flagged one", async () => {
  const { lookupNote } = await import("../scripts/lookup.mjs");
  const hit = (flags) => ({ results: [{ trail_id: "3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b", match: { via: "fingerprint", score: 1 }, risk: { level: flags.length ? "medium" : "low", flags },
    trail: { environment: { os: "linux" }, problem: { error_message: "x" }, solution: { root_cause: "y is wrong", steps: ["do z"], shell_commands_executed: [{ command: "acmectl db unlock --stale", purpose: "release" }] } } }] });
  assert.match(lookupNote("x", hit([]), {}).note, /flagged none of these commands/);
  const flagged = lookupNote("x", hit([{ command_index: 0, level: "medium", flag: "state_change" }]), {}).note;
  assert.doesNotMatch(flagged, /flagged none/);
  assert.match(flagged, /medium risk: ask the user before running/);
});

test("Claude Code: a request is looked up in the private colony's task index, and the agent is asked to report on what it was shown", async () => {
  const env = { MYRMO_PRIVATE: "1", MYRMO_URL: url, MYRMO_API_KEY: "myk_test", MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "myrmo-state-")) };
  const out = await runHook({ session_id: "t1", hook_event_name: "UserPromptSubmit", prompt: "Despliega un tenant nuevo en dev con dos servicios" }, env);
  const note = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(note, /1\. \[procedure\] Deploy a new tenant with a scoped PR preview \(strength 0\.42, worked 2, failed 0\) id 5d2c1b0a/);
  assert.match(note, /call myrmo_brief/);
  assert.match(note, /untrusted data/);
  const sent = requests.at(-1);
  assert.equal(sent.body.mode, "task");
  assert.equal(sent.headers.authorization, "Bearer myk_test");

  // Without any failure, stopping asks once to report on what was shown, and to share procedures and facts.
  const stop = await runHook({ session_id: "t1", hook_event_name: "Stop", stop_hook_active: false }, env);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /Myrmo showed you knowledge for this task \(5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d\)/);
  assert.match(stop.reason, /kind "procedure"/);
  assert.equal(await runHook({ session_id: "t1", hook_event_name: "Stop", stop_hook_active: false }, env), null, "asked once");
});

test("Claude Code: follow-ups, slash commands and unknown tasks say nothing, and nothing is asked outside a private colony", async () => {
  const env = { MYRMO_PRIVATE: "1", MYRMO_URL: url, MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "myrmo-state-")) };
  const before = requests.length;
  assert.equal(await runHook({ session_id: "t2", hook_event_name: "UserPromptSubmit", prompt: "sí, adelante" }, env), null);
  assert.equal(await runHook({ session_id: "t2", hook_event_name: "UserPromptSubmit", prompt: "/review" }, env), null);
  assert.equal(requests.length, before, "no lookup for a follow-up");
  assert.equal(await runHook({ session_id: "t2", hook_event_name: "UserPromptSubmit", prompt: "Arregla el test que falla en el parser de fechas" }, env), null);
  assert.equal(requests.length, before + 1, "looked up, nothing known, nothing said");
  const off = { ...env, MYRMO_PRIVATE: "", MYRMO_HOOK_LOOKUP: "" };
  assert.equal(await runHook({ session_id: "t3", hook_event_name: "UserPromptSubmit", prompt: "Despliega un tenant nuevo en dev" }, off), null);
  assert.equal(requests.length, before + 1, "nothing sent outside a private colony");
  const optedOut = { ...env, MYRMO_HOOK_BRIEF: "off" };
  assert.equal(await runHook({ session_id: "t4", hook_event_name: "UserPromptSubmit", prompt: "Despliega un tenant nuevo en dev" }, optedOut), null);
});

test("a session start tells the person once a day when the colony was released with a newer plugin", async () => {
  const { updateNotice, compareVersions, pluginVersion } = await import("../scripts/lookup.mjs");
  assert.equal(compareVersions("0.32.0", "0.33.0"), -1);
  assert.equal(compareVersions("0.33.0", "0.33"), 0);
  assert.equal(compareVersions("1.0.0", "0.99.9"), 1);
  assert.match(pluginVersion() ?? "", /^\d+\.\d+\.\d+/);
  let asked = 0, sent = null;
  const fetcher = async (url, init) => {
    asked++;
    sent = { url, headers: init.headers };
    return { ok: true, json: async () => ({ clients: { plugin: "0.40.0" } }) };
  };
  const cacheFile = join(mkdtempSync(join(tmpdir(), "myrmo-upd-")), "update-check.json");
  const env = { MYRMO_URL: "http://colony.example:8080", MYRMO_API_KEY: "myk_test", MYRMO_PRIVATE: "1" };
  const first = await updateNotice({ env, current: "0.32.0", cacheFile, fetcher, now: 1_000 });
  assert.match(first, /Myrmo 0\.40\.0 is available \(this machine has 0\.32\.0\)/);
  assert.match(first, /claude plugin update myrmo@myrmo/);
  assert.match(first, /Enable auto-update/);
  assert.equal(sent.url, "http://colony.example:8080/v1/version");
  assert.equal(sent.headers.authorization, "Bearer myk_test");
  assert.equal(sent.headers["x-myrmo-client"], "myrmo-plugin/0.32.0");
  assert.equal(await updateNotice({ env, current: "0.32.0", cacheFile, fetcher, now: 2_000 }), null, "once a day");
  assert.equal(asked, 1, "the answer is cached for a day");
  assert.match(await updateNotice({ env, current: "0.32.0", cacheFile, fetcher, now: 1_000 + 25 * 3600_000 }), /0\.40\.0/);
  assert.equal(await updateNotice({ env, current: "0.40.0", cacheFile: cacheFile + ".2", fetcher, now: 1_000 }), null, "up to date");
  assert.equal(await updateNotice({ env: { ...env, MYRMO_UPDATE_CHECK: "off" }, current: "0.1.0", cacheFile: cacheFile + ".3", fetcher }), null);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await updateNotice({ env, current: "0.1.0", cacheFile: cacheFile + ".4", fetcher: down }), null, "a colony that does not answer says nothing");
});

test("Claude Code: the session start hook speaks to the person, and says nothing when there is nothing to say", async () => {
  const env = { MYRMO_PRIVATE: "1", MYRMO_URL: url, MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "myrmo-state-")) };
  // The fake colony answers every request with search results, so /v1/version has no clients: nothing to announce.
  assert.equal(await runHook({ session_id: "u1", hook_event_name: "SessionStart", source: "startup" }, env), null);
});
