import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactText, redactValue } from "../dist/index.js";

const r = (s) => redactText(s);

test("removes secrets", () => {
  assert.ok(!r("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123").includes("sk-ant-api03"));
  assert.equal(r("AKIAIOSFODNN7EXAMPLE used"), "<redacted:aws_access_key> used");
  assert.equal(r("postgres://admin:hunter2@db.internal:5432/app"), "postgres://<redacted:connection_string>@<redacted:hostname>:5432/app");
  assert.equal(r("password=SuperSecret123 next"), "password=<redacted:secret> next");
  assert.equal(r("Authorization: Bearer abcdefghijklmnop1234567890"), "Authorization: Bearer <redacted:token>");
  assert.equal(r("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"), "<redacted:private_key>");
});

test("removes personal data and keeps harmless values", () => {
  assert.equal(r("mail ana.garcia@acme.com now"), "mail <redacted:email> now");
  assert.equal(r("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
  assert.equal(r("connect 10.0.3.17:5432"), "connect <redacted:ip>:5432");
  assert.equal(r("listen 127.0.0.1:8080"), "listen 127.0.0.1:8080");
  assert.equal(r("version 10.0.26100.1"), "version 10.0.26100.1");
  assert.equal(r('File "/home/martin/app/x.py"'), 'File "/home/<user>/app/x.py"');
  assert.equal(r(String.raw`C:\Users\ana\proj\cfg.yaml`), String.raw`C:\Users\<user>\proj\cfg.yaml`);
});

test("redacts nested values, counts kinds, and is idempotent", () => {
  const report = {};
  const once = redactValue({ a: ["api_key=abcd1234efgh", { b: "ok" }] }, report);
  assert.deepEqual(redactValue(once), once);
  assert.equal(once.a[1].b, "ok");
  assert.equal(report.password_assignment, 1);
});

const VECTORS = JSON.parse(readFileSync(new URL("../../../../../protocol/redact.v1.vectors.json", import.meta.url), "utf8"));

test("matches every normative redaction vector", () => {
  assert.ok(VECTORS.length >= 100);
  for (const v of VECTORS) {
    const kinds = {};
    const out = redactText(v.input, kinds);
    assert.equal(out, v.output, `output for ${JSON.stringify(v.input)}`);
    assert.deepEqual(Object.fromEntries(Object.entries(kinds).sort()), v.kinds, `kinds for ${JSON.stringify(v.input)}`);
    assert.equal(redactText(out), out, `idempotent for ${JSON.stringify(v.input)}`);
  }
});

test("long hostile input is redacted in bounded time", () => {
  // Unbounded prefixes made these quadratic: 16,000 characters took a second.
  for (const text of ["a.".repeat(8000), "://" + "a.".repeat(8000), "word.".repeat(3000) + "token=x", "a@".repeat(8000)]) {
    const start = performance.now();
    redactText(text);
    assert.ok(performance.now() - start < 500, `took ${Math.round(performance.now() - start)} ms`);
  }
});

test("an organisation named by a configuration key is removed, and a Maven coordinate is not", () => {
  assert.equal(r("edc.ui.organization=Acme Corp"), "edc.ui.organization=<redacted:org>");
  assert.equal(r('{"owner": "Ana Garcia"}'), '{"owner": "<redacted:org>"}');
  assert.equal(r("java -Dedc.ui.organization=Acme -jar x.jar"), "java -Dedc.ui.organization=<redacted:org> -jar x.jar");
  assert.equal(r("org.eclipse.edc:dcp-core:1.0.0"), "org.eclipse.edc:dcp-core:1.0.0");
  assert.equal(r("tenant: <TENANT_ID>"), "tenant: <TENANT_ID>");
});

test("possibleNames lists runs of capitalised words that were not redacted, and nothing else", async () => {
  const { possibleNames } = await import("../dist/index.js");
  const trail = { problem: { summary: "Connector for Acme Data Systems fails. Install Python first." }, steps: ["Open the Management API"] };
  assert.deepEqual(possibleNames(trail), ["Acme Data Systems", "Management API"]);
  assert.deepEqual(possibleNames({ a: "Install Python and run it", b: "no names here" }), []);
  assert.deepEqual(possibleNames({ a: "x" }), []);
});
