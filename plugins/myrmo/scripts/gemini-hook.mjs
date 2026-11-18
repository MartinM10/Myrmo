#!/usr/bin/env node
// The work log for Gemini CLI: the same thing the Claude Code hook (worklog-hook.mjs) does, with the events Gemini CLI has.
//
// Gemini CLI runs the hooks listed in ~/.gemini/settings.json (`hooks`), through bash (or PowerShell on Windows), writes a
// JSON object to the hook's standard input and reads a JSON object back from its standard output. Read in the source of
// Gemini CLI 0.68.0 (packages/core hooks) and its docs/hooks/reference.md. Every event carries
// { session_id, transcript_path, cwd, hook_event_name, timestamp }, plus:
//
//   SessionStart  { source: "startup" | "resume" | "clear" }   -> hookSpecificOutput.additionalContext reaches the model
//   BeforeAgent   { prompt }                                   -> hookSpecificOutput.additionalContext is added to the turn
//   AfterTool     { tool_name, tool_input, tool_response: { llmContent, returnDisplay, error? } }
//   AfterAgent    { prompt, prompt_response, stop_hook_active } the agent's final answer for the turn
//
// The hook runs with a sanitized environment (variables whose name holds KEY, TOKEN, SECRET… are removed), so
// MYRMO_WORKLOG=1 is set in the command init writes, and the colony's key is read from ~/.myrmo/config.json as always.
// Gemini CLI escapes < and > in additionalContext; the notes still read well.
//
// It never holds the agent back: it answers {} whenever it has nothing to say or anything goes wrong, and never denies.
// Like the Claude Code hook it does nothing unless MYRMO_WORKLOG=1, the colony is the organisation's own, the person is
// enrolled and the folder is covered (worklog.mjs: worklogTarget). A request that starts with //privado or //private is
// never logged.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toolLine } from "./cline-hook.mjs";
import { colonyOf, personalText, rememberDeclared, taskOf } from "./lookup.mjs";
import { readSettings } from "./on-failure.mjs";
import { redactText } from "./redact.mjs";
import { DIGEST_SOURCES, digestMatters, digestNote, isContinuation, isPrivate, recallEvents, recallNote, redactRandom, send, worklogTarget } from "./worklog.mjs";

const DAY = 86_400_000;

export const stateDir = (env = process.env) => env.MYRMO_WORKLOG_STATE_DIR || join(homedir(), ".myrmo", "worklog-state");
const safeId = (id) => String(id ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "none";
const fileOf = (dir, id) => join(dir, `gemini-${safeId(id)}.json`);

const safe = (target, text) => redactRandom(redactText(String(text ?? ""), {}, { keepNetwork: true, keepPersonal: target.keepPersonal === true }));

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sweep(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.startsWith("gemini-") && now - statSync(path).mtimeMs > DAY) rmSync(path, { force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

/**
 * What the person asked. In non-interactive mode Gemini CLI puts what a SessionStart hook returned in front of the
 * prompt, as <hook_context>…</hook_context>: that is this hook's own note, not the request, and is never logged.
 */
export function promptOf(text) {
  return String(text ?? "").replace(/<hook_context>[\s\S]*?<\/hook_context>/g, "").trim();
}

/** What Gemini CLI reads back to add text for the model. */
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** Whether a tool call failed: Gemini CLI puts an `error` in its response. */
export function failed(response) {
  const error = response?.error;
  return error !== undefined && error !== null && error !== "" && error !== false;
}

/**
 * Asks the colony what it is (GET /v1/version) and keeps its answer in ~/.myrmo/colonies.json, where the hooks read which
 * folders the work log covers. The MCP server keeps it too, but it may not have started yet, or ever, under Gemini CLI.
 */
export async function refreshDeclared({ env = process.env, settings = {}, fetcher = fetch, timeoutMs = 2500 } = {}) {
  const colony = colonyOf(env, settings);
  if (!colony.own || !colony.apiKey) return;
  try {
    const res = await fetcher(`${colony.url}/v1/version`, { headers: { accept: "application/json", authorization: `Bearer ${colony.apiKey}`, "user-agent": "myrmo-gemini-hook/1" }, signal: AbortSignal.timeout(timeoutMs) });
    const body = res.ok ? await res.json() : null;
    if (body?.colony) rememberDeclared(colony.url, body.colony, env);
  } catch {
    /* the last answer kept, if any, stands */
  }
}

/**
 * Handles one hook call. Returns what to say to Gemini CLI or null.
 * `deps` lets a test choose the clock, the environment, the folder for state and the way to reach the colony.
 */
export async function handle(input, { env = process.env, settings = readSettings(env), now = Date.now(), dir = stateDir(env), poster = send, recall = recallEvents, digest = digestMatters, refresh = refreshDeclared } = {}) {
  const event = String(input?.hook_event_name ?? "");
  const id = input?.session_id;
  const cwd = input?.cwd || env.GEMINI_CWD || process.cwd();
  const file = fileOf(dir, id);

  if (event === "SessionEnd") {
    rmSync(file, { force: true });
    return null;
  }
  if (event === "SessionStart" && env.MYRMO_WORKLOG === "1") await refresh({ env, settings });
  const target = worklogTarget({ cwd }, { env, settings });
  if (!target) return null;

  if (event === "SessionStart") {
    if (!DIGEST_SOURCES.includes(String(input.source ?? "startup"))) return null;
    const note = digestNote(await digest({ session_id: id }, target));
    return note ? context("SessionStart", note) : null;
  }

  if (event === "BeforeAgent") {
    const prompt = promptOf(input.prompt);
    rmSync(file, { force: true });
    if (!prompt || isPrivate(prompt)) return null; // marked private: nothing is kept, nothing is asked of the colony
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir, now);
    writeFileSync(file, JSON.stringify({ prompt, tools: [], at: now }), { mode: 0o600 });
    const task = taskOf(prompt);
    if (!task && !isContinuation(prompt)) return null;
    const note = recallNote(await recall({ prompt, session_id: id }, target, task));
    return note ? context("BeforeAgent", note) : null;
  }

  if (event === "AfterTool") {
    const state = readState(file);
    if (!state) return null; // a request marked private, or one this hook did not see
    const name = String(input.tool_name ?? "tool");
    const lines = [toolLine(name, input.tool_input)];
    if (failed(input.tool_response)) lines.push(`error: ${name} failed: ${String(input.tool_response.error?.message ?? input.tool_response.error).replace(/\s+/g, " ").slice(0, 200)}`);
    state.tools = [...(state.tools ?? []), ...lines].slice(-60);
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return null;
  }

  if (event === "AfterAgent") {
    const state = readState(file);
    rmSync(file, { force: true });
    const answer = String(input.prompt_response ?? "").trim();
    if (!state || !state.prompt || !answer) return null;
    await poster(target, "/v1/worklog/exchanges", {
      session: `gemini-${safeId(id)}`.slice(0, 64),
      scope: target.scope,
      repo: target.repo,
      branch: target.branch,
      prompt: safe(target, personalText(state.prompt).trim()).slice(0, 4000),
      answer: safe(target, answer).slice(0, 6000),
      activity: safe(target, (state.tools ?? []).join("\n")).slice(0, 3000),
    }, { timeoutMs: 8000 });
    return null;
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let out = null;
  try {
    out = await handle(JSON.parse(raw));
  } catch {
    out = null;
  }
  // Gemini CLI parses standard output as JSON: always answer with an object, an empty one when there is nothing to say.
  process.stdout.write(JSON.stringify(out ?? {}));
}

if (process.argv[1]?.endsWith("gemini-hook.mjs")) {
  main().catch(() => process.stdout.write("{}")).finally(() => process.exit(0));
}
