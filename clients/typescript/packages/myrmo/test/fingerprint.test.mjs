import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, normalizeMessage, guessErrorType } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../../../protocol/fingerprint.v1.vectors.json", import.meta.url), "utf8"));

test("matches every normative fingerprint vector", () => {
  assert.ok(vectors.length >= 16);
  for (const v of vectors) {
    assert.equal(normalizeMessage(v.error_type, v.message), v.normalized, v.message);
    assert.equal(fingerprint(v.runtime, v.error_type, v.message), v.fingerprint, v.message);
  }
});

test("guesses the error type from an error line", () => {
  assert.equal(guessErrorType("ModuleNotFoundError: No module named 'x'"), "ModuleNotFoundError");
  assert.equal(guessErrorType("Something went wrong: details"), "");
  assert.equal(guessErrorType("no colon"), "");
});
