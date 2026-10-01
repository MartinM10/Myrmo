// k6 load test for a Myrmo colony. One scenario per path, run one after another so each
// number measures that path alone.
//
//   k6 run -e BASE=http://gateway:8080 -e VUS=64 bench/load/load.js
//
// Needs bench/load/targets.json from populate.py.

import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const BASE = __ENV.BASE || "http://localhost:8080";
const VUS = Number(__ENV.VUS || 64);
const SECONDS = Number(__ENV.SECONDS || 30);
const DURATION = `${SECONDS}s`;
const targets = JSON.parse(open("./targets.json"));
const seeds = JSON.parse(open("../../deploy/seed/trails.json"));

const step = (name, fn, startAfter) => ({
  executor: "constant-vus",
  exec: fn,
  vus: VUS,
  duration: DURATION,
  startTime: startAfter,
  tags: { path: name },
});

// Semantic search below saturation: latency a typical agent sees.
const SEARCH_RATE = Number(__ENV.SEARCH_RATE || 40);
const gap = SECONDS + 5;

const PATHS = ["Fingerprint lookup", "Semantic search", `Semantic search (${SEARCH_RATE} req/s)`, "Publish (202)", "Outcome report"];

export const options = {
  discardResponseBodies: true,
  scenarios: {
    lookup: step(PATHS[0], "lookup", "0s"),
    search: step(PATHS[1], "search", `${gap}s`),
    searchPaced: {
      executor: "constant-arrival-rate",
      exec: "search",
      rate: SEARCH_RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 32,
      maxVUs: 128,
      startTime: `${2 * gap}s`,
      tags: { path: PATHS[2] },
    },
    publish: step(PATHS[3], "publish", `${3 * gap}s`),
    outcome: step(PATHS[4], "outcome", `${4 * gap}s`),
  },
  summaryTrendStats: ["med", "p(99)"],
  // Every path must stay below 1% errors. Thresholds also make k6 keep per-path metrics.
  thresholds: Object.fromEntries(
    PATHS.flatMap((p) => [
      [`http_req_failed{path:${p}}`, ["rate<0.01"]],
      [`http_req_duration{path:${p}}`, ["max>=0"]],
      [`http_reqs{path:${p}}`, ["count>0"]],
    ]),
  ),
};

const json = { headers: { "content-type": "application/json" } };
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const WORDS = ["socket", "linker", "wheel", "lockfile", "runtime", "gpu", "proxy", "certificate", "schema", "thread"];

export function lookup() {
  const res = http.get(`${BASE}/v1/trails/by-fingerprint/${pick(targets.fingerprints)}`);
  check(res, { "200": (r) => r.status === 200 });
}

export function search() {
  // Unseen queries: no fingerprint hit, so every request embeds and searches the index.
  const seed = pick(seeds);
  const query = `${seed.problem.error_message} while building ${pick(WORDS)} ${Math.random().toString(36).slice(2, 8)}`;
  const res = http.post(`${BASE}/v1/search`, JSON.stringify({ query, environment: seed.environment }), json);
  check(res, { "200": (r) => r.status === 200 });
}

export function publish() {
  const trail = JSON.parse(JSON.stringify(pick(seeds)));
  trail.problem.error_message = `${trail.problem.error_message} [load ${exec.vu.idInTest}-${exec.vu.iterationInScenario}]`;
  trail.agent_info = { model: "synthetic", framework: "myrmo-bench" };
  const res = http.post(`${BASE}/v1/trails`, JSON.stringify(trail), json);
  check(res, { "202": (r) => r.status === 202 });
}

export function outcome() {
  const id = pick(targets.trail_ids);
  const body = {
    protocol_version: "1.0",
    outcome: Math.random() < 0.85 ? "worked" : "failed",
    agent_info: { model: "synthetic", framework: "myrmo-bench" },
  };
  const headers = { "content-type": "application/json", "x-myrmo-agent": `bench_${exec.vu.idInTest}_${exec.vu.iterationInScenario}` };
  const res = http.post(`${BASE}/v1/trails/${id}/outcomes`, JSON.stringify(body), { headers });
  check(res, { "202": (r) => r.status === 202 });
}

export function handleSummary(data) {
  const out = { date: new Date().toISOString().slice(0, 10), vus: VUS, duration: DURATION, scenarios: [] };
  for (const name of PATHS) {
    const d = data.metrics[`http_req_duration{path:${name}}`];
    const n = data.metrics[`http_reqs{path:${name}}`];
    const f = data.metrics[`http_req_failed{path:${name}}`];
    if (!d || !n) continue;
    out.scenarios.push({
      name,
      requests: n.values.count,
      rps: n.values.count / SECONDS,
      p50_ms: d.values.med,
      p99_ms: d.values["p(99)"],
      error_rate: f ? f.values.rate : 0,
    });
  }
  return { stdout: JSON.stringify(out, null, 2) + "\n", "/results/load-summary.json": JSON.stringify(out, null, 2) };
}
