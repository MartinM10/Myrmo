#!/usr/bin/env node
// The work log for Antigravity (its editor, Antigravity 2.0 and the `agy` CLI): the same thing the Claude Code hook
// (worklog-hook.mjs) and the Gemini CLI hook (gemini-hook.mjs) do, with what Antigravity offers.
//
// Antigravity runs the hooks named in ~/.gemini/config/hooks.json (named groups, merged and run in order), through
// `sh -c` (or `cmd /c` on Windows), writes a JSON object to the hook's standard input and reads one back. Read in the
// contract `agy` 1.3.6 ships. Every event carries { conversationId, workspacePaths, transcriptPath, artifactDirectoryPath,
// modelName }, and:
//
//   SessionStart   once per conversation                -> { injectSteps: [{ ephemeralMessage }] } reaches the model
//   PreInvocation  { invocationNum, initialNumSteps }  before every call to the model, same answer
//   Stop           { terminationReason, error, fullyIdle } the loop ended: the turn's answer is in the transcript
//
// No event hands over the request or the answer, so this hook reads them from the transcript (JSON lines, one step each):
// USER_INPUT { content: "<USER_REQUEST>…</USER_REQUEST>…" }, PLANNER_RESPONSE { content?, tool_calls? }, and GENERIC
// { content, error? } with the result of each call. A turn is a request and everything up to the next one; its answer is
// the last thing the model said in it. A turn is sent once, when the loop stops, or else when the next request arrives.
//
// It never holds the agent back: it answers {} whenever it has nothing to say or anything goes wrong. Like the others it
// does nothing unless the work log is on (MYRMO_WORKLOG=1, or --worklog in the command init writes), the colony is the
// organisation's own, the person is enrolled and the folder is covered (worklog.mjs: worklogTarget). A request that starts
// with //privado or //private is never logged.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readSteps } from "./antigravity-hook.mjs";
import { refreshDeclared } from "./gemini-hook.mjs";
import { personalText, taskOf } from "./lookup.mjs";
import { readSettings } from "./on-failure.mjs";
import { redactText } from "./redact.mjs";
import { digestMatters, digestNote, isContinuation, isPrivate, recallEvents, recallNote, redactRandom, send, worklogTarget } from "./worklog.mjs";

const DAY = 86_400_000;
const EXIT = /The command exited with code (-?\d+)\./;

export const stateDir = (env = process.env) => env.MYRMO_WORKLOG_STATE_DIR || join(homedir(), ".myrmo", "worklog-state");
const safeId = (id) => String(id ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "none";
const fileOf = (dir, id) => join(dir, `agy-worklog-${safeId(id)}.json`);
const oneLine = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const safe = (target, text) => redactRandom(redactText(String(text ?? ""), {}, { keepNetwork: true, keepPersonal: target.keepPersonal === true }));

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function writeState(dir, file, state, now) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.startsWith("agy-worklog-") && now - statSync(path).mtimeMs > DAY) rmSync(path, { force: true });
    }
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* without the file a turn may be sent again, never lost */
  }
}

/** What the person typed: the text inside <USER_REQUEST>, without the metadata Antigravity adds after it. */
export function requestOf(content) {
  const text = String(content ?? "");
  const inner = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  return (inner ? inner[1] : text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/, "")).trim();
}

/** One line for a tool call: its name and what it worked on. */
export function callLine(call) {
  const a = call?.args ?? {};
  const name = String(call?.name ?? "tool");
  if (name === "call_mcp_tool") return `${name}: ${oneLine(`${a.ServerName ?? ""} ${a.ToolName ?? ""}`, 200)}`;
  const target = a.CommandLine ?? a.AbsolutePath ?? a.TargetFile ?? a.DirectoryPath ?? a.SearchPath ?? a.SearchDirectory ?? a.Query ?? a.query ?? a.Pattern ?? a.Url ?? a.Prompt ?? a.Description ?? "";
  return `${name}: ${oneLine(typeof target === "string" ? target : JSON.stringify(target), 200)}`;
}

/** Why a tool call failed, from its result step; "" when it did not. */
export function failureOf(call, result) {
  if (!result) return "";
  if (result.error) return oneLine(result.error, 200);
  if (call?.name === "run_command") {
    const code = Number(EXIT.exec(String(result.content ?? ""))?.[1] ?? 0);
    if (code !== 0) return `exit code ${code}`;
  }
  return "";
}

/**
 * The turns of a transcript: each request (USER_INPUT) with the tool calls of the steps after it, their failures and the
 * last thing the model said before the next request. `start` is the request's step_index.
 */
export function turns(steps) {
  const out = [];
  let turn = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const index = Number(step.step_index ?? i);
    if (step.type === "USER_INPUT") {
      turn = { start: index, request: requestOf(step.content), tools: [], answer: "" };
      out.push(turn);
      continue;
    }
    if (!turn || step.type !== "PLANNER_RESPONSE") continue;
    if (String(step.content ?? "").trim()) turn.answer = String(step.content).trim();
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const results = [];
    for (let j = i + 1; j < steps.length && steps[j].type === "GENERIC" && results.length < calls.length; j++) results.push(steps[j]);
    calls.forEach((call, n) => {
      turn.tools.push(callLine(call));
      const why = failureOf(call, results[n]);
      if (why) turn.tools.push(`error: ${call?.name ?? "tool"} failed: ${why}`);
    });
  }
  return out;
}

const inject = (text) => ({ injectSteps: [{ ephemeralMessage: text }] });

/**
 * Handles one hook call. Returns what to say to Antigravity or null.
 * `deps` lets a test choose the clock, the environment, the transcript, the folder for state and the way to reach the colony.
 */
export async function handle(input, { env = process.env, settings = readSettings(env), now = Date.now(), dir = stateDir(env), transcript, poster = send, recall = recallEvents, digest = digestMatters, refresh = refreshDeclared } = {}) {
  const event = String(input?.hook_event_name ?? input?.hookEventName ?? input?.event ?? "");
  const id = input?.conversationId;
  const cwd = (Array.isArray(input?.workspacePaths) ? input.workspacePaths : []).find((p) => typeof p === "string" && p) ?? "";
  if (!cwd) return null; // no folder: nothing can say whether it is covered
  if (event === "SessionStart" && env.MYRMO_WORKLOG === "1") await refresh({ env, settings });
  const target = worklogTarget({ cwd }, { env, settings });
  if (!target) return null;

  if (event === "SessionStart") {
    writeState(dir, fileOf(dir, id), { sent: -1, recalled: -1 }, now); // a new conversation: every turn of it counts
    const note = digestNote(await digest({ session_id: id }, target));
    return note ? inject(note) : null;
  }

  const text = transcript ?? (input?.transcriptPath && existsSync(input.transcriptPath) ? readFileSync(input.transcriptPath, "utf8") : "");
  const all = turns(readSteps(text));
  if (!all.length) return null;
  const file = fileOf(dir, id);
  const state = readState(file);
  const last = all[all.length - 1];
  // A conversation this hook has not seen before (it was installed while the conversation was open, or its state was
  // swept): only the turn in course counts. What was said before the hook was there is never sent.
  const known = state.sent !== undefined;
  const sent = known ? Number(state.sent) : last.start - 1;

  // A turn is over when another request follows it, or when the loop stopped with nothing left running.
  const over = all.filter((t) => t.start > sent && (t !== last || (event === "Stop" && input?.fullyIdle !== false)));
  for (const turn of over) {
    if (!turn.request || !turn.answer || isPrivate(turn.request)) continue; // marked private: never logged
    await poster(target, "/v1/worklog/exchanges", {
      session: `agy-${safeId(id)}`.slice(0, 64),
      scope: target.scope,
      repo: target.repo,
      branch: target.branch,
      prompt: safe(target, personalText(turn.request).trim()).slice(0, 4000),
      answer: safe(target, turn.answer).slice(0, 6000),
      activity: safe(target, turn.tools.slice(-60).join("\n")).slice(0, 3000),
    }, { timeoutMs: 8000 });
  }
  const next = { sent: over.length ? Math.max(sent, ...over.map((t) => t.start)) : sent, recalled: Number(state.recalled ?? (known ? -1 : last.start - 1)) };

  // A new request: what the work log knows about it, once, before the model plans it.
  let out = null;
  if (event === "PreInvocation" && last.start > next.recalled) {
    next.recalled = last.start;
    const prompt = last.request;
    if (prompt && !isPrivate(prompt)) {
      const task = taskOf(prompt);
      if (task || isContinuation(prompt)) {
        const note = recallNote(await recall({ prompt, session_id: id }, target, task));
        if (note) out = inject(note);
      }
    }
  }
  if (!known || next.sent !== Number(state.sent) || next.recalled !== Number(state.recalled)) writeState(dir, file, next, now);
  return out;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  // The event's name comes as the first argument: Antigravity does not put it in the payload.
  const args = process.argv.slice(2);
  const env = args.includes("--worklog") ? { ...process.env, MYRMO_WORKLOG: "1" } : process.env;
  const event = args.find((a) => !a.startsWith("--")) ?? "";
  let out = null;
  try {
    out = await handle({ ...JSON.parse(raw), hook_event_name: event }, { env });
  } catch {
    out = null;
  }
  process.stdout.write(JSON.stringify(out ?? {}));
}

if (basename(process.argv[1] ?? "") === "antigravity-worklog.mjs") {
  main().catch(() => process.stdout.write("{}")).finally(() => process.exit(0));
}
