import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { failed, handle, promptOf } from "../scripts/gemini-hook.mjs";

const env = { MYRMO_WORKLOG: "1", MYRMO_WORKLOG_SCOPES: "*", MYRMO_URL: "http://colony.test:8080", MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1" };
const fresh = () => mkdtempSync(join(tmpdir(), "geminihook-"));
// The fields every Gemini CLI hook event carries, then the event's own.
const base = (event, extra = {}) => ({ session_id: "5f1c-77aa", transcript_path: "/tmp/t.json", cwd: "/work/proj", hook_event_name: event, timestamp: "2026-11-18T10:00:00Z", ...extra });
const before = (prompt) => base("BeforeAgent", { prompt });
const tool = (name, input, error) => base("AfterTool", { tool_name: name, tool_input: input, tool_response: { llmContent: "ok", returnDisplay: "ok", ...(error ? { error } : {}) } });
const after = (prompt, answer) => base("AfterAgent", { prompt, prompt_response: answer, stop_hook_active: false });

function deps(overrides = {}) {
  const sent = [];
  return { sent, deps: { env, settings: {}, dir: fresh(), poster: async (_t, path, body) => { sent.push({ path, body }); return { ok: true }; }, recall: async () => [], digest: async () => [], refresh: async () => {}, ...overrides } };
}

test("failed reads Gemini CLI's error field", () => {
  assert.equal(failed({ llmContent: "x" }), false);
  assert.equal(failed({ error: { message: "exit 1" } }), true);
  assert.equal(failed(undefined), false);
});

test("a request, its tools and its answer become one exchange", async () => {
  const { sent, deps: d } = deps();
  await handle(before("revisa el despliegue"), d);
  await handle(tool("run_shell_command", { command: "docker ps" }), d);
  await handle(tool("read_file", { absolute_path: "/work/proj/compose.yml" }), d);
  await handle(tool("run_shell_command", { command: "curl localhost" }, { message: "Command exited with code 7" }), d);
  assert.equal(sent.length, 0);
  await handle(after("revisa el despliegue", "El contenedor web está caído."), d);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/v1/worklog/exchanges");
  const body = sent[0].body;
  assert.equal(body.prompt, "revisa el despliegue");
  assert.equal(body.answer, "El contenedor web está caído.");
  assert.equal(body.session, "gemini-5f1c-77aa");
  assert.equal(body.repo, "proj");
  assert.match(body.activity, /run_shell_command: docker ps/);
  assert.match(body.activity, /read_file: \/work\/proj\/compose.yml/);
  assert.match(body.activity, /error: run_shell_command failed: Command exited with code 7/);
  // the state is gone: a retry of AfterAgent sends nothing
  await handle(after("revisa el despliegue", "otra"), d);
  assert.equal(sent.length, 1);
});

test("each turn of a session is its own exchange", async () => {
  const { sent, deps: d } = deps();
  await handle(before("primera"), d);
  await handle(after("primera", "uno"), d);
  await handle(before("segunda"), d);
  await handle(tool("glob", { pattern: "**/*.ts" }), d);
  await handle(after("segunda", "dos"), d);
  assert.deepEqual(sent.map((s) => s.body.prompt), ["primera", "segunda"]);
  assert.equal(sent[0].body.activity, "");
  assert.match(sent[1].body.activity, /glob: \*\*\/\*\.ts/);
});

test("a request marked private is never logged and asks the colony nothing", async () => {
  const { sent, deps: d } = deps({ recall: async () => { throw new Error("must not ask"); } });
  await handle(before("//privado mi problema"), d);
  await handle(tool("run_shell_command", { command: "ls" }), d);
  await handle(after("//privado mi problema", "respuesta"), d);
  assert.equal(sent.length, 0);
  assert.equal(readdirSync(d.dir).filter((f) => f.endsWith(".json")).length, 0);
});

test("nothing happens without MYRMO_WORKLOG=1", async () => {
  let calls = 0;
  const count = async () => { calls++; return []; };
  const { deps: d } = deps({ env: { ...env, MYRMO_WORKLOG: "0" }, poster: count, recall: count, digest: count });
  for (const e of [base("SessionStart", { source: "startup" }), before("arregla el build"), tool("run_shell_command", { command: "make" }), after("arregla el build", "hecho")]) {
    assert.equal(await handle(e, d), null);
  }
  assert.equal(calls, 0);
});

test("what colleagues did reaches the model when a session starts, not after a compaction", async () => {
  const matters = [{ matter: "deploy de pagos", people: ["ana"], last_at: new Date().toISOString(), kind: "decided", text: "se queda en el servidor nuevo" }];
  const { deps: d } = deps({ digest: async () => matters });
  const out = await handle(base("SessionStart", { source: "startup" }), d);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /deploy de pagos/);
  assert.equal(await handle(base("SessionStart", { source: "compress" }), d), null);
});

test("a task brings back what the work log knows about it", async () => {
  const events = [{ matter: "deploy de pagos", person: "ana", at: new Date().toISOString(), kind: "tried_failed", text: "el rollback con helm falló" }];
  const asked = [];
  const { deps: d } = deps({ recall: async (input, _t, task) => { asked.push(task); return events; } });
  const out = await handle(before("despliega el servicio de pagos en producción"), d);
  assert.ok(asked.length === 1);
  assert.equal(out.hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.match(out.hookSpecificOutput.additionalContext, /rollback con helm/);
});

test("a secret in the prompt or the answer is redacted before it leaves", async () => {
  const { sent, deps: d } = deps();
  await handle(before("usa password=Hunter2Hunter2 para entrar"), d);
  await handle(after("x", "Hecho con ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), d);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent[0].body), /Hunter2Hunter2|ghp_a{36}/);
});

test("a session start asks the colony what it is, so the hooks know which folders are covered", async () => {
  let asked = 0;
  const { deps: d } = deps({ refresh: async () => { asked++; } });
  await handle(base("SessionStart", { source: "startup" }), d);
  assert.equal(asked, 1);
  const off = deps({ env: { ...env, MYRMO_WORKLOG: "0" }, refresh: async () => { asked++; } });
  await handle(base("SessionStart", { source: "startup" }), off.deps);
  assert.equal(asked, 1, "not with the work log off");
});

test("the note a session start added in front of the prompt is not part of the request", async () => {
  assert.equal(promptOf("<hook_context>Myrmo: since this person's last session…\n&lt;myrmo_worklog_digest&gt;</hook_context>\n\ndespliega pagos"), "despliega pagos");
  const { sent, deps: d } = deps();
  await handle(before("<hook_context>Myrmo: digest</hook_context> arregla el build"), d);
  await handle(after("x", "hecho"), d);
  assert.equal(sent[0].body.prompt, "arregla el build");
});
