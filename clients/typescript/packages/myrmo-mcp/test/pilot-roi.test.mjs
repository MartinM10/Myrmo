// `myrmo-mcp pilot-roi`: prints the colony's own pilot summary, with the operator token.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "test-operator-token-0123456789";
const seen = [];
let colony;
let url;

before(async () => {
  colony = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"error":{"code":"unauthorized"}}');
    if (req.url.includes("format=text")) return res.writeHead(200, { "content-type": "text/plain" }).end("Myrmo pilot summary, last 7 days\n");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pilot_days: 7, savings: { method: "holdout" } }));
  });
  await new Promise((r) => colony.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${colony.address().port}`;
});

after(() => colony.close());

/** Run the command without blocking this process: the fake colony answers from it. */
const run = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, "pilot-roi", ...args], {
      env: { ...process.env, MYRMO_URL: url, MYRMO_CONFIG: join(mkdtempSync(join(tmpdir(), "myrmo-roi-")), "c.json"), MYRMO_ADMIN_TOKEN: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("it prints the summary the colony renders, for the days asked", async () => {
  const r = await run(["7"], { MYRMO_ADMIN_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Myrmo pilot summary, last 7 days\n");
  assert.equal(seen.at(-1).url, "/v1/admin/pilot-roi?days=7&format=text");
  assert.equal(seen.at(-1).auth, `Bearer ${TOKEN}`);
});

test("--json prints the colony's JSON", async () => {
  const r = await run(["--json"], { MYRMO_ADMIN_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { pilot_days: 7, savings: { method: "holdout" } });
  assert.equal(seen.at(-1).url, "/v1/admin/pilot-roi?days=14");
});

test("without the operator token it says what it needs and asks nothing", async () => {
  const before = seen.length;
  const r = await run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /MYRMO_ADMIN_TOKEN/);
  assert.equal(seen.length, before);
});

test("a wrong token is explained", async () => {
  const r = await run([], { MYRMO_ADMIN_TOKEN: "not-the-token-at-all" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /operator token, not a person's key/);
});
