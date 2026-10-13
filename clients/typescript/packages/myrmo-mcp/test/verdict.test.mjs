import { test } from "node:test";
import assert from "node:assert/strict";
import { describeVerdict, rejectionAdvice } from "../dist/server.js";

const detail = {
  sensitive_content: { fields: ["problem.summary", "solution.steps"], hint: "Replace names with a placeholder such as <company>. Do not invent realistic-looking values." },
  low_quality: { hint: "Say what the root cause was." },
};

test("a rejection for private data says where, how to fix it, and to try only once", () => {
  const out = describeVerdict("rejected", "abc", ["sensitive_content"], undefined, detail);
  assert.match(out, /still looked like it contained private data/);
  assert.match(out, /problem\.summary, solution\.steps/);
  assert.match(out, /<company>/);
  assert.match(out, /only once/);
  assert.match(out, /stop and tell the user/);
});

test("a rejection for an instruction aimed at an agent gets no advice on how to pass", () => {
  const out = describeVerdict("rejected", "abc", ["prompt_injection"], undefined, detail);
  assert.match(out, /Do not try to get round this check/);
  assert.doesNotMatch(out, /fix it and publish once more|placeholder/);
  // Even when the reasons are mixed, the injection rule wins.
  assert.match(describeVerdict("rejected", "abc", ["sensitive_content", "prompt_injection"], undefined, detail), /Do not try to get round this check/);
});

test("without detail the verdict is what it was, and a quality rejection says what is missing", () => {
  assert.equal(rejectionAdvice(["sensitive_content"], undefined), "");
  assert.match(describeVerdict("rejected", "abc", ["low_quality"], undefined, { low_quality: detail.low_quality }), /root cause/);
  assert.match(describeVerdict("rejected", "abc", ["enrichment_failed"]), /could not process it\. Do not publish it again unchanged\.$/);
  assert.match(describeVerdict("indexed", "abc"), /is indexed/);
});
