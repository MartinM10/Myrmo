// Every setting has a default and works with no file at all; the file only records what a person chose.
// Order for each one: explicit option, environment variable, settings file, default.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETTINGS,
  agentIdentity,
  attemptsPhrase,
  formatResult,
  minFailedAttempts,
  readConfig,
  setSetting,
  settingsReport,
  writeConfig,
} from "../dist/index.js";

const KEYS = ["MYRMO_CONFIG", "MYRMO_MIN_FAILED_ATTEMPTS", "MYRMO_PUBLISH", "MYRMO_HOOK", "MYRMO_ANONYMOUS", "MYRMO_AGENT_ID"];
let saved;
let file;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  file = join(mkdtempSync(join(tmpdir(), "myrmo-settings-")), "config.json");
  process.env.MYRMO_CONFIG = file;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("with no file every setting has its default", () => {
  const rows = Object.fromEntries(settingsReport().map((r) => [r.key, r]));
  assert.equal(rows.publish.value, "ask");
  assert.equal(rows.publish.source, "default");
  assert.equal(rows["min-failed-attempts"].value, "1");
  assert.equal(rows.hook.value, "on");
  assert.equal(rows.anonymous.value, "false");
  assert.ok(settingsReport().every((r) => r.source === "default"));
  assert.equal(settingsReport().length, SETTINGS.length);
});

test("the minimum of failed attempts: option, then environment, then file, then 1", () => {
  assert.deepEqual(minFailedAttempts(), { value: 1, source: "default" });
  writeConfig({ min_failed_attempts: 4 });
  assert.deepEqual(minFailedAttempts(), { value: 4, source: "file" });
  process.env.MYRMO_MIN_FAILED_ATTEMPTS = "2";
  assert.deepEqual(minFailedAttempts(), { value: 2, source: "env" });
  assert.deepEqual(minFailedAttempts(3), { value: 3, source: "option" });
});

test("nonsense in the environment or the file is ignored, never fatal", () => {
  process.env.MYRMO_MIN_FAILED_ATTEMPTS = "lots";
  assert.equal(minFailedAttempts().source, "default");
  process.env.MYRMO_MIN_FAILED_ATTEMPTS = "";
  assert.equal(minFailedAttempts().source, "default");
  writeFileSync(file, JSON.stringify({ min_failed_attempts: -3, hook: "maybe", anonymous: "yes", publish: "sometimes" }));
  assert.deepEqual(readConfig(), {});
  writeFileSync(file, "not json at all");
  assert.deepEqual(readConfig(), {});
  assert.equal(minFailedAttempts().value, 1);
});

test("setSetting validates, saves, and 'reset' restores the default", () => {
  assert.equal(setSetting("min-failed-attempts", "3").ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).min_failed_attempts, 3);
  assert.equal(setSetting("hook", "off").ok, true);
  assert.equal(setSetting("anonymous", "true").ok, true);
  assert.equal(setSetting("publish", "auto").ok, true);
  assert.deepEqual(readConfig(), { min_failed_attempts: 3, hook: "off", anonymous: true, publish: "auto" });

  for (const [key, value] of [["min-failed-attempts", "-1"], ["min-failed-attempts", "many"], ["min-failed-attempts", "21"], ["hook", "maybe"], ["anonymous", "yes"], ["publish", "sometimes"], ["colour", "blue"]]) {
    assert.equal(setSetting(key, value).ok, false, `${key} ${value}`);
  }
  assert.equal(readConfig().min_failed_attempts, 3, "a refused value changes nothing");

  assert.equal(setSetting("min-failed-attempts", "reset").ok, true);
  assert.equal(readConfig().min_failed_attempts, undefined);
  assert.equal(minFailedAttempts().source, "default");
  assert.equal(readConfig().hook, "off", "the other settings stay");
});

test("the report says where each value comes from", () => {
  writeConfig({ hook: "off" });
  process.env.MYRMO_MIN_FAILED_ATTEMPTS = "5";
  process.env.MYRMO_PUBLISH = "auto";
  const rows = Object.fromEntries(settingsReport().map((r) => [r.key, r]));
  assert.deepEqual([rows.hook.value, rows.hook.source], ["off", "file"]);
  assert.deepEqual([rows["min-failed-attempts"].value, rows["min-failed-attempts"].source], ["5", "env"]);
  assert.deepEqual([rows.publish.value, rows.publish.source], ["auto", "env"]);
  process.env.MYRMO_HOOK = "on";
  assert.equal(settingsReport().find((r) => r.key === "hook").source, "env", "the environment beats the file");
});

test("anonymous in the file sends no agent id, and the environment can still name one", () => {
  writeConfig({ anonymous: true });
  assert.equal(agentIdentity().source, "none");
  process.env.MYRMO_AGENT_ID = "chosen-by-the-user";
  assert.deepEqual(agentIdentity(), { id: "chosen-by-the-user", source: "env" });
});

test("the hint after a search with no match follows the configured minimum", () => {
  const none = { fingerprint: "fp1_0000000000000000", hits: [], notice: "untrusted", source: "search" };
  assert.match(formatResult(none), /at least one failed attempt/);
  writeConfig({ min_failed_attempts: 3 });
  assert.match(formatResult(none), /3 or more failed attempts/);
  assert.match(formatResult(none, { minFailedAttempts: 5 }), /5 or more failed attempts/);
  assert.equal(attemptsPhrase(0), "at least one failed attempt");
});
