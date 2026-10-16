// Checking a trail on this machine, before anything is sent, against the protocol's own schema; and what the hosted
// server trusts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkTrail, trailSchema } from "../dist/check.js";
import { allowedHosts, callerKey, DEFAULT_HTTP_HOST, hostedColonyUrl } from "../dist/hosting.js";

const repo = (path) => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url));
const example = JSON.parse(readFileSync(repo("protocol/examples/trail.distutils.json"), "utf8"));

test("the build carries the protocol's schema, unchanged", () => {
  assert.deepEqual(trailSchema(), JSON.parse(readFileSync(repo("protocol/trail.v1.schema.json"), "utf8")));
});

test("the protocol's example and the seed trails pass the local check", () => {
  assert.deepEqual(checkTrail(example), []);
  const seeds = JSON.parse(readFileSync(repo("deploy/seed/trails.json"), "utf8"));
  for (const seed of seeds) assert.deepEqual(checkTrail(seed), [], seed.problem.error_type);
});

test("the local check names what the colony would refuse, by path", () => {
  const bad = structuredClone(example);
  bad.solution.verification_method.type = "manual";
  delete bad.problem.summary;
  bad.extra = 1;
  bad.solution.code_patches = [{ file_path: "/etc/hosts", diff: "+x" }];
  const paths = checkTrail(bad).map((i) => i.path);
  for (const path of ["/solution/verification_method/type", "/problem/summary", "/extra", "/solution/code_patches/0/file_path"]) {
    assert.ok(paths.includes(path), `${path} in ${JSON.stringify(paths)}`);
  }
});

test("a procedure needs what a procedure needs, not what a fix needs", () => {
  const procedure = {
    protocol_version: "1.6",
    kind: "procedure",
    agent_info: { model: "m", framework: "f" },
    problem: { summary: "Deploy a new tenant to the staging cluster", task_context: "When someone asks for a new tenant" },
    solution: { steps: ["run the tenant script", "check the dashboard"] },
  };
  assert.deepEqual(checkTrail(procedure), []);
  delete procedure.problem.task_context;
  assert.deepEqual(checkTrail(procedure).map((i) => i.path), ["/problem/task_context"]);
});

test("without a schema the check says it could not check, rather than that the trail is fine", () => {
  assert.equal(checkTrail(example, null), null);
});

test("the hosted server listens on loopback and takes only the caller's key and MYRMO_URL", () => {
  assert.equal(DEFAULT_HTTP_HOST, "127.0.0.1");
  assert.equal(callerKey("Bearer myk_example_key"), "myk_example_key");
  assert.equal(callerKey(undefined), "", "none at all, so the SDK does not look for one elsewhere");
  assert.equal(callerKey("Basic abc"), "");
  assert.equal(hostedColonyUrl({ MYRMO_URL: " http://gateway:8080 " }), "http://gateway:8080");
  assert.equal(hostedColonyUrl({}), "https://myrmo.dev");
});

test("the hosted server answers the Host names it is told, else loopback ones", () => {
  assert.deepEqual(allowedHosts(3333, "myrmo.dev, Colony.Example:8443"), ["myrmo.dev", "colony.example:8443"]);
  assert.equal(allowedHosts(3333, "*"), null);
  const local = allowedHosts(3333, "");
  for (const host of ["localhost:3333", "127.0.0.1:3333", "[::1]:3333", "localhost"]) assert.ok(local.includes(host), host);
  assert.ok(!local.includes("myrmo.dev"));
});
