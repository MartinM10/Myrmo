// The client names itself: a random pseudonym created on first use and kept in the settings file.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony, agentIdentity, readConfig } from "../dist/index.js";

const saved = { ...process.env };
let dir;
let calls;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myrmo-agent-id-"));
  for (const key of ["MYRMO_AGENT_ID", "MYRMO_ANONYMOUS", "MYRMO_AGENT_MODEL", "MYRMO_PUBLISH"]) delete process.env[key];
  process.env.MYRMO_CONFIG = join(dir, "config.json");
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ fingerprint: "fp1_0000000000000000", results: [], notice: "untrusted" }), { status: 200, headers: { "content-type": "application/json" } });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("the first run creates a random id, keeps it, and the next run is the same agent", () => {
  const first = agentIdentity();
  assert.equal(first.source, "generated");
  assert.match(first.id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(JSON.parse(readFileSync(process.env.MYRMO_CONFIG, "utf8")).agent_id, first.id);
  const second = agentIdentity();
  assert.deepEqual(second, { id: first.id, source: "file" });
});

test("two machines get different ids", () => {
  const a = agentIdentity().id;
  process.env.MYRMO_CONFIG = join(dir, "other.json");
  assert.notEqual(agentIdentity().id, a);
});

test("an id chosen by the user wins, and none can be requested", () => {
  process.env.MYRMO_AGENT_ID = "chosen-by-the-user";
  assert.deepEqual(agentIdentity(), { id: "chosen-by-the-user", source: "env" });
  assert.deepEqual(agentIdentity("from-the-option"), { id: "from-the-option", source: "option" });
  assert.deepEqual(agentIdentity(false), { source: "none" });
  delete process.env.MYRMO_AGENT_ID;
  process.env.MYRMO_ANONYMOUS = "1";
  assert.deepEqual(agentIdentity(), { source: "none" });
  assert.throws(() => readFileSync(process.env.MYRMO_CONFIG, "utf8"), "an anonymous client writes nothing");
});

test("a damaged id in the file is replaced and the user's other choices survive", () => {
  writeFileSync(process.env.MYRMO_CONFIG, JSON.stringify({ publish: "ask", agent_id: "short" }));
  const id = agentIdentity().id;
  assert.notEqual(id, "short");
  assert.deepEqual(readConfig(), { publish: "ask", agent_id: id });
});

test("a settings file that cannot be written still gives this process an id", () => {
  process.env.MYRMO_CONFIG = join(dir, "no", "such", "dir", "\0config.json");
  const identity = agentIdentity();
  assert.equal(identity.source, "generated");
  assert.ok(identity.id);
});

test("the id and the model go out as headers on every request", async () => {
  process.env.MYRMO_AGENT_MODEL = "claude-opus-5-5";
  const colony = new Colony({ cacheTtlMs: 0 });
  await colony.search({ error: "ModuleNotFoundError: No module named 'x'", runtime: "python" });
  const id = readConfig().agent_id;
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.equal(call.headers["x-myrmo-agent"], id);
    assert.equal(call.headers["x-myrmo-model"], "claude-opus-5-5");
  }
  await colony.search({ error: "ModuleNotFoundError: No module named 'y'", runtime: "python", model: "gpt-5" });
  assert.equal(calls.at(-1).headers["x-myrmo-model"], "gpt-5", "a search can say which model asks");
});

test("a header the caller passes wins, and agentId false sends none", async () => {
  const forwarding = new Colony({ agentId: false, headers: { "x-myrmo-agent": "the-callers-own-id" }, cacheTtlMs: 0 });
  await forwarding.search({ error: "Error: boom happened here", runtime: "node" });
  assert.equal(calls.at(-1).headers["x-myrmo-agent"], "the-callers-own-id");
  const silent = new Colony({ agentId: false, cacheTtlMs: 0 });
  await silent.search({ error: "Error: another boom happened", runtime: "node" });
  assert.equal(calls.at(-1).headers["x-myrmo-agent"], undefined);
});

test("the model 'unknown' is not worth sending", async () => {
  process.env.MYRMO_AGENT_MODEL = "unknown";
  await new Colony({ cacheTtlMs: 0 }).search({ error: "Error: boom happened again", runtime: "node" });
  assert.equal(calls.at(-1).headers["x-myrmo-model"], undefined);
});
