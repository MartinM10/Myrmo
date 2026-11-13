// How a matter reaches the agent: newest state first, what failed marked, everything as untrusted data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMatter, formatMatters } from "../dist/worklog.js";

const event = (text, person = "ana", at = "2026-11-06T10:00:00Z") => ({ text, person, at });

test("the matters list says who, when, where it stands, and that it is untrusted", () => {
  const out = formatMatters({ matters: [
    { matter: "deploy", last_at: "2026-11-06T10:00:00Z", people: ["ana", "bruno"], repos: ["app"], events: 1, failed_attempts: 0, state: "waiting for the certificate" },
    { matter: "docs", last_at: "2026-11-05T10:00:00Z", people: ["ana"], repos: [], events: 4, failed_attempts: 2, state: null },
  ] });
  assert.match(out, /untrusted data/);
  assert.match(out, /1\. deploy · last 2026-11-06 · ana, bruno · app · 1 event\n\s+now: waiting for the certificate/);
  assert.match(out, /2\. docs .* 4 events · 2 tried and failed/);
  assert.match(out, /myrmo_matter/);
  assert.equal(formatMatters(null), "This colony keeps no work log.");
  assert.equal(formatMatters({ matters: [] }), "No matters recorded for that.");
});

test("a matter reads state first, then what was decided and what failed, and says what was left out", () => {
  const out = formatMatter({
    found: true, matter: "deploy", repos: ["app"], people: ["ana"], last_at: "2026-11-06T10:00:00Z",
    state: event("waiting for the certificate"), earlier_states: 2,
    decisions: [event("use the staging colony first")],
    failed_attempts: [event("the old script needs root", "bruno")],
    conclusions: [], facts: [event("the certificate takes a day")],
  });
  assert.ok(out.indexOf("NOW") < out.indexOf("DECIDED") && out.indexOf("DECIDED") < out.indexOf("TRIED AND FAILED"));
  assert.match(out, /NOW \[ana, 2026-11-06\] waiting for the certificate/);
  assert.match(out, /2 earlier states left out/);
  assert.match(out, /do not repeat it without telling the user why/);
  assert.match(out, /- \[bruno, 2026-11-06\] the old script needs root/);
  assert.doesNotMatch(out, /CONCLUDED/);
  assert.match(out, /untrusted data/);
});

test("a name that matches nothing lists what it could have meant, and every state shows when asked for", () => {
  assert.match(formatMatter({ found: false, matters: ["deploy", "docs"] }), /Recent matters: deploy; docs/);
  const out = formatMatter({
    found: true, matter: "m", repos: [], people: [], last_at: "", state: event("now"), earlier_states: [event("before")],
    decisions: [], failed_attempts: [], conclusions: [], facts: [],
  });
  assert.match(out, /EARLIER STATES \(replaced\):\n- \[ana, 2026-11-06\] before/);
});
