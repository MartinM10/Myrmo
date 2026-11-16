import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle, promptOf, toolLine } from "../scripts/cline-hook.mjs";

const env = { MYRMO_WORKLOG: "1", MYRMO_WORKLOG_SCOPES: "*", MYRMO_URL: "http://colony.test:8080", MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1" };
const fresh = () => mkdtempSync(join(tmpdir(), "clinehook-"));
const base = (hookName, extra = {}) => ({ hookName, taskId: "conv_1_abc", workspaceRoots: ["/work/proj"], ...extra });
const submit = (text) => base("UserPromptSubmit", { userPromptSubmit: { prompt: `<user_input mode="act">${text}</user_input>` } });
const tool = (name, parameters, success = true) => base("PostToolUse", { postToolUse: { toolName: name, parameters, result: "[object Object]", success } });
const done = (result) => base("TaskComplete", { taskComplete: { taskMetadata: { result } } });

test("promptOf unwraps what Cline wraps", () => {
  assert.equal(promptOf('<user_input mode="act">hola</user_input>'), "hola");
  assert.equal(promptOf("sin envoltorio"), "sin envoltorio");
});

test("toolLine reads Cline's command list", () => {
  assert.equal(toolLine("run_commands", { commands: '["pwd","ls -la"]' }), "run_commands: pwd ; ls -la");
});

test("a request, its tools and its answer become one exchange", async () => {
  const dir = fresh();
  const sent = [];
  const poster = async (_t, path, body) => { sent.push({ path, body }); return { ok: true }; };
  const deps = { env, settings: {}, dir, poster, recall: async () => [], digest: async () => [] };
  await handle(submit("revisa el despliegue"), deps);
  await handle(tool("run_commands", { commands: '["docker ps"]' }), deps);
  await handle(tool("run_commands", { commands: '["curl localhost"]' }, false), deps);
  assert.equal(sent.length, 0);
  await handle(done("El contenedor web está caído."), deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/v1/worklog/exchanges");
  assert.equal(sent[0].body.prompt, "revisa el despliegue");
  assert.equal(sent[0].body.answer, "El contenedor web está caído.");
  assert.match(sent[0].body.activity, /run_commands: docker ps/);
  assert.match(sent[0].body.activity, /error: run_commands failed/);
  assert.equal(sent[0].body.repo, "proj");
  // the state is gone: a second TaskComplete sends nothing
  await handle(done("otra"), deps);
  assert.equal(sent.length, 1);
});

test("a request marked private is never logged", async () => {
  const dir = fresh();
  const sent = [];
  const deps = { env, settings: {}, dir, poster: async (_t, _p, b) => { sent.push(b); return {}; }, recall: async () => { throw new Error("must not ask"); }, digest: async () => [] };
  await handle(submit("//privado mi problema"), deps);
  await handle(tool("run_commands", { commands: '["ls"]' }), deps);
  await handle(done("respuesta"), deps);
  assert.equal(sent.length, 0);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
});

test("nothing happens without MYRMO_WORKLOG=1", async () => {
  const dir = fresh();
  let calls = 0;
  const deps = { env: { ...env, MYRMO_WORKLOG: "0" }, settings: {}, dir, poster: async () => { calls++; return {}; }, recall: async () => { calls++; return []; }, digest: async () => { calls++; return []; } };
  assert.equal(await handle(submit("hola"), deps), null);
  await handle(done("x"), deps);
  assert.equal(calls, 0);
  assert.equal(readdirSync(dir).length, 0);
});

test("a request about a task gets what the team recorded, and the digest comes once per few hours", async () => {
  const dir = fresh();
  const event = { kind: "decision", person: "ana", at: new Date().toISOString(), matter: "despliegue", text: "se usa blue-green" };
  const deps = { env, settings: {}, dir, poster: async () => ({}), recall: async () => [event], digest: async () => [{ matter: "migración", people: ["ana"], last_at: new Date().toISOString(), text: "en curso", kind: "state" }] };
  const first = await handle(submit("despliega el servicio web en producción"), { ...deps, now: 1_000_000 });
  assert.match(first.contextModification, /blue-green/);
  assert.match(first.contextModification, /migración/);
  assert.equal(first.context, first.contextModification);
  const second = await handle(submit("despliega el servicio web en producción"), { ...deps, now: 1_000_000 + 60_000 });
  assert.match(second.contextModification, /blue-green/);
  assert.doesNotMatch(second.contextModification, /migración/);
  const later = await handle(submit("despliega el servicio web en producción"), { ...deps, now: 1_000_000 + 5 * 3_600_000 });
  assert.match(later.contextModification, /migración/);
});

test("TaskCancel drops what was kept", async () => {
  const dir = fresh();
  const deps = { env, settings: {}, dir, poster: async () => ({}), recall: async () => [], digest: async () => [] };
  await handle(submit("algo"), deps);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  await handle(base("TaskCancel"), deps);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
});
