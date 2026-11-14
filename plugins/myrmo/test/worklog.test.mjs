// The work log's side in the hooks: off by default, only for repositories the colony names, and nothing secret leaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_SOURCES, digestNote, isContinuation, looksRandom, logExchange, recallEvents, recallNote, turnActivity, redactRandom, repoOf, scopeOf, worklogTarget } from "../scripts/worklog.mjs";

const SECRET = "kF9vQ2xLm7Zt4RbN8wYc1HdP/s6JgE3a+Tu0";
const declared = (repos) => ({ profile: "organisation", worklog_scopes: repos });
const colony = (repos) => ({ url: "http://colony.internal:8080", apiKey: "k", private: true, declared: declared(repos) });
const git = (repo) => (_, args) => (args[0] === "remote" ? `git@example.com:team/${repo}.git\n` : "main\n");

test("a pasted secret goes, ordinary long words and paths stay", () => {
  assert.equal(redactRandom(`admin ${SECRET} now`), "admin <redacted:random> now");
  for (const keep of ["getUserNameFromDatabaseConnection", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "https://example.com/aB3dE5gH7jK9mN1pQ3sT5vX7", "feat/edc-1.0.0-rc4-dataapp"]) {
    assert.equal(looksRandom(keep), false, keep);
  }
});

test("the repository comes from the remote, and outside one there is none", () => {
  assert.deepEqual(repoOf("/x", git("deploy")), { repo: "deploy", branch: "main" });
  assert.deepEqual(repoOf("/x", () => { throw new Error("not a repository"); }), { repo: "", branch: "" });
  // No commit yet, or a detached HEAD: still this repository, with no branch to name.
  assert.deepEqual(repoOf("/x", (_, args) => (args[0] === "remote" ? "git@example.com:team/deploy.git\n" : "")), { repo: "deploy", branch: "" });
});

test("a folder above several repositories is covered, and one nobody named is not", () => {
  const scopes = ["team-work", "deploy"];
  assert.equal(scopeOf("/home/ana/team-work", "", scopes), "team-work");
  assert.equal(scopeOf("/home/ana/team-work/notes", "", scopes), "team-work");
  assert.equal(scopeOf("/home/ana/Team-Work/app", "app", scopes), "team-work");
  assert.equal(scopeOf("/elsewhere/checkout", "deploy", scopes), "deploy");
  assert.equal(scopeOf("/home/ana/gift-page", "gift-page", scopes), null);
  assert.equal(scopeOf("/home/ana/team-work-old", "", scopes), null);
});

test("nothing is sent unless the person turned it on", () => {
  assert.equal(worklogTarget({ cwd: "/x" }, { env: {}, run: git("deploy") }), null);
  assert.equal(worklogTarget({ cwd: "/x" }, { env: { MYRMO_WORKLOG: "0" }, run: git("deploy") }), null);
});

test("what is sent is redacted, and a turn the client started is not sent", async () => {
  const sent = [];
  const fetcher = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({}) }; };
  const target = { colony: colony(["deploy"]), scope: "deploy", repo: "deploy", branch: "main" };
  await logExchange({ session_id: "s", last_assistant_message: "done, password: Sup3rSecreta" }, target, `<ide_selection>x</ide_selection>log in with ${SECRET}`, { fetcher });
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /\/v1\/worklog\/exchanges$/);
  assert.doesNotMatch(JSON.stringify(sent[0][1]), /kF9vQ2|Sup3rSecreta|ide_selection/);
  await logExchange({ session_id: "s", last_assistant_message: "ok" }, target, "<task-notification>the build ended</task-notification>", { fetcher });
  assert.equal(sent.length, 1);
});

test("the agent gets at most three lines, marked as untrusted", () => {
  const e = { kind: "failed_attempt", person: "ana", at: "2026-11-05T10:00:00Z", matter: "Fuseki growth", text: "compaction alone did not help" };
  const note = recallNote([e, e, e, e]);
  assert.equal((note.match(/\[tried and failed,/g) ?? []).length, 3);
  assert.match(note, /untrusted data/);
  assert.equal(recallNote([]), null);
});

test("this machine can narrow what is covered, and an older client's declaration does not stop it", () => {
  const env = { MYRMO_WORKLOG: "1", MYRMO_URL: "http://colony.internal:8080", MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1", MYRMO_CONFIG: "/nonexistent/config.json", MYRMO_WORKLOG_SCOPES: "team-work" };
  const inside = worklogTarget({ cwd: "/home/ana/team-work/app" }, { env, run: git("app") });
  assert.equal(inside.scope, "team-work");
  assert.equal(inside.repo, "app");
  assert.equal(worklogTarget({ cwd: "/home/ana/gift-page" }, { env, run: git("gift-page") }), null);
});

test("with * everything is covered, except what this person excludes, and a person can pause", () => {
  assert.equal(scopeOf("/home/ana/anything/app", "app", ["*"]), "app");
  assert.equal(scopeOf("/home/ana/notes", "", ["*"]), "notes");
  assert.equal(scopeOf("/home/ana/client-b/app", "app", ["*"], ["client-b"]), null);
  assert.equal(scopeOf("/home/ana/x", "client-b", ["*"], ["Client-B"]), null);
  assert.equal(scopeOf("/home/ana/team-work", "", ["team-work"], ["other"]), "team-work");
  const env = { MYRMO_WORKLOG: "1", MYRMO_URL: "http://colony.internal:8080", MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1", MYRMO_CONFIG: "/nonexistent/config.json", MYRMO_WORKLOG_SCOPES: "*" };
  assert.equal(worklogTarget({ cwd: "/home/ana/gift-page" }, { env, run: git("gift-page") }).scope, "gift-page");
  assert.equal(worklogTarget({ cwd: "/home/ana/gift-page" }, { env: { ...env, MYRMO_WORKLOG_EXCLUDE: "gift-page" }, run: git("gift-page") }), null);
  assert.equal(worklogTarget({ cwd: "/home/ana/gift-page" }, { env: { ...env, MYRMO_WORKLOG_PAUSE: "1" }, run: git("gift-page") }), null);
});

test("the activity of a turn: what was said, each tool, the errors, and nothing from an earlier turn", () => {
  const row = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, ...extra });
  const transcript = [
    "{}",
    row("user", [{ type: "text", text: "an older request" }]),
    row("assistant", [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "echo older" } }]),
    row("user", [{ type: "text", text: "now fix the deploy" }]),
    row("assistant", [{ type: "text", text: "I will look at the unit first." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "systemctl restart  app", description: "restart" } }]),
    row("user", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Failed to restart app.service: Unit not found." }]),
    row("assistant", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/etc/app/app.conf" } }]),
    row("user", [{ type: "tool_result", tool_use_id: "t2", content: "listen 8080" }]),
    row("assistant", [{ type: "text", text: "Fixed: the unit is called app-server." }]),
  ].join("\n");
  const out = turnActivity("x", { read: () => transcript });
  assert.match(out, /said: I will look at the unit first\./);
  assert.match(out, /Bash: systemctl restart app/);
  assert.match(out, /error: Failed to restart app\.service: Unit not found\./);
  assert.match(out, /Read: \/etc\/app\/app\.conf/);
  assert.doesNotMatch(out, /older|listen 8080|Fixed: the unit/);
  assert.equal(turnActivity("", {}), "");
  assert.equal(turnActivity("x", { read: () => { throw new Error("no file"); } }), "");
  assert.ok(turnActivity("x", { read: () => transcript, budget: 60 }).includes("..."));
});

test("a short request to carry on is told apart from one that says what to work on", () => {
  for (const yes of ["sigue", "Sigue con lo que estábamos haciendo", "continúa", "retoma lo del onboarding", "¿en qué quedó lo del otro día?", "y qué falta?", "where were we", "keep going", "pick up where Ana left off", "<ide_opened_file>x</ide_opened_file>seguimos"]) {
    assert.equal(isContinuation(yes), true, yes);
  }
  for (const no of ["", "arregla este test que falla en UserServiceTest", "sí", "ok", "revisa la seguridad del despliegue", "no sigas por ahí, cambia el enfoque y explícame por qué falló la migración de la base de datos en producción ayer por la noche con todo detalle"]) {
    assert.equal(isContinuation(no), false, no);
  }
});

test("a continuation asks the colony to resume, with the repository and a query to fall back on", async () => {
  const sent = [];
  const fetcher = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ events: [] }) }; };
  const target = { colony: colony(["*"]), scope: "app", repo: "app", branch: "main" };
  await recallEvents({ session_id: "s", prompt: "sigue" }, target, "", { fetcher });
  await recallEvents({ session_id: "s", prompt: "arregla el despliegue de la aplicación" }, target, "arregla el despliegue de la aplicación", { fetcher });
  assert.deepEqual([sent[0].resume, sent[0].repo, sent[0].query], [true, "app", "sigue"]);
  assert.equal(sent[1].resume, undefined);
});

test("names stay only when the colony or this machine says so, and credentials go either way", async () => {
  const sent = [];
  const fetcher = async (_, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  const base = { colony: colony(["deploy"]), scope: "deploy", repo: "deploy", branch: "main" };
  const input = { session_id: "s", last_assistant_message: "ok" };
  await logExchange(input, { ...base, keepPersonal: true }, "ask ana@example.com, password: Sup3rSecreta", { fetcher });
  await logExchange(input, base, "ask ana@example.com, password: Sup3rSecreta", { fetcher });
  assert.match(sent[0].prompt, /ana@example\.com/);
  assert.doesNotMatch(sent[1].prompt, /ana@example/);
  assert.doesNotMatch(JSON.stringify(sent), /Sup3rSecreta/);
});

test("the digest is at most three lines, marked as untrusted, and absent when nothing happened", () => {
  const m = { matter: "deploy of the app", people: ["bruno", "carla"], last_at: "2026-11-09T10:00:00Z", new_events: 3, kind: "state", text: "waiting for the certificate" };
  const note = digestNote([m, m, m, m]);
  assert.equal((note.match(/^- deploy of the app/gm) ?? []).length, 3);
  assert.match(note, /- deploy of the app \(bruno, carla, 2026-11-09, 3 new\) state: waiting for the certificate/);
  assert.match(note, /untrusted data/);
  assert.match(note, /<myrmo_worklog_digest>[\s\S]*<\/myrmo_worklog_digest>/);
  assert.equal(digestNote([]), null);
  assert.equal(digestNote(undefined), null);
  assert.deepEqual(DIGEST_SOURCES, ["startup", "resume", "clear"]);
});

test("a session that starts gets the digest through the hook, but not after a compaction or when the colony has nothing", async () => {
  const requests = [];
  let matters = [{ matter: "deploy", people: ["bruno"], last_at: "2026-11-09T10:00:00Z", new_events: 1, kind: "decision", text: "use staging first" }];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ held_out: false, matters }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "worklog-hook.mjs");
  const home = mkdtempSync(join(tmpdir(), "worklog-digest-"));
  const env = { ...process.env, HOME: home, MYRMO_WORKLOG: "1", MYRMO_WORKLOG_SCOPES: "*", MYRMO_URL: `http://127.0.0.1:${server.address().port}`, MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1", MYRMO_CONFIG: join(home, "none.json") };
  const run = (input) => new Promise((resolve) => {
    const child = spawn("node", [script], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: home, ...input }));
  });
  try {
    const started = JSON.parse(await run({ source: "startup" }));
    assert.equal(started.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(started.hookSpecificOutput.additionalContext, /deploy .*decided: use staging first/);
    assert.match(requests[0], /^\/v1\/worklog\/digest\?session=s1&repo=/);
    const before = requests.length;
    assert.equal(await run({ source: "compact" }), "", "the same session after a compaction is not a new one");
    assert.equal(requests.length, before, "and asks nothing");
    matters = [];
    assert.equal(await run({ source: "startup" }), "", "nothing to tell: nothing said");
  } finally {
    server.close();
  }
});

test("a request that starts with //privado or //private is the person's own: it is marked private", async () => {
  const { isPrivate } = await import("../scripts/worklog.mjs");
  for (const yes of ["//privado mejora mi currículum", "  // private rewrite my cv", "//PRIVATE", "//privada: una nota", "<ide_opened_file>x</ide_opened_file>//privado qué tal"]) {
    assert.equal(isPrivate(yes), true, yes);
  }
  for (const no of ["fix the deploy of the connector", "see https://private.example.com", "// a comment about private things", "private //privado", "", undefined]) {
    assert.equal(isPrivate(no), false, String(no));
  }
});

test("a private request is neither logged nor searched, and the next one is logged again", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ events: [], held_out: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "worklog-hook.mjs");
  const home = mkdtempSync(join(tmpdir(), "worklog-private-"));
  const env = { ...process.env, HOME: home, MYRMO_WORKLOG: "1", MYRMO_WORKLOG_SCOPES: "*", MYRMO_URL: `http://127.0.0.1:${server.address().port}`, MYRMO_API_KEY: "k", MYRMO_PRIVATE: "1", MYRMO_WORKLOG_STATE_DIR: join(home, "state") };
  const run = (input) => new Promise((resolve) => {
    const child = spawn("node", [script], { env });
    child.on("close", resolve);
    child.stdin.end(JSON.stringify({ session_id: "s1", cwd: home, last_assistant_message: "Done, here is the new version.", ...input }));
  });
  try {
    await run({ hook_event_name: "UserPromptSubmit", prompt: "//privado rewrite my cv so that it highlights my cloud work" });
    await run({ hook_event_name: "Stop" });
    assert.deepEqual(requests, [], "nothing about a private request leaves the machine");
    await run({ hook_event_name: "UserPromptSubmit", prompt: "why does the deploy of the connector fail" });
    await run({ hook_event_name: "Stop" });
    assert.ok(requests.some((r) => r.endsWith("/v1/worklog/exchanges")), "the next request is logged as usual");
  } finally {
    server.close();
  }
});

test("a reminder says how recent it is, and the digest puts first what waits on this person", async () => {
  const { whenSaid, digestNote, recallNote } = await import("../scripts/worklog.mjs");
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(whenSaid("2026-11-14T11:35:00Z", now), "25 min ago");
  assert.equal(whenSaid("2026-11-14T09:00:00Z", now), "3 h ago");
  assert.equal(whenSaid("2026-11-09T10:00:00Z", now), "2026-11-09");
  assert.equal(whenSaid("not a date", now), "notadate".slice(0, 0) + "");
  const note = digestNote([{ matter: "image", for_you: true, people: ["ana"], last_at: "2026-11-14T11:00:00Z", kind: "state", text: "waiting for the new image" }], now);
  assert.match(note, /- image WAITS ON THIS PERSON \(ana, 1 h ago\): waiting for the new image/);
  assert.match(recallNote([{ kind: "decision", person: "bruno", at: "2026-11-14T11:50:00Z", matter: "deploy", text: "staging first" }], now), /\[decided, bruno, 10 min ago\] deploy/);
});

