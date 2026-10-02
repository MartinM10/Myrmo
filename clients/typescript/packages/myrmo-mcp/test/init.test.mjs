// `myrmo-mcp init` edits settings files that belong to the user's other tools: it must keep
// everything else in them, change nothing twice and refuse files it cannot parse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_BLOCK, mergeServer, parseInitArgs, runInit, serverEntry, upsertBlock } from "../dist/init.js";

const entry = serverEntry("linux");
const quiet = () => {};
const newHome = () => mkdtempSync(join(tmpdir(), "myrmo-init-"));

test("merging keeps the other servers and settings", () => {
  const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: [] } } });
  const out = mergeServer(before, entry);
  assert.equal(out.changed, true);
  const doc = JSON.parse(out.text);
  assert.equal(doc.theme, "dark");
  assert.deepEqual(doc.mcpServers.other, { command: "x", args: [] });
  assert.deepEqual(doc.mcpServers.myrmo, entry);
});

test("merging twice changes nothing the second time, and an empty or missing file is fine", () => {
  const once = mergeServer(undefined, entry);
  assert.equal(once.changed, true);
  assert.equal(mergeServer(once.text, entry).changed, false);
  assert.equal(mergeServer("   ", entry).changed, true);
});

test("a file that is not a JSON object is refused, never overwritten", () => {
  assert.equal(mergeServer("{ not json", entry), null);
  assert.equal(mergeServer("[1,2]", entry), null);
  assert.equal(mergeServer("null", entry), null);
});

test("Windows clients start npx through cmd", () => {
  assert.deepEqual(serverEntry("win32"), { command: "cmd", args: ["/c", "npx", "-y", "myrmo-mcp"] });
});

test("init configures only the clients that are installed, and leaves the rest of their files alone", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "k" } } }));
  const res = runInit({ clients: ["cursor", "windsurf", "gemini"], dryRun: false, home, log: quiet });
  assert.deepEqual(res.skipped, []);
  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers.keep && cursor.mcpServers.myrmo);
  assert.ok(existsSync(join(home, ".gemini", "settings.json")), "a client named on purpose is configured even if its folder is new");
});

test("without --client, a client that is not installed is not touched", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  const res = runInit({ clients: [], dryRun: false, home, log: quiet });
  assert.ok(res.configured.includes("Cursor"));
  assert.ok(!existsSync(join(home, ".gemini")), "Gemini CLI is not installed here, so nothing is created");
  assert.ok(!existsSync(join(home, ".codeium")));
});

test("a dry run writes nothing", () => {
  const home = newHome();
  const lines = [];
  runInit({ clients: ["cursor"], dryRun: true, home, log: (l) => lines.push(l) });
  assert.ok(!existsSync(join(home, ".cursor")));
  assert.match(lines.join("\n"), /would add/);
});

test("an unreadable settings file is reported and left as it was", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), "{ // comments are not JSON");
  const lines = [];
  const res = runInit({ clients: ["cursor"], dryRun: false, home, log: (l) => lines.push(l) });
  assert.deepEqual(res.skipped, ["Cursor"]);
  assert.equal(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"), "{ // comments are not JSON");
  assert.match(lines.join("\n"), /by hand/);
});

test("init never decides whether agents may publish", () => {
  const home = newHome();
  runInit({ clients: ["cursor"], dryRun: false, home, log: quiet });
  assert.ok(!existsSync(join(home, ".myrmo")), "the publishing choice file is not created");
});

test("the instructions block is added once and updated in place", () => {
  const first = upsertBlock("# My project\n\nRules.\n");
  assert.ok(first.startsWith("# My project"));
  assert.match(first, /myrmo_search/);
  assert.equal(upsertBlock(first), first, "a second run changes nothing");
  const edited = first.replace("BEFORE attempting a fix", "OLD TEXT");
  assert.ok(!upsertBlock(edited).includes("OLD TEXT"), "an older copy is replaced");
  assert.ok(upsertBlock(edited).startsWith("# My project"));
  assert.equal((upsertBlock(first).match(/myrmo:start/g) ?? []).length, 1);
  assert.ok(AGENTS_BLOCK.includes("Publishing is the"));
});

test("arguments are validated", () => {
  assert.equal(typeof parseInitArgs(["--client", "emacs"]), "string");
  assert.equal(typeof parseInitArgs(["--nope"]), "string");
  assert.deepEqual(parseInitArgs(["--client", "cursor", "--dry-run", "--agents-md"]), { clients: ["cursor"], dryRun: true, agentsMd: "AGENTS.md" });
});
