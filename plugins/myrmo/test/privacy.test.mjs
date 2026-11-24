import { home } from "./home.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { step } from "../scripts/antigravity-hook.mjs";
import { applyPrompt, commandOf, inheritAfterClear, lastCommandIn, modes, privacyOf, sessionKey, setPrivate, toolKind, userLine, lookupQuestion } from "../scripts/privacy.mjs";

beforeEach(() => rmSync(join(home, ".myrmo"), { recursive: true, force: true }));
const a = sessionKey("claude", "aaaa-1");
const b = sessionKey("claude", "bbbb-2");
const pause = () => { mkdirSync(join(home, ".myrmo"), { recursive: true }); writeFileSync(join(home, ".myrmo", "worklog-paused"), ""); };

test("the commands a message may start with", () => {
  for (const p of ["//privado", "//privado mejora mi currículum", "  // private rewrite my cv", "//PRIVATE", "//privada: una nota", "<ide_opened_file>x</ide_opened_file>//privado qué tal", '<user_input mode="act">//privado</user_input>', "<USER_REQUEST>\n//privado x\n</USER_REQUEST>\n<ADDITIONAL_METADATA>y</ADDITIONAL_METADATA>"]) assert.equal(commandOf(p)?.kind, "private", p);
  for (const p of ["//compartir", "//share", "//Compartir sigue con esto", "<user_input>//share</user_input>"]) assert.equal(commandOf(p)?.kind, "share", p);
  for (const p of ["see https://private.example.com", "// a comment about private things", "private //privado", "//sharepoint is down", "// share the pool", "<pasted_content>//share</pasted_content>", "<task-notification>//share</task-notification>", "", undefined]) assert.equal(commandOf(p), null, String(p));
  assert.deepEqual(commandOf("//compartir sigue"), { kind: "share", lang: "es", rest: "sigue", bare: false });
  assert.equal(commandOf("//private").bare, true);
  assert.equal(commandOf("//private").lang, "en");
});

test("a session is private from the command until the other one, and only that session", () => {
  assert.equal(applyPrompt(a, "hola").private, false);
  const on = applyPrompt(a, "//privado");
  assert.deepEqual([on.private, on.changed, on.bare], [true, "private", true]);
  assert.equal(applyPrompt(a, "sin marca").private, true);
  assert.equal(applyPrompt(a, "//privado otra vez").changed, null);
  assert.equal(applyPrompt(b, "otra sesión").private, false);
  const off = applyPrompt(a, "//compartir sigue con el despliegue");
  assert.deepEqual([off.private, off.changed, off.prompt], [false, "share", "sigue con el despliegue"]);
  assert.equal(privacyOf(a).private, false);
});

test("a paused machine is private in every session, and //compartir says it still is", () => {
  pause();
  assert.equal(privacyOf(a).private, true);
  const state = applyPrompt(a, "//compartir");
  assert.equal(state.private, true);
  assert.match(userLine(state), /pausa/);
  assert.equal(privacyOf(b, { MYRMO_WORKLOG_PAUSE: "1" }).private, true);
});

test("private mode that cannot be kept is said, not silently lost", () => {
  writeFileSync(join(home, "blocker"), "");
  const env = { MYRMO_PRIVATE_DIR: join(home, "blocker", "private") };
  const state = applyPrompt(a, "//privado", { env });
  assert.equal(state.failed, true);
  assert.equal(state.private, true, "this message is not sent either way");
  assert.match(userLine(state), /no se ha podido/);
  assert.equal(applyPrompt(null, "//privado").failed, true, "no session id");
});

test("a private session's file that cannot be read still means private", () => {
  setPrivate(a, {});
  writeFileSync(join(home, ".myrmo", "private", `${a}.json`), "{damaged");
  assert.equal(privacyOf(a).private, true);
});

test("after /clear a session stays private in the folder of a private one, and nowhere else", () => {
  setPrivate(a, { cwd: "/work/x", lang: "es" });
  assert.equal(inheritAfterClear(b, "/work/y"), false);
  assert.equal(inheritAfterClear(b, "/work/x"), true);
  assert.equal(privacyOf(b).private, true);
  assert.equal(inheritAfterClear(sessionKey("claude", "c"), "/work/x", { now: Date.now() + 13 * 3_600_000 }), false);
});

test("the last command of a transcript, the blocked ones included", () => {
  const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const blocked = (text) => JSON.stringify({ type: "system", content: `UserPromptSubmit operation blocked by hook:\nx\n\nOriginal prompt: ${text}` });
  const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "//share" }, { type: "text", text: "//share" }] } });
  assert.equal(lastCommandIn([user("hola"), user("see https://x")].join("\n")), null);
  assert.equal(lastCommandIn([blocked("//privado"), user("sigue"), result].join("\n")).kind, "private");
  assert.equal(lastCommandIn([user("//privado x"), blocked("//compartir")].join("\n")).kind, "share");
  assert.deepEqual(modes(["a", "//privado", "b", "//share c", "d"]), [false, true, true, false, false]);
});

test("what each Myrmo tool is, under every agent's naming", () => {
  for (const n of ["mcp__myrmo__myrmo_search", "mcp__plugin_myrmo_myrmo__myrmo_brief", "myrmo__myrmo_matters", "mcp_myrmo_myrmo_matter"]) assert.equal(toolKind(n), "lookup", n);
  for (const n of ["mcp__plugin_myrmo_myrmo__myrmo_publish", "myrmo__myrmo_report", "mcp_myrmo_myrmo_something_new"]) assert.equal(toolKind(n), "send", n);
  for (const n of ["mcp__myrmo__myrmo_status", "mcp_myrmo_myrmo_publish_status", "myrmo__myrmo_withdraw"]) assert.equal(toolKind(n), "free", n);
  for (const n of ["Bash", "mcp__other__search", "", undefined]) assert.equal(toolKind(n), null, String(n));
});

test("a lookup's question promises no trace only where the colony says so", () => {
  for (const lang of ["es", "en"]) {
    assert.match(lookupQuestion({ lang }, { traceless: true }), /no guarda rastro|keeps no trace/);
    assert.doesNotMatch(lookupQuestion({ lang }), /no guarda rastro|keeps no trace/);
  }
});

test("Antigravity: nothing of a private part is looked up, before or after sharing again", () => {
  const steps = [];
  const add = (s) => steps.push({ ...s, step_index: steps.length });
  const fail = () => { add({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "make deploy" } }] }); add({ type: "GENERIC", content: "The command exited with code 2.\nOutput:\nmake: *** No rule to make target 'deploy'" }); };
  const run = (state = {}) => step({}, state, { env: {}, transcript: steps.map((s) => JSON.stringify(s)).join("\n") });
  add({ type: "USER_INPUT", content: "<USER_REQUEST>//privado despliega el servicio de facturación</USER_REQUEST>" });
  fail();
  const on = run();
  assert.deepEqual([on.failure, on.task], ["", ""]);
  assert.match(on.note, /private mode/);
  assert.equal(run(on.state).note, null, "said once per request");
  add({ type: "USER_INPUT", content: "<USER_REQUEST>//compartir</USER_REQUEST>" });
  const off = run(on.state);
  assert.deepEqual([off.failure, off.task], ["", ""]);
  assert.match(off.note, /turned private mode off/);
  add({ type: "USER_INPUT", content: "<USER_REQUEST>despliega el servicio de facturación</USER_REQUEST>" });
  assert.equal(run(off.state).task, "despliega el servicio de facturación");
  fail();
  assert.match(run(off.state).failure, /No rule to make target/);
});

// --- the Claude Code hook, as a process, against a colony that counts what reaches it ---------------------------------

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "on-failure.mjs");
let server;
let env;
const seen = [];
before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push(`${req.url} ${body}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [], trails: [], events: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  env = { ...process.env, MYRMO_URL: url, MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1", MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "privacy-state-")), MYRMO_CONFIG: join(home, "none.json"), MYRMO_UPDATE_CHECK: "off", MYRMO_HOOK_MIN_SECONDS: "0" };
});
after(() => server.close());
const hook = (hook_event_name, session_id, extra = {}) => new Promise((resolve) => {
  const child = spawn("node", [script], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", () => resolve(out ? JSON.parse(out) : null));
  child.stdin.end(JSON.stringify({ hook_event_name, session_id, cwd: "/work/x", ...extra }));
});
const prompt = (s, text) => hook("UserPromptSubmit", s, { prompt: text });
const failed = (s) => hook("PostToolUseFailure", s, { tool_name: "Bash", tool_input: { command: "make deploy" }, error: "Exit code 2\nmake: *** No rule to make target 'deploy'.  Stop." });

test("a private session sends nothing at all, a parallel one does, and sharing again starts from there", async () => {
  seen.length = 0;
  const on = await prompt("p1", "//privado");
  assert.equal(on.decision, "block", "the command alone costs no turn");
  assert.match(on.reason, /modo privado/);
  const next = await prompt("p1", "despliega el servicio de facturación en producción");
  assert.match(next.systemMessage, /sesión privada/);
  assert.match(next.hookSpecificOutput.additionalContext, /private mode/);
  assert.equal(await failed("p1"), null);
  assert.equal(await hook("PostToolUse", "p1", { tool_name: "Bash", tool_input: { command: "make deploy" }, tool_response: { stdout: "ok" } }), null);
  assert.equal(await hook("Stop", "p1", { last_assistant_message: "hecho" }), null);
  await hook("SessionStart", "p1", { source: "resume" });
  assert.deepEqual(seen, []);

  await failed("p2");
  assert.ok(seen.length > 0, "another session keeps working");
  seen.length = 0;
  const off = await prompt("p1", "//compartir despliega el servicio de facturación en producción");
  assert.match(off.systemMessage, /se vuelve a compartir/);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => !s.includes("//compartir")));
});

test("after //compartir the agent is told, with the next message, that the private part stays out of Myrmo", async () => {
  await prompt("p7", "//privado");
  assert.equal((await prompt("p7", "//compartir")).decision, "block");
  assert.match((await prompt("p7", "sigue")).hookSpecificOutput.additionalContext, /stays out of it for good/);
  assert.doesNotMatch(JSON.stringify(await prompt("p7", "sigue")), /stays out of it/, "once");
});

test("Myrmo's tools in a private session: what shares is denied, a lookup is asked and marked private", async () => {
  const call = (name, tool_input = {}) => hook("PreToolUse", "p3", { tool_name: name, tool_input });
  assert.equal(await call("mcp__myrmo__myrmo_publish"), null, "sharing: untouched");
  await prompt("p3", "//private");
  const denied = (await call("mcp__plugin_myrmo_myrmo__myrmo_publish")).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /session is private/);
  const asked = (await call("mcp__myrmo__myrmo_search", { error_message: "boom" })).hookSpecificOutput;
  assert.equal(asked.permissionDecision, "ask");
  assert.deepEqual(asked.updatedInput, { error_message: "boom", private: true });
  assert.equal(await call("mcp__myrmo__myrmo_status"), null);
  assert.equal(await call("Bash", { command: "ls" }), null);
});

test("the choice holds with the hook switched off, and a fork of a private session is private", async () => {
  env.MYRMO_HOOK = "off";
  try {
    await prompt("p4", "//privado");
    assert.equal((await hook("PreToolUse", "p4", { tool_name: "mcp__myrmo__myrmo_publish" })).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    delete env.MYRMO_HOOK;
  }
  const transcript_path = join(home, "fork.jsonl");
  writeFileSync(transcript_path, JSON.stringify({ type: "system", content: "UserPromptSubmit operation blocked by hook:\nx\n\nOriginal prompt: //privado" }));
  const fork = await hook("SessionStart", "p5", { source: "fork", transcript_path, cwd: "/other" });
  assert.match(fork.systemMessage, /sesión privada/);
  assert.equal((await hook("PreToolUse", "p5", { tool_name: "mcp__myrmo__myrmo_report" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(await hook("SessionStart", "p6", { source: "startup", cwd: "/work/x" }), null, "a new session shares");
});
