import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, fingerprint2, normalizeMessage, normalizeMessage2, guessErrorType } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../../../protocol/fingerprint.v1.vectors.json", import.meta.url), "utf8"));
const vectors2 = JSON.parse(readFileSync(new URL("../../../../../protocol/fingerprint.v2.vectors.json", import.meta.url), "utf8"));

test("matches every normative fingerprint vector", () => {
  assert.ok(vectors.length >= 16);
  for (const v of vectors) {
    assert.equal(normalizeMessage(v.error_type, v.message), v.normalized, v.message);
    assert.equal(fingerprint(v.runtime, v.error_type, v.message), v.fingerprint, v.message);
  }
});

test("matches every normative fp2 vector", () => {
  assert.ok(vectors2.length >= 40);
  for (const v of vectors2) {
    assert.equal(normalizeMessage2(v.message), v.normalized, v.message);
    assert.equal(fingerprint2(v.message), v.fingerprint, v.message);
  }
});

test("fp2 needs the message and nothing else", () => {
  assert.equal(
    fingerprint2("java.util.concurrent.CompletionException: java.lang.IllegalStateException: Recursive update"),
    fingerprint2("IllegalStateException: Recursive update"),
  );
  assert.notEqual(fingerprint2("No module named 'numpy'"), fingerprint2("No module named 'scipy'"));
  assert.notEqual(fingerprint2("bash: uv: command not found"), fingerprint2("bash: node: command not found"));
});

test("guesses the error type from an error line", () => {
  assert.equal(guessErrorType("ModuleNotFoundError: No module named 'x'"), "ModuleNotFoundError");
  assert.equal(guessErrorType("Something went wrong: details"), "");
  assert.equal(guessErrorType("no colon"), "");
});
