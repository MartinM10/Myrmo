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

import { destinationLine } from "../dist/server.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInitArgs } from "../dist/init.js";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const isolated = () => ({ ...process.env, MYRMO_CONFIG: join(mkdtempSync(join(tmpdir(), "myrmo-")), "c.json"), MYRMO_URL: "", MYRMO_API_KEY: "" });

test("every publication answer says which colony it went to, and as whom", () => {
  const priv = destinationLine("http://10.20.0.17:8080", true, "key 1a2b3c4d");
  assert.match(priv, /PRIVATE colony/);
  assert.match(priv, /10\.20\.0\.17:8080/);
  assert.match(priv, /Acting as key 1a2b3c4d/);
  assert.match(destinationLine("https://myrmo.dev", false), /the PUBLIC colony: anyone can read/);
  assert.match(destinationLine("http://other.example:8080", false), /not marked private/);
});

test("a word that is not a command fails with the usage; --help prints it", () => {
  const bad = spawnSync("node", [CLI, "nonsense"], { env: isolated(), encoding: "utf8", timeout: 20000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown command "nonsense"/);
  assert.match(bad.stderr, /myrmo-mcp doctor/);
  const help = spawnSync("node", [CLI, "--help"], { env: isolated(), encoding: "utf8", timeout: 20000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /myrmo-mcp init/);
  assert.match(help.stdout, /--key-file/);
});

test("init can read the key from a file, so that it stays out of the command line", () => {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-key-"));
  const key = "myk_" + "ab".repeat(32);
  writeFileSync(join(dir, "k.txt"), `Hi\n\n   npx myrmo-mcp init --key ${key}\n`);
  const parsed = parseInitArgs(["--url", "http://10.20.0.17:8080", "--key-file", join(dir, "k.txt"), "--private"]);
  assert.equal(parsed.key, key);
  assert.match(parseInitArgs(["--url", "http://x:8080", "--key-file", join(dir, "missing.txt")]), /cannot read/);
  assert.match(parseInitArgs(["--url", "http://x:8080", "--key-file"]), /needs the path/);
});
