// `myrmo-mcp init` edits settings files that belong to the user's other tools: it must keep
// everything else in them, change nothing twice and refuse files it cannot parse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_BLOCK, AGENTS_BLOCK_READ_ONLY, SHAPES, claudeCodeSetUp, mergeCodex, mergeServer, parseInitArgs, runInit, serverEntry, targets, upsertBlock } from "../dist/init.js";

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
  assert.deepEqual(serverEntry("win32"), { command: "cmd", args: ["/c", "npx", "-y", "myrmo-mcp@latest"] });
});

test("init configures only the clients that are installed, and leaves the rest of their files alone", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "k" } } }));
  const res = runInit({ env: { PATH: "" }, clients: ["cursor", "windsurf", "gemini"], dryRun: false, home, log: quiet });
  assert.deepEqual(res.skipped, []);
  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers.keep && cursor.mcpServers.myrmo);
  assert.ok(existsSync(join(home, ".gemini", "settings.json")), "a client named on purpose is configured even if its folder is new");
});

test("without --client, a client that is not installed is not touched", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  const res = runInit({ env: { PATH: "" }, clients: [], dryRun: false, home, log: quiet });
  assert.ok(res.configured.includes("Cursor"));
  assert.ok(!existsSync(join(home, ".gemini")), "Gemini CLI is not installed here, so nothing is created");
  assert.ok(!existsSync(join(home, ".codeium")));
});

test("a dry run writes nothing", () => {
  const home = newHome();
  const lines = [];
  runInit({ env: { PATH: "" }, clients: ["cursor"], dryRun: true, home, log: (l) => lines.push(l) });
  assert.ok(!existsSync(join(home, ".cursor")));
  assert.match(lines.join("\n"), /would add/);
});

test("an unreadable settings file is reported and left as it was", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), "{ // comments are not JSON");
  const lines = [];
  const res = runInit({ env: { PATH: "" }, clients: ["cursor"], dryRun: false, home, log: (l) => lines.push(l) });
  assert.deepEqual(res.skipped, ["Cursor"]);
  assert.equal(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"), "{ // comments are not JSON");
  assert.match(lines.join("\n"), /by hand/);
});

test("init never decides whether agents may publish", () => {
  const home = newHome();
  runInit({ env: { PATH: "" }, clients: ["cursor"], dryRun: false, home, log: quiet });
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

test("Claude Code is not given the server twice when the plugin or a server is already there", () => {
  const home = newHome();
  assert.equal(claudeCodeSetUp(home), null);

  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "myrmo@myrmo": [{}] } }));
  assert.match(claudeCodeSetUp(home), /plugin/);

  const other = newHome();
  writeFileSync(join(other, ".claude.json"), JSON.stringify({ mcpServers: { myrmo: { command: "cmd" } } }));
  assert.match(claudeCodeSetUp(other), /already registered/);

  const project = newHome();
  writeFileSync(join(project, ".claude.json"), JSON.stringify({ projects: { "/some/dir": { mcpServers: { myrmo: {} } } } }));
  assert.match(claudeCodeSetUp(project), /already registered/);

  const unrelated = newHome();
  writeFileSync(join(unrelated, ".claude.json"), JSON.stringify({ mcpServers: { github: {} } }));
  assert.equal(claudeCodeSetUp(unrelated), null);
});

test("init says so and adds nothing when the plugin is installed", () => {
  const home = newHome();
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "myrmo@myrmo": [{}] } }));
  const lines = [];
  const res = runInit({ env: { PATH: "" }, clients: [], dryRun: false, home, log: (l) => lines.push(l) });
  assert.ok(res.configured.includes("Claude Code"));
  const said = lines.join("\n");
  assert.match(said, /already set up \(the Myrmo plugin is installed\)/);
  assert.doesNotMatch(said, /claude mcp add --scope/);
});

test("the search-and-report block tells agents not to publish, and is written on request", () => {
  assert.match(AGENTS_BLOCK_READ_ONLY, /do NOT publish/);
  assert.match(AGENTS_BLOCK_READ_ONLY, /never call myrmo_publish/);
  assert.doesNotMatch(AGENTS_BLOCK_READ_ONLY, /If you fixed an error/, "no step explains how to publish");
  assert.match(AGENTS_BLOCK_READ_ONLY, /myrmo_search/);
  assert.match(AGENTS_BLOCK_READ_ONLY, /myrmo_report/);
  const dir = newHome();
  const file = join(dir, "AGENTS.md");
  runInit({ env: { PATH: "" }, clients: ["cursor"], dryRun: false, home: dir, agentsMd: file, readOnly: true, log: quiet });
  assert.match(readFileSync(file, "utf8"), /do NOT publish/);
  runInit({ env: { PATH: "" }, clients: ["cursor"], dryRun: false, home: dir, agentsMd: file, log: quiet });
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /do NOT publish/, "the full block replaces it in place");
  assert.equal((text.match(/myrmo:start/g) ?? []).length, 1);
});

test("--read-only needs --agents-md", () => {
  assert.equal(typeof parseInitArgs(["--read-only"]), "string");
  assert.deepEqual(parseInitArgs(["--agents-md", "--read-only"]), { clients: [], dryRun: false, agentsMd: "AGENTS.md", readOnly: true });
});

test("VS Code (GitHub Copilot) takes a `servers` object with an explicit stdio type, and keeps what is there", () => {
  const before = JSON.stringify({ inputs: [], servers: { other: { type: "stdio", command: "x" } } });
  const out = mergeServer(before, entry, SHAPES.vscode);
  const doc = JSON.parse(out.text);
  assert.deepEqual(doc.servers.myrmo, { type: "stdio", command: "npx", args: ["-y", "myrmo-mcp@latest"] });
  assert.ok(doc.servers.other && Array.isArray(doc.inputs));
  assert.equal(mergeServer(out.text, entry, SHAPES.vscode).changed, false);
});

test("OpenCode takes a `mcp` object with the command as one array", () => {
  const out = mergeServer(JSON.stringify({ theme: "x", mcp: { other: { type: "remote", url: "https://x.test" } } }), entry, SHAPES.opencode);
  const doc = JSON.parse(out.text);
  assert.deepEqual(doc.mcp.myrmo, { type: "local", command: ["npx", "-y", "myrmo-mcp@latest"], enabled: true });
  assert.ok(doc.mcp.other && doc.theme === "x");
  assert.equal(mergeServer(out.text, entry, SHAPES.opencode).changed, false);
});

test("Codex gets a [mcp_servers.myrmo] table appended to config.toml, once, and the rest of the file is kept", () => {
  const before = 'model = "gpt-5"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n';
  const out = mergeCodex(before, entry);
  assert.equal(out.changed, true);
  assert.ok(out.text.startsWith(before.trimEnd()), "what was there is untouched");
  assert.match(out.text, /\n\[mcp_servers\.myrmo\]\ncommand = "npx"\nargs = \["-y","myrmo-mcp@latest"\]\n$/);
  assert.equal(mergeCodex(out.text, entry).changed, false, "a second run changes nothing");
  assert.equal(mergeCodex(undefined, entry).text.includes("[mcp_servers.myrmo]"), true, "a missing file is created");
  assert.equal(mergeCodex("   \n", entry).changed, true);
});

test("Codex's file is left alone when appending a table could make it invalid", () => {
  assert.equal(mergeCodex('[mcp_servers.myrmo]\ncommand = "node"\nargs = ["x"]\n', entry), null, "myrmo is already set up differently");
  assert.equal(mergeCodex('mcp_servers.myrmo.command = "node"\n', entry), null, "a dotted key");
  assert.equal(mergeCodex('[mcp_servers."myrmo"]\ncommand = "node"\n', entry), null, "a quoted key");
  assert.equal(mergeCodex('[mcp_servers.myrmo.env]\nX = "1"\n', entry), null, "a sub-table");
  assert.equal(mergeCodex('mcp_servers = { a = { command = "x" } }\n', entry), null, "mcp_servers set inline");
});

test("init configures VS Code, OpenCode and Codex, each in its own file and shape", () => {
  const home = newHome();
  const res = runInit({ env: { PATH: "" }, clients: ["vscode", "opencode", "codex"], dryRun: false, home, log: quiet });
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.configured.sort(), ["Codex", "OpenCode", "VS Code (GitHub Copilot)"]);
  const by = Object.fromEntries(targets(home).map((t) => [t.id, t.file]));
  assert.equal(JSON.parse(readFileSync(by.vscode, "utf8")).servers.myrmo.type, "stdio");
  assert.equal(JSON.parse(readFileSync(by.opencode, "utf8")).mcp.myrmo.type, "local");
  assert.match(readFileSync(by.codex, "utf8"), /\[mcp_servers\.myrmo\]/);
  const again = runInit({ env: { PATH: "" }, clients: ["vscode", "opencode", "codex"], dryRun: false, home, log: (l) => assert.doesNotMatch(l, /did add|would add/) });
  assert.deepEqual(again.skipped, []);
});

test("a Codex file that cannot be edited safely is skipped with the table to add by hand", () => {
  const home = newHome();
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'mcp_servers = { a = { command = "x" } }\n');
  const lines = [];
  const res = runInit({ env: { PATH: "" }, clients: ["codex"], dryRun: false, home, log: (l) => lines.push(l) });
  assert.deepEqual(res.skipped, ["Codex"]);
  const command = process.platform === "win32" ? /command = "cmd" args = \["\/c","npx"/ : /command = "npx"/;
  assert.match(lines.join("\n"), command);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), 'mcp_servers = { a = { command = "x" } }\n', "the file is untouched");
});

test("OpenCode's opencode.jsonc is used when it is the file that exists", () => {
  const home = newHome();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "{}\n");
  assert.ok(targets(home).find((t) => t.id === "opencode").file.endsWith("opencode.jsonc"));
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{}\n");
  assert.ok(targets(home).find((t) => t.id === "opencode").file.endsWith("opencode.json"), "opencode.json wins when both exist");
});

test("without --client, VS Code, OpenCode and Codex that are not installed are not touched", () => {
  const home = newHome();
  mkdirSync(join(home, ".cursor"));
  runInit({ env: { PATH: "" }, clients: [], dryRun: false, home, log: quiet });
  assert.ok(!existsSync(join(home, ".codex")) && !existsSync(join(home, ".config")) && !existsSync(join(home, "Library")));
});

test("--client accepts the new ids", () => {
  for (const id of ["vscode", "opencode", "codex"]) assert.deepEqual(parseInitArgs(["--client", id]).clients, [id]);
  assert.match(parseInitArgs(["--client", "emacs"]), /vscode, opencode, codex/);
});
