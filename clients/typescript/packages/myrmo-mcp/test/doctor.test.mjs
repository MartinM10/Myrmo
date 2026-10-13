import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, render } from "../dist/doctor.js";

const base = { url: "http://192.168.219.87:8080", saved: true, apiKey: "myk_" + "a".repeat(64), privateMode: true, publish: "auto", nodeVersion: "20.11.0", home: "/nonexistent-home" };
const answer = (routes) => async (url) => {
  const path = new URL(url).pathname;
  const r = routes[path];
  if (r instanceof Error) throw r;
  return new Response(r?.body ?? "{}", { status: r?.status ?? 404 });
};
const find = (checks, name) => checks.find((c) => c.name === name);

test("a colony that is up, a key that opens it and a private setup pass the network checks", async () => {
  const checks = await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 200 }, "/v1/stats": { status: 200 } }) });
  assert.equal(find(checks, "Reaching the colony").level, "ok");
  assert.equal(find(checks, "Your access key").level, "ok");
  assert.equal(find(checks, "Private mode").level, "ok");
  assert.equal(find(checks, "Publishing").level, "ok");
});

test("each way it can fail says what to do", async () => {
  const net = await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 403 } }) });
  assert.match(find(net, "Reaching the colony").fix, /not in the networks the colony allows/);
  const bad = await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 200 }, "/v1/stats": { status: 401 } }) });
  assert.match(find(bad, "Your access key").fix, /revoked/);
  const nokey = await diagnose({ ...base, apiKey: undefined, fetchImpl: answer({ "/readyz": { status: 200 }, "/v1/stats": { status: 401 } }) });
  assert.match(find(nokey, "Your access key").fix, /init --url/);
  const down = await diagnose({ ...base, fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
  assert.match(find(down, "Reaching the colony").detail, /nothing listens/);
  const old = await diagnose({ ...base, nodeVersion: "18.19.0", fetchImpl: answer({ "/readyz": { status: 200 }, "/v1/stats": { status: 200 } }) });
  assert.equal(find(old, "Node.js").level, "fail");
});

test("the public colony is flagged and never probed with a key; the report counts problems", async () => {
  let called = false;
  const checks = await diagnose({ ...base, url: "https://myrmo.dev", fetchImpl: async () => { called = true; return new Response("{}"); } });
  assert.equal(called, false);
  assert.equal(find(checks, "Colony").level, "warn");
  const text = render(await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 403 } }) }));
  assert.match(text, /\[FAIL\] Reaching the colony/);
  assert.match(text, /1 problem to fix/);
});

test("a refusal says what address the colony sees, and what to do about it", async () => {
  const body = JSON.stringify({ error: { code: "network_not_allowed", message: "This colony is not open to your network: it sees you as 150.214.40.121." } });
  const nat = await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 403, body } }) });
  const c = find(nat, "Reaching the colony");
  assert.match(c.detail, /it sees you as 150\.214\.40\.121/);
  assert.match(c.fix, /allow 150\.214\.40\.121/);
  assert.match(c.fix, /translating/);
  const docker = await diagnose({ ...base, fetchImpl: answer({ "/readyz": { status: 403, body: body.replace("150.214.40.121", "172.19.0.1") } }) });
  const d = find(docker, "Reaching the colony").fix;
  assert.match(d, /not localhost/);
  assert.doesNotMatch(d, /allow 172\./, "never advise opening Docker's own network");
});
