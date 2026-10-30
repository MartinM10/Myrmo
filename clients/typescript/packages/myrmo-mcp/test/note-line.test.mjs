// What the report tool says about the agent's note: whether the next agents will read it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteLine } from "../dist/server.js";

test("the agent is told what became of its note", () => {
  assert.match(noteLine("shown_with_trail"), /will be shown to the next agents/);
  assert.match(noteLine("shown_as_author_note"), /did not count \(you wrote the trail\), but your note will be shown with it as the author's note/);
  assert.match(noteLine("not_counted"), /was not kept/);
  assert.match(noteLine("withheld", "high_risk_command"), /NOT kept: it contains a command the colony withholds/);
  assert.equal(noteLine(undefined), "");
});
