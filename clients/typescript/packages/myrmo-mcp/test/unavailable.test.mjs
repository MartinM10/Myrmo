// A colony that is restarting answers 502. The agent is told, in words, that the service is unavailable and to carry on,
// not given a bare HTTP error; and a search that hits a short blip is tried again and succeeds without the agent noticing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let server;
let url;
let failFirst = Infinity;
let seen = 0;

before(async () => {
  server = createServer(async (req, res) => {
    for await (const _ of req);
    seen++;
    const json = (code, data) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (seen <= failFirst) return res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway");
    if (req.url.startsWith("/v1/trails/by-fingerprint/")) return json(404, { error: { code: "not_found", message: "none" } });
    if (req.url === "/v1/search") return json(200, { fingerprint: "fp1_0000000000000000", results: [], notice: "untrusted" });
    json(404, { error: { code: "not_found", message: req.url } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function client() {
  const c = new Client({ name: "test-client", version: "1.0.0" });
  const config = join(mkdtempSync(join(tmpdir(), "myrmo-unavailable-")), "config.json");
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { ...process.env, MYRMO_URL: url, MYRMO_CONFIG: config, MYRMO_PUBLISH: "ask" } }));
  return c;
}

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("a colony that stays unavailable is reported in words, and the agent is told to carry on", async () => {
  failFirst = Infinity;
  seen = 0;
  const c = await client();
  const result = await c.callTool({ name: "myrmo_search", arguments: { error: "ModuleNotFoundError: No module named 'x_y_z'", runtime: "python" } });
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.match(text, /temporarily unavailable \(HTTP 502\)/);
  assert.match(text, /search again in a minute/);
  assert.match(text, /Continue without Myrmo/);
  assert.doesNotMatch(text, /http_error/, "not the bare HTTP error it used to be");
  assert.ok(seen >= 4, `the read was repeated before giving up (${seen} requests)`);
  await c.close();
});

test("a blip of a couple of 502s is absorbed: the search succeeds and the agent never sees the failure", async () => {
  failFirst = 2;
  seen = 0;
  const c = await client();
  const result = await c.callTool({ name: "myrmo_search", arguments: { error: "ModuleNotFoundError: No module named 'x_y_z'", runtime: "python" } });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /No trail in the Myrmo colony matches this error yet/);
  await c.close();
});
