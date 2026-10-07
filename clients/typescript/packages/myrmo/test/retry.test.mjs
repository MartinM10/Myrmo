// A colony that is restarting answers 502 for a few seconds. A read is tried again; a write never is.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony, MyrmoError } from "../dist/index.js";

const ERROR = "ModuleNotFoundError: No module named 'distutils'";
const trail = { protocol_version: "1.0", problem: { error_type: "E", summary: "x".repeat(30) }, solution: {}, effort: { failed_attempts: 1 } };
let server;
let url;
let answers = [];
let asked = [];

before(async () => {
  process.env.MYRMO_CONFIG = join(mkdtempSync(join(tmpdir(), "myrmo-retry-")), "config.json");
  server = createServer(async (req, res) => {
    for await (const _ of req);
    asked.push(`${req.method} ${req.url}`);
    const status = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (status === "reset") return req.socket.destroy();
    const json = (code, data) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (status === 200 && req.url.startsWith("/v1/trails/by-fingerprint/")) return json(200, { fingerprint: "fp1_abc", results: [], notice: "untrusted" });
    if (status === 200 && req.url === "/v1/search") return json(200, { fingerprint: "fp1_abc", results: [], notice: "untrusted" });
    if (status === 200) return json(202, { trail_id: "c71e0f4a-2b9d-4e63-a8f5-0d3b7c1e9a26", fingerprint: "fp1_abc", status: "queued", redactions: {} });
    res.writeHead(status, { "content-type": "text/plain" }).end("Bad Gateway");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());
beforeEach(() => {
  asked = [];
});

const colony = (options = {}) => new Colony({ url, cacheTtlMs: 0, retryDelaysMs: [1], ...options });
const answering = (...list) => (answers = list);

test("a lookup is tried again while the colony restarts", async () => {
  answering(502, 502, 200);
  const found = await colony().lookup("fp1_abc");
  assert.ok(found || found === null);
  assert.equal(asked.length, 3, "two 502s, then the answer");
});

test("a search is tried again, and so is a connection that is reset", async () => {
  answering("reset", 503, 200);
  const result = await colony().search({ error: "an error nobody has solved yet", runtime: "python" });
  assert.equal(result.source, "search");
  assert.deepEqual(asked.map((x) => x.split("/")[1] + (x.startsWith("POST") ? " search" : " lookup")).slice(0, 4), ["v1 lookup", "v1 lookup", "v1 lookup", "v1 search"], "the lookup recovers on its third try, finds nothing, and the search goes through");
});

test("still down after the retries says so in words, not as an HTTP error", async () => {
  answering(502);
  await assert.rejects(colony().search({ error: ERROR, runtime: "python" }), (err) => {
    assert.ok(err instanceof MyrmoError);
    assert.equal(err.code, "unavailable");
    assert.equal(err.status, 502);
    assert.match(err.message, /temporarily unavailable/);
    assert.match(err.message, /try again in a few seconds/);
    return true;
  });
  assert.equal(asked.length, 4, "the lookup is tried four times (the first and three retries) and then the search gives up");
});

test("retries can be switched off", async () => {
  answering(502, 200);
  await assert.rejects(colony({ retries: 0 }).lookup("fp1_abc"), (err) => err.code === "unavailable");
  assert.equal(asked.length, 1);
});

test("publishing is never repeated", async () => {
  answering(502, 200);
  await assert.rejects(colony().publish(trail), (err) => err instanceof MyrmoError && err.code === "unavailable");
  assert.equal(asked.length, 1, "a publish that may have arrived must not be sent twice");
});

test("a client error is not retried", async () => {
  answering(400);
  await assert.rejects(colony().search({ error: "boom" }), (err) => err instanceof MyrmoError && err.code === "http_error");
  // The exact lookup treats a 400 as "no exact answer" (a colony that predates fp2) and the search that follows is
  // the request that fails. Neither is tried again.
  assert.equal(asked.length, 2);
  assert.match(asked[0], /^GET \/v1\/trails\/by-fingerprint\/fp2_[0-9a-f]{16}$/);
  assert.equal(asked[1], "POST /v1/search");
});

test("a colony that predates fp2 answers a lookup with 400: there is no exact answer, not an error", async () => {
  answering(400);
  assert.equal(await colony().lookup("fp2_0123456789abcdef"), null);
  assert.equal(asked.length, 1);
});
