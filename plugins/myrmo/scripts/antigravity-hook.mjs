#!/usr/bin/env node
// The Myrmo hook for Antigravity (the editor and the `agy` CLI): the same reminders as the Claude Code hook
// (on-failure.mjs), delivered the way Antigravity allows.
//
// Antigravity's PostToolUse hook gets neither a command's output nor a way to talk to the model, and it does not pass an
// MCP server's instructions or tool names to the model either: measured in MyrmoBench, a small model with Myrmo connected
// and its rules in GEMINI.md searched it in 2 runs of 11. What Antigravity does offer is a PreInvocation hook, run before
// every call to the model, with the path of the conversation's transcript, and allowed to add a message to the next step
// (`injectSteps` with an `ephemeralMessage`). So this hook reads the steps added since it last ran, replays them through
// on-failure.mjs's `decide` as if Claude Code had reported them, and passes on its note.
//
// Register it in ~/.gemini/config/hooks.json (or a project's .agents/hooks.json):
//   { "myrmo": { "PreInvocation": [ { "type": "command", "command": "node /path/to/antigravity-hook.mjs" } ] } }
// It never blocks and answers {} whenever it has nothing to say or anything goes wrong. It sends nothing anywhere, except
// the error line of a failed command to the colony when the automatic lookup is on (lookup.mjs: by default only for a
// private colony).

import { existsSync, readFileSync } from "node:fs";
import { decide, readSettings } from "./on-failure.mjs";
import { briefEnabled, briefNote as sharedBriefNote, lookup, lookupEnabled, lookupNote as sharedLookupNote, lookupTask, taskOf } from "./lookup.mjs";
import { readState, stateFile, writeState } from "./state.mjs";

const EXIT = /The command exited with code (-?\d+)\./;
// What Antigravity prints around a command's output.
const OUTPUT = /(?:^|\n)(?:Output|Stdout|Stderr):\n/;
// In Antigravity the model reaches MCP tools only through call_mcp_tool, so the notes say how.
const HOW = ' In Antigravity, call it through call_mcp_tool with ServerName "myrmo".';

/** The steps of a transcript_full.jsonl, in order; a damaged line is skipped. */
export function readSteps(text) {
  const steps = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (step && typeof step === "object") steps.push(step);
    } catch {
      /* skip */
    }
  }
  return steps;
}

/** What a command printed, without Antigravity's own header lines. */
function outputOf(content) {
  const text = String(content ?? "");
  const at = text.search(OUTPUT);
  return (at >= 0 ? text.slice(at) : text).replace(/^\n?(?:Output|Stdout|Stderr):\n/gm, "").trim();
}

/**
 * The tool calls of the steps after `from`, paired with their results, in the shape on-failure.mjs's `decide` takes
 * from Claude Code: a failed shell command as PostToolUseFailure with "Exit code N" in `error`, a successful one as
 * PostToolUse with its output, and Myrmo's tools under an mcp__ name. Other tools are left out.
 */
/** The results of the calls of the model step at `i`: the GENERIC steps right after it, one per call. */
function resultsOf(steps, i) {
  const results = [];
  for (let j = i + 1; j < steps.length && steps[j].type === "GENERIC"; j++) results.push(steps[j]);
  return results;
}

/** Index (step_index) of the first model step from `from` on whose calls are not all answered yet; else the end. */
export function doneUntil(steps, from = 0) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const index = step.step_index ?? i;
    if (index < from || step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) continue;
    if (resultsOf(steps, i).length < step.tool_calls.length) return index;
  }
  return steps.length ? Math.max(...steps.map((s, i) => Number(s.step_index ?? i))) + 1 : from;
}

export function events(steps, from = 0) {
  const out = [];
  const until = doneUntil(steps, from);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const index = step.step_index ?? i;
    if (index < from || index >= until || step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) continue;
    const results = resultsOf(steps, i);
    step.tool_calls.forEach((call, n) => {
      const result = results[n];
      if (!result) return; // still running: its result comes in a later invocation
      const content = String(result.content ?? "");
      if (call.name === "run_command") {
        const code = Number(EXIT.exec(content)?.[1] ?? 0);
        const command = String(call.args?.CommandLine ?? "");
        const output = outputOf(content);
        out.push(code !== 0
          ? { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code ${code}\n${output}` }
          : { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: output } });
      } else if (call.name === "call_mcp_tool" && String(call.args?.ServerName ?? "").toLowerCase() === "myrmo") {
        const args = call.args?.Arguments ?? {};
        out.push({ hook_event_name: "PostToolUse", tool_name: `mcp__myrmo__${call.args?.ToolName}`, tool_input: args,
                   tool_response: [{ type: "text", text: content }] });
      }
    });
  }
  return out;
}

/** The newest request the user sent since `from` (a USER_INPUT step), as text; "" when there is none. */
export function newRequest(steps, from = 0) {
  let request = "";
  steps.forEach((step, i) => {
    const index = Number(step.step_index ?? i);
    if (index >= from && step.type === "USER_INPUT") request = String(step.content ?? "");
  });
  return request;
}

/** Run the steps since the last call through `decide`; the last note it produced is the one to show. */
export function step(input, state = {}, { now = Date.now(), env = process.env, settings = {}, transcript } = {}) {
  const steps = readSteps(transcript ?? "");
  const from = Number(state.agyNext ?? 0);
  let note = null;
  let current = state;
  for (const event of events(steps, from)) {
    const out = decide(event, { now, state: current, env, settings });
    current = out.state;
    if (out.note) note = out.note;
  }
  // A model step whose calls are still running is read again next time, with its results.
  const next = { ...current, agyNext: doneUntil(steps, from) };
  // The error line a reminder to search quotes: what an automatic lookup searches for.
  const failure = note && /a command just failed|finished with exit 0/.test(note) ? (/«(.+?)»/.exec(note)?.[1] ?? "") : "";
  // A request the user just sent: what the task lookup searches for.
  const task = taskOf(newRequest(steps, from));
  return { note: note && note.includes("myrmo_") ? note + HOW : note, state: next, failure, task };
}

// --- automatic lookup (lookup.mjs): on for a private colony, MYRMO_HOOK_LOOKUP=1 elsewhere --------------------------

export { lookup };

/** lookup.mjs's task list, with the way Antigravity reaches Myrmo's tools. */
export function briefNote(task, body, state, now = Date.now()) {
  return sharedBriefNote(task, body, state, now, HOW);
}

/** lookup.mjs's note, with the way Antigravity reaches Myrmo's tools. */
export function lookupNote(line, body, state, now = Date.now()) {
  return sharedLookupNote(line, body, state, now, HOW);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const file = stateFile(input.conversationId, { prefix: "agy-" });
  const state = readState(file);
  const transcript = input.transcriptPath && existsSync(input.transcriptPath) ? readFileSync(input.transcriptPath, "utf8") : "";
  const out = step(input, state, { settings: readSettings(), transcript });
  const settings = readSettings();
  if (out.failure && lookupEnabled(process.env, settings)) {
    const body = await lookup(out.failure, { settings, agent: "myrmo-antigravity-hook/1" });
    if (body) Object.assign(out, lookupNote(out.failure, body, out.state));
  }
  // A new request: what the organisation already knows about the task, before the model plans it.
  if (out.task && briefEnabled(process.env, settings)) {
    const body = await lookupTask(out.task, { settings, agent: "myrmo-antigravity-hook/1" });
    const brief = briefNote(out.task, body, out.state);
    if (brief.note) {
      out.note = out.note ? `${brief.note}\n\n${out.note}` : brief.note;
      out.state = brief.state;
    }
  }
  // Without the file the notes are simply not throttled.
  writeState(file, out.state);
  process.stdout.write(JSON.stringify(out.note ? { injectSteps: [{ ephemeralMessage: out.note }] } : {}));
}

if (process.argv[1]?.endsWith("antigravity-hook.mjs")) {
  main().catch(() => process.stdout.write("{}")).finally(() => process.exit(0));
}
