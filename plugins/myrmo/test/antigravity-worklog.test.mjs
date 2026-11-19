import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callLine, handle, requestOf, turns } from "../scripts/antigravity-worklog.mjs";

const env = { MYRMO_WORKLOG: "1", MYRMO_WORKLOG_SCOPES: "*", MYRMO_URL: "http://colony.test:8080", MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1" };
const fresh = () => mkdtempSync(join(tmpdir(), "agyworklog-"));
const base = (event, extra = {}) => ({ hook_event_name: event, conversationId: "ec33-0cba", workspacePaths: ["/work/proj"], transcriptPath: "/nowhere/transcript.jsonl", modelName: "auto", ...extra });

// Steps shaped like Antigravity's transcript.jsonl.
let n = 0;
const user = (text) => ({ step_index: n++, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-19T10:00:00Z.\n</ADDITIONAL_METADATA>` });
const calls = (...c) => ({ step_index: n++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: c });
const result = (content, error) => ({ step_index: n++, source: "MODEL", type: "GENERIC", status: "DONE", content, ...(error ? { error } : {}) });
const says = (content) => ({ step_index: n++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content });
const run = (cmd) => ({ name: "run_command", args: { CommandLine: cmd, Cwd: "/work/proj", toolAction: "Running" } });
const jsonl = (steps) => steps.map((s) => JSON.stringify(s)).join("\n") + "\n";

function deps(overrides = {}) {
  const sent = [];
  return { sent, deps: { env, settings: {}, dir: fresh(), poster: async (_t, path, body) => { sent.push({ path, body }); return { ok: true }; }, recall: async () => [], digest: async () => [], refresh: async () => {}, ...overrides } };
}

test("the request is the text inside USER_REQUEST", () => {
  assert.equal(requestOf("<USER_REQUEST>\nrevisa el despliegue\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nhora\n</ADDITIONAL_METADATA>"), "revisa el despliegue");
  assert.equal(requestOf("sin envoltorio"), "sin envoltorio");
});

test("a tool call becomes one line with what it worked on", () => {
  assert.equal(callLine(run("docker ps")), "run_command: docker ps");
  assert.equal(callLine({ name: "view_file", args: { AbsolutePath: "/work/proj/compose.yml" } }), "view_file: /work/proj/compose.yml");
  assert.equal(callLine({ name: "call_mcp_tool", args: { ServerName: "myrmo", ToolName: "myrmo_search", Arguments: {} } }), "call_mcp_tool: myrmo myrmo_search");
});

test("a turn keeps its tools, their failures and the last thing the model said", () => {
  n = 0;
  const steps = [user("revisa el despliegue"), calls(run("docker ps"), run("curl localhost")), result("The command exited with code 0."), result("The command exited with code 7."),
    says("Lo miro…"), calls({ name: "replace_file_content", args: { TargetFile: "/work/proj/a.ts" } }), result("", "target content not found in file"), says("El contenedor web está caído.")];
  const [t] = turns(steps);
  assert.equal(t.request, "revisa el despliegue");
  assert.equal(t.answer, "El contenedor web está caído.");
  assert.deepEqual(t.tools, ["run_command: docker ps", "run_command: curl localhost", "error: run_command failed: exit code 7", "replace_file_content: /work/proj/a.ts", "error: replace_file_content failed: target content not found in file"]);
});

test("the turn is sent when the loop stops, once", async () => {
  n = 0;
  const steps = [user("revisa el despliegue"), calls(run("docker ps")), result("The command exited with code 0."), says("Todo en marcha.")];
  const { sent, deps: d } = deps({ transcript: jsonl(steps) });
  assert.equal(await handle(base("PreInvocation", { invocationNum: 2 }), d), null);
  assert.equal(sent.length, 0, "not while the turn runs");
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(sent[0].path, "/v1/worklog/exchanges");
  assert.equal(body.prompt, "revisa el despliegue");
  assert.equal(body.answer, "Todo en marcha.");
  assert.equal(body.session, "agy-ec33-0cba");
  assert.equal(body.repo, "proj");
  assert.match(body.activity, /run_command: docker ps/);
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.equal(sent.length, 1, "a second stop sends nothing again");
});

test("with work still running in the background the turn waits for the next request", async () => {
  n = 0;
  const first = [user("arranca el servidor"), calls(run("npm run dev")), result("Tool is running as a background task"), says("Arrancando.")];
  const { sent, deps: d } = deps({ transcript: jsonl(first) });
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: false }), d);
  assert.equal(sent.length, 0);
  d.transcript = jsonl([...first, says("Servidor en marcha en el puerto 3000."), user("ahora páralo")]);
  await handle(base("PreInvocation", { invocationNum: 1 }), d);
  assert.deepEqual(sent.map((s) => s.body.answer), ["Servidor en marcha en el puerto 3000."]);
});

test("each turn of a conversation is its own exchange, even if a stop was missed", async () => {
  n = 0;
  const steps = [user("primera"), says("uno"), user("segunda"), calls({ name: "list_dir", args: { DirectoryPath: "/work/proj/src" } }), result("a.ts"), says("dos")];
  const { sent, deps: d } = deps({ transcript: jsonl(steps) });
  await handle(base("SessionStart"), d);
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.deepEqual(sent.map((s) => s.body.prompt), ["primera", "segunda"]);
  assert.equal(sent[0].body.activity, "");
  assert.match(sent[1].body.activity, /list_dir: \/work\/proj\/src/);
});

test("a request marked private is never logged and asks the colony nothing", async () => {
  n = 0;
  const steps = [user("//privado mi problema"), calls(run("ls")), result("The command exited with code 0."), says("respuesta")];
  const { sent, deps: d } = deps({ transcript: jsonl(steps), recall: async () => { throw new Error("must not ask"); } });
  assert.equal(await handle(base("PreInvocation", { invocationNum: 1 }), d), null);
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.equal(sent.length, 0);
});

test("nothing happens without the work log on, or without a folder", async () => {
  n = 0;
  let calls = 0;
  const count = async () => { calls++; return []; };
  const steps = jsonl([user("arregla el build"), says("hecho")]);
  const off = deps({ env: { ...env, MYRMO_WORKLOG: "0" }, transcript: steps, poster: count, recall: count, digest: count });
  const none = deps({ transcript: steps, poster: count, recall: count, digest: count });
  for (const e of ["SessionStart", "PreInvocation", "Stop"]) {
    assert.equal(await handle(base(e, { fullyIdle: true }), off.deps), null);
    assert.equal(await handle(base(e, { fullyIdle: true, workspacePaths: [] }), none.deps), null);
  }
  assert.equal(calls, 0);
});

test("what colleagues did reaches the model when a conversation starts", async () => {
  const matters = [{ matter: "deploy de pagos", people: ["ana"], last_at: new Date().toISOString(), kind: "decided", text: "se queda en el servidor nuevo" }];
  let asked = 0;
  const { deps: d } = deps({ digest: async () => matters, refresh: async () => { asked++; } });
  const out = await handle(base("SessionStart"), d);
  assert.equal(asked, 1, "it asks the colony which folders are covered first");
  assert.match(out.injectSteps[0].ephemeralMessage, /deploy de pagos/);
});

test("a new request brings back what the work log knows about it, once", async () => {
  n = 0;
  const events = [{ matter: "deploy de pagos", person: "ana", at: new Date().toISOString(), kind: "tried_failed", text: "el rollback con helm falló" }];
  const asked = [];
  const { deps: d } = deps({ transcript: jsonl([user("despliega el servicio de pagos en producción")]), recall: async (_i, _t, task) => { asked.push(task); return events; } });
  const out = await handle(base("PreInvocation", { invocationNum: 1 }), d);
  assert.match(out.injectSteps[0].ephemeralMessage, /rollback con helm/);
  assert.equal(await handle(base("PreInvocation", { invocationNum: 2 }), d), null, "not again on the next call to the model");
  assert.equal(asked.length, 1);
});

test("a secret in the request or the answer is redacted before it leaves", async () => {
  n = 0;
  const { sent, deps: d } = deps({ transcript: jsonl([user("usa password=Hunter2Hunter2 para entrar"), says("Hecho con ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]) });
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent[0].body), /Hunter2Hunter2|ghp_a{36}/);
});

test("a conversation that was already open when the hook arrived sends only the turn in course", async () => {
  n = 0;
  const steps = [user("antigua"), says("de antes"), user("otra antigua"), says("también"), user("la de ahora"), says("hecho")];
  const { sent, deps: d } = deps({ transcript: jsonl(steps), recall: async () => { throw new Error("old requests are not looked up"); } });
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.deepEqual(sent.map((s) => s.body.prompt), ["la de ahora"]);
  d.transcript = jsonl([...steps, user("siguiente"), says("vale")]);
  await handle(base("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }), d);
  assert.deepEqual(sent.map((s) => s.body.prompt), ["la de ahora", "siguiente"]);
});
