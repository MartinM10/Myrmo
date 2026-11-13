// The team's work log as the SDK asks for it: the matters, one matter, and what a colony without one answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony } from "../dist/index.js";

process.env.MYRMO_CONFIG = join(mkdtempSync(join(tmpdir(), "myrmo-matters-")), "config.json");

async function colonyThat(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const [status, body] = handler(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const colony = new Colony({ url: `http://127.0.0.1:${server.address().port}`, apiKey: "k", retries: 0 });
  return { colony, seen, close: () => server.close() };
}

test("matters are listed with the filters asked for, and read by name", async () => {
  const { colony, seen, close } = await colonyThat((url) =>
    url.startsWith("/v1/worklog/matters")
      ? [200, { matters: [{ matter: "deploy", last_at: "2026-11-06T10:00:00Z", people: ["ana"], repos: ["app"], events: 3, failed_attempts: 1, state: "waiting for the certificate" }] }]
      : [200, { found: true, matter: "deploy", state: { text: "waiting" }, decisions: [], failed_attempts: [], conclusions: [], facts: [], earlier_states: 0, repos: [], people: [], last_at: "" }],
  );
  try {
    const list = await colony.listMatters({ q: "deploy", others: true, hours: 48, limit: 5 });
    assert.equal(list.matters[0].matter, "deploy");
    assert.match(seen[0], /^\/v1\/worklog\/matters\?/);
    for (const part of ["q=deploy", "others=true", "hours=48", "limit=5"]) assert.ok(seen[0].includes(part), part);
    const view = await colony.readMatter("deploy", true);
    assert.equal(view.found, true);
    assert.match(seen[1], /^\/v1\/worklog\/matter\?name=deploy&all=true$/);
  } finally {
    close();
  }
});

test("a colony without a work log answers null, and a name that matches nothing says which matters it could have meant", async () => {
  const none = await colonyThat(() => [404, { error: { code: "not_collected", message: "no work log" } }]);
  try {
    assert.equal(await none.colony.listMatters(), null);
    assert.equal(await none.colony.readMatter("anything"), null);
  } finally {
    none.close();
  }
  const unknown = await colonyThat(() => [200, { found: false, matters: ["deploy", "docs"] }]);
  try {
    assert.deepEqual(await unknown.colony.readMatter("nothing"), { found: false, matters: ["deploy", "docs"] });
  } finally {
    unknown.close();
  }
});
