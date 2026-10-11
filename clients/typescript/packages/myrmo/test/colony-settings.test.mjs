// The colony in the settings file (written by `npx myrmo-mcp init --url`): its key, private mode and publish choice
// apply only while that colony is the one in use.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony, fileColony, publishChoice, readConfig } from "../dist/index.js";

const KEYS = ["MYRMO_CONFIG", "MYRMO_URL", "MYRMO_API_KEY", "MYRMO_PUBLISH", "MYRMO_AGENT_ID"];
const PRIVATE = { url: "https://myrmo.example.internal/", api_key: `myk_${"a".repeat(64)}`, private: true, publish: "auto" };
let saved;
let realFetch;
let sent;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.MYRMO_CONFIG = join(mkdtempSync(join(tmpdir(), "myrmo-colony-")), "config.json");
  process.env.MYRMO_AGENT_ID = "tester_123";
  realFetch = globalThis.fetch;
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ fingerprint: "fp2_0000000000000000", results: [], notice: "" }), { status: 200, headers: { "content-type": "application/json" } });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

const save = (settings) => writeFileSync(process.env.MYRMO_CONFIG, JSON.stringify(settings));

test("the file chooses the colony, and its key goes with it", async () => {
  save({ colony: PRIVATE });
  const colony = new Colony({ cacheTtlMs: 0 });
  assert.equal(colony.url, "https://myrmo.example.internal");
  assert.equal(colony.publishMode, "auto");
  await colony.search({ error: "deploy: policy REL-7 violated" });
  assert.match(String(sent[0].url), /^https:\/\/myrmo\.example\.internal\/v1\//);
  assert.equal(sent[0].headers.authorization, `Bearer ${PRIVATE.api_key}`);
});

test("a key is never sent to another colony, and a private colony's choice never applies to the public one", async () => {
  save({ colony: PRIVATE, publish: "ask" });
  process.env.MYRMO_URL = "https://myrmo.dev";
  const colony = new Colony({ cacheTtlMs: 0 });
  assert.equal(colony.url, "https://myrmo.dev");
  assert.equal(colony.publishMode, "ask");
  await colony.search({ error: "x failed" });
  assert.equal(sent[0].headers.authorization, undefined);
  assert.equal(fileColony("https://myrmo.dev"), undefined);
  assert.equal(fileColony("https://myrmo.example.internal/")?.private, true);
});

test("the environment still wins", () => {
  save({ colony: PRIVATE });
  process.env.MYRMO_PUBLISH = "off";
  assert.deepEqual(publishChoice(undefined, PRIVATE.url), { mode: "off", source: "env" });
});

test("a damaged colony entry is ignored", () => {
  save({ colony: { url: "not a url", api_key: "myk_x" } });
  assert.equal(readConfig().colony, undefined);
  save({ colony: { url: "http://localhost:8080", api_key: "has space in it", private: "yes" } });
  assert.deepEqual(readConfig().colony, { url: "http://localhost:8080" });
});
