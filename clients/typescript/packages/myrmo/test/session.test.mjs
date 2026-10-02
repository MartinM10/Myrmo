import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, fingerprint, redactText } from "../dist/index.js";

const colony = { publishMode: "off", search: async () => ({ fingerprint: "fp1_0000000000000000", hits: [], notice: "", source: "search" }) };

test("the session fingerprints the redacted message, like the colony does", async () => {
  const session = new Session(colony, { task: "connect", runtime: "node", runtimeVersion: "22.1.0" });
  await session.failed(new Error("connect ECONNREFUSED 10.0.3.17:5432"));
  const raw = fingerprint("node", "Error", "Error: connect ECONNREFUSED 10.0.3.17:5432");
  const redacted = fingerprint("node", "Error", redactText("Error: connect ECONNREFUSED 10.0.3.17:5432"));
  assert.notEqual(raw, redacted, "the order matters for messages with personal data");
  assert.equal(session.lastFingerprint, redacted);
});
