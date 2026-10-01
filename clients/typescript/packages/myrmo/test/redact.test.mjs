import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue } from "../dist/index.js";

const r = (s) => redactText(s);

test("removes secrets", () => {
  assert.ok(!r("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123").includes("sk-ant-api03"));
  assert.equal(r("AKIAIOSFODNN7EXAMPLE used"), "<redacted:aws_access_key> used");
  assert.equal(r("postgres://admin:hunter2@db.internal:5432/app"), "postgres://<redacted:connection_string>@db.internal:5432/app");
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
