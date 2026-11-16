#!/usr/bin/env node
// The work log for Cline: the same thing the Claude Code hook (worklog-hook.mjs) does, with the events Cline has.
//
// Cline runs a hook as an executable named after the event, in ~/Documents/Cline/Hooks (or a project's .clinerules/hooks),
// writes a JSON object to its standard input and reads a JSON object back. Measured in Cline 4.1.26 (every field below
// was seen, not read in a document):
//
//   UserPromptSubmit  { taskId, workspaceRoots, userPromptSubmit: { prompt } }       -> { contextModification } reaches the model
//   PostToolUse       { taskId, postToolUse: { toolName, parameters, success } }     -> { contextModification } reaches the model
//   TaskComplete      { taskId, taskComplete: { taskMetadata: { result } } }          the agent's last words (nothing to return)
//   TaskCancel        { taskId }
//
// The prompt arrives wrapped in <user_input mode="act">…</user_input>. Cline 4.1.26 does not pass a command's output to
// PostToolUse (the result is the text "[object Object]"), so what the agent did is recorded as the tool and its command,
// and a failed call as an error line. A new user message is a new run with a new taskId: the state that joins a request to
// its answer is keyed by it.
//
// It never holds the agent back and answers nothing whenever it has nothing to say or anything goes wrong. Like the Claude
// Code hook it does nothing unless MYRMO_WORKLOG=1, the colony is the organisation's own, the person is enrolled and the
// folder is covered (worklog.mjs: worklogTarget). A request that starts with //privado or //private is never logged.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { personalText, taskOf } from "./lookup.mjs";
import { readSettings } from "./on-failure.mjs";
import { redactText } from "./redact.mjs";
import { digestMatters, digestNote, isContinuation, isPrivate, recallEvents, recallNote, redactRandom, send, worklogTarget } from "./worklog.mjs";

const DAY = 86_400_000;
/** How long before the digest of what colleagues did is shown again for a repository: a Cline run is not a session. */
export const DIGEST_EVERY_MS = 4 * 3_600_000;

export const stateDir = (env = process.env) => env.MYRMO_WORKLOG_STATE_DIR || join(homedir(), ".myrmo", "worklog-state");
const safeId = (id) => String(id ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "none";
const fileOf = (dir, id) => join(dir, `cline-${safeId(id)}.json`);

/** What the person typed: Cline wraps it in <user_input …>…</user_input>. */
export function promptOf(text) {
  const raw = String(text ?? "");
  const m = /<user_input(?:\s[^>]*)?>([\s\S]*?)<\/user_input>/i.exec(raw);
  return (m ? m[1] : raw).trim();
}

const oneLine = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** One short line for a tool call: its name and what it was asked to do. */
export function toolLine(name, parameters) {
  let p = parameters ?? {};
  const target = p.commands ?? p.command ?? p.file_path ?? p.path ?? p.paths ?? p.pattern ?? p.query ?? p.url ?? p.description ?? "";
  let text = typeof target === "string" ? target : JSON.stringify(target);
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list)) text = list.join(" ; "); // Cline gives the commands as a JSON list inside a string
  } catch {
    /* not a list */
  }
  return `${name}: ${oneLine(text, 200)}`;
}

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
      if (name.startsWith("cline-") && now - statSync(path).mtimeMs > DAY) rmSync(path, { force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

const digestFile = (dir, repo) => join(dir, `cline-digest-${safeId(repo)}.stamp`);

function digestDue(dir, repo, now) {
  try {
    return now - Number(readFileSync(digestFile(dir, repo), "utf8")) > DIGEST_EVERY_MS;
  } catch {
    return true;
  }
}

/**
 * Handles one hook call. Returns what to say to Cline ({contextModification}) or null.
 * `deps` lets a test choose the clock, the environment, the folder for state and the way to reach the colony.
 */
export async function handle(input, { env = process.env, settings = readSettings(env), now = Date.now(), dir = stateDir(env), poster = send, recall = recallEvents, digest = digestMatters } = {}) {
  const event = String(input?.hookName ?? "");
  const id = input?.taskId;
  const cwd = Array.isArray(input?.workspaceRoots) && input.workspaceRoots[0] ? input.workspaceRoots[0] : process.cwd();
  const file = fileOf(dir, id);

  if (event === "TaskCancel") {
    rmSync(file, { force: true });
    return null;
  }
  const target = worklogTarget({ cwd }, { env, settings });
  if (!target) return null;

  if (event === "UserPromptSubmit") {
    const prompt = promptOf(input.userPromptSubmit?.prompt);
    rmSync(file, { force: true });
    if (!prompt || isPrivate(prompt)) return null; // marked private: nothing is kept, nothing is asked of the colony
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir, now);
    writeFileSync(file, JSON.stringify({ prompt, tools: [], at: now }), { mode: 0o600 });
    const notes = [];
    const task = taskOf(prompt);
    if (task || isContinuation(prompt)) {
      const note = recallNote(await recall({ prompt, session_id: id }, target, task));
      if (note) notes.push(note);
    }
    if (digestDue(dir, target.repo, now)) {
      writeFileSync(digestFile(dir, target.repo), String(now), { mode: 0o600 });
      const note = digestNote(await digest({ session_id: id }, target));
      if (note) notes.push(note);
    }
    return notes.length ? { context: notes.join("\n\n"), contextModification: notes.join("\n\n") } : null;
  }

  if (event === "PostToolUse") {
    const state = readState(file);
    if (!state) return null; // a request marked private, or one this hook did not see
    const call = input.postToolUse ?? {};
    const lines = [toolLine(call.toolName, call.parameters)];
    if (call.success === false) lines.push(`error: ${call.toolName} failed`);
    state.tools = [...(state.tools ?? []), ...lines].slice(-60);
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return null;
  }

  if (event === "TaskComplete") {
    const state = readState(file);
    rmSync(file, { force: true });
    const answer = String(input.taskComplete?.taskMetadata?.result ?? "").trim();
    if (!state || !state.prompt || !answer) return null;
    await poster(target, "/v1/worklog/exchanges", {
      session: `cline-${safeId(id)}`.slice(0, 64),
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
  const out = await handle(JSON.parse(raw));
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1]?.endsWith("cline-hook.mjs")) {
  main().catch(() => {}).finally(() => process.exit(0));
}
