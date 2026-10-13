// An organisation's private colony: its network names are kept, it is searched by task, and procedures and facts are
// rendered for the agent as what they are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colony, formatBrief, formatResult, redactText } from "../dist/index.js";

process.env.MYRMO_CONFIG = join(mkdtempSync(join(tmpdir(), "myrmo-knowledge-")), "config.json");

test("an organisation keeps its network but not its secrets", () => {
  const org = (s) => redactText(s, {}, { keepNetwork: true });
  assert.equal(org("ssh ops@10.40.2.17 and curl http://lldap.corp:17170"), "ssh ops@10.40.2.17 and curl http://lldap.corp:17170");
  assert.equal(org("postgres://admin:hunter2@db.internal:5432/app"), "postgres://<redacted:connection_string>@db.internal:5432/app");
  assert.equal(org("password=SuperSecret123"), "password=<redacted:secret>");
  assert.equal(org("mail ana.garcia@acme.com"), "mail <redacted:email>");
  assert.equal(redactText("ssh 10.40.2.17"), "ssh <redacted:ip>", "the public policy is unchanged");
});

const fact = {
  protocol_version: "1.6",
  kind: "fact",
  agent_info: { model: "m", framework: "f" },
  problem: {
    summary: "LLDAP users are managed with OpenTofu on the ops-01 machine 10.40.2.17",
    task_context: "Adding or removing a person or a service login",
    failed_approaches: [{ approach: "writing only the new entry in terraform.tfvars", why_it_failed: "tofu apply deletes every entry not listed" }],
  },
  solution: { steps: ["ssh ops@10.40.2.17", "tofu plan, then tofu apply"] },
  source: { type: "handover", ref: "docs/04-users.md#4.4", revision: "a1b2c3d" },
};
const hit = (over = {}) => ({
  trailId: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
  kind: "fact",
  match: { via: "task", score: 0.7, environment_overlap: null },
  strength: 0.4,
  outcomes: { worked: 1, partially_worked: 0, failed: 0 },
  risk: { level: "low", flags: [] },
  trail: fact,
  ...over,
});

test("a fact is rendered as a fact, with when it applies, its pitfalls and where it came from", () => {
  const text = formatBrief({ fingerprint: "", hits: [hit()], notice: "untrusted", source: "search" });
  assert.match(text, /^<myrmo_knowledge untrusted="true">/);
  assert.match(text, /## 1 of 1 · fact · id 5d2c1b0a/);
  assert.match(text, /Fact: LLDAP users are managed/);
  assert.match(text, /When it applies: Adding or removing a person/);
  assert.match(text, /Source: handover · docs\/04-users.md#4.4 @ a1b2c3d/);
  assert.match(text, /Known pitfalls, do not repeat:\n- writing only the new entry/);
  assert.match(text, /Details:\n1\. ssh ops@10\.40\.2\.17/);
  // Also when a fact turns up among the results of an error search: no crash on the fields a fact does not have.
  assert.match(formatResult({ fingerprint: "fp2_0123456789abcdef", hits: [hit()], notice: "n", source: "search" }), /Fact: LLDAP/);
});

test("nothing known about a task says so, and asks to share what is learned", () => {
  const text = formatBrief({ fingerprint: "", hits: [], notice: "", source: "search" });
  assert.match(text, /nothing written down about this task yet/);
  assert.match(text, /publish it with myrmo_publish/);
});

test("searchTask asks the task index, keeps the organisation's names, and treats a colony without one as knowing nothing", async () => {
  const seen = [];
  let index = true;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push(JSON.parse(body));
    if (!index) return res.writeHead(501, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "no_task_index", message: "none" } }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode: "task", results: [{ trail_id: hit().trailId, kind: "fact", match: hit().match, strength: 0.4, outcomes: hit().outcomes, risk: hit().risk, trail: fact }], notice: "untrusted" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const colony = new Colony({ url, private: true, agentId: false, retries: 0 });
    const result = await colony.searchTask("reinicia el LDAP de 10.40.2.17");
    assert.equal(seen[0].mode, "task");
    assert.equal(seen[0].query, "reinicia el LDAP de 10.40.2.17");
    assert.equal(result.hits[0].kind, "fact");
    const publicPolicy = new Colony({ url, agentId: false, retries: 0 });
    await publicPolicy.searchTask("reinicia el LDAP de 10.40.2.18");
    assert.equal(seen[1].query, "reinicia el LDAP de <redacted:ip>");
    index = false;
    const none = await new Colony({ url, private: true, agentId: false, retries: 0 }).searchTask("anything at all");
    assert.equal(none.hits.length, 0);
  } finally {
    server.close();
  }
});
