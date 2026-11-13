#!/usr/bin/env node
// The work log as a hook of its own, for a machine whose installed plugin does not have it yet. Register it for
// SessionStart, UserPromptSubmit and Stop. It only ever adds context; it never holds the agent back, and any problem means saying nothing.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { taskOf } from "./lookup.mjs";
import { readSettings } from "./on-failure.mjs";
import { DIGEST_SOURCES, digestMatters, digestNote, isContinuation, isPrivate, logExchange, recallEvents, recallNote, worklogTarget } from "./worklog.mjs";

const dir = () => process.env.MYRMO_WORKLOG_STATE_DIR || join(homedir(), ".myrmo", "worklog-state");
const fileOf = (session) => join(dir(), `${String(session ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}.txt`);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const settings = readSettings();
  const target = worklogTarget(input, { settings });
  if (!target) return;
  const file = fileOf(input.session_id);
  if (input.hook_event_name === "SessionStart") {
    if (!DIGEST_SOURCES.includes(input.source ?? "startup")) return;
    const note = digestNote(await digestMatters(input, target));
    if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }));
    return;
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    // The person marked this one private: nothing is kept for the Stop hook to log, and nothing is asked of the colony.
    if (isPrivate(input.prompt)) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(input.prompt ?? ""), { mode: 0o600 });
    const task = taskOf(input.prompt);
    const note = task || isContinuation(input.prompt) ? recallNote(await recallEvents(input, target, task)) : null;
    if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note } }));
    return;
  }
  if (input.hook_event_name === "Stop") {
    let prompt;
    try {
      prompt = readFileSync(file, "utf8");
    } catch {
      return; // Already logged: a stop the plugin's own hook continued.
    }
    rmSync(file, { force: true });
    await logExchange(input, target, prompt);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
