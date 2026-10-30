// Colony.validate asks the colony whether it would accept a trail, and says so plainly when it cannot tell.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony } from "../dist/index.js";

const trail = { protocol_version: "1.0", problem: { error_type: "E", summary: "x".repeat(30) }, solution: {}, effort: { failed_attempts: 1 } };
let server;
let url;
let mode = "valid";
const seen = [];

before(async () => {
  process.env.MYRMO_CONFIG = join(mkdtempSync(join(tmpdir(), "myrmo-validate-")), "config.json");
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url });
    const send = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (mode === "valid") return send(200, { valid: true, fingerprint: "fp1_abc", redactions: { api_key: 1 } });
    if (mode === "invalid") return send(400, { error: { code: "invalid_trail", message: "no", details: [{ path: "/solution/verification_method/type", message: '"manual" is not one of [...]' }] } });
    if (mode === "old") return send(404, { error: { code: "not_found", message: "none" } });
    return send(503, { error: { code: "busy", message: "try later" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("a trail the colony accepts", async () => {
  mode = "valid";
  const v = await new Colony({ url, retryDelaysMs: [1] }).validate(trail);
  assert.deepEqual(v, { valid: true, fingerprint: "fp1_abc", redactions: { api_key: 1 } });
  assert.equal(seen.at(-1).url, "/v1/validate");
  assert.equal(seen.filter((r) => r.url === "/v1/trails").length, 0, "validating never publishes");
});

test("a trail the colony would refuse says what is wrong", async () => {
  mode = "invalid";
  const v = await new Colony({ url, retryDelaysMs: [1] }).validate(trail);
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors, [{ path: "/solution/verification_method/type", message: '"manual" is not one of [...]' }]);
});

test("an older colony without the endpoint, or one that is down, is not a verdict", async () => {
  mode = "old";
  const old = await new Colony({ url, retryDelaysMs: [1] }).validate(trail);
  assert.equal(old.valid, null);
  assert.match(old.reason, /does not offer validation/);
  mode = "down";
  assert.equal((await new Colony({ url, retryDelaysMs: [1] }).validate(trail)).valid, null);
  const unreachable = await new Colony({ url: "http://127.0.0.1:1", timeoutMs: 500, retryDelaysMs: [1] }).validate(trail);
  assert.equal(unreachable.valid, null);
});
