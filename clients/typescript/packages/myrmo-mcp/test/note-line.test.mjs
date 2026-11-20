// What the report tool says about the agent's note: whether the next agents will read it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteLine, notCountedLine } from "../dist/server.js";

test("the agent is told what became of its note", () => {
  assert.match(noteLine("shown_with_trail"), /will be shown to the next agents/);
  assert.match(noteLine("shown_as_author_note"), /did not count \(you wrote the trail\), but your note will be shown with it as the author's note/);
  assert.match(noteLine("not_counted"), /was not kept/);
  // A colony that says why: the agent hears it.
  assert.match(noteLine("not_counted", "address_limit"), /not kept either: your address used up its reports on this trail/);
  assert.match(notCountedLine("already_reported_today"), /^ \(not counted: you already reported this trail in the last 24 hours\)$/);
  assert.match(notCountedLine(undefined), /one report per agent and trail per day/);
  assert.match(notCountedLine("something_new"), /one report per agent and trail per day/);
  assert.match(noteLine("withheld", "high_risk_command"), /NOT kept: it contains a command the colony withholds/);
  assert.equal(noteLine(undefined), "");
});
