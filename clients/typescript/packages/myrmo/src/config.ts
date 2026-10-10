// The user's own Myrmo settings, kept in one small file that the TypeScript and Python
// clients and the MCP server all read:
//
//   ~/.myrmo/config.json      { "publish": "ask", "min_failed_attempts": 1, "hook": "on", "agent_id": "3f9c..." }
//
// Everything works with no file at all: every setting has a default. The file only records what a
// person chose. `publish` is a choice only a person should make (whether agents may publish for them),
// so it is written by `myrmo-mcp config` or by the user's answer to a prompt, never by a model.
// `agent_id` is a random pseudonym the client creates by itself the first time it runs, so that
// reports from different machines behind one address are not mistaken for a single agent. It holds
// no personal data and can be deleted at any time.
//
// For each setting the order is: an explicit option, the environment variable, this file, the default.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PublishMode } from "./types.js";

export type HookMode = "on" | "failures" | "off";

export interface MyrmoConfig {
  publish?: PublishMode;
  agent_id?: string;
  /** Failed attempts before a fix is worth publishing. */
  min_failed_attempts?: number;
  /** The Claude Code plugin's reminders: on (failures, errors hidden by a pipe, publishing a fix Myrmo lacked), failures only, or off. */
  hook?: HookMode;
  /** Send no agent id at all. */
  anonymous?: boolean;
}

export const DEFAULT_MIN_FAILED_ATTEMPTS = 1;
const MAX_MIN_FAILED_ATTEMPTS = 20;

const AGENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

const MODES: PublishMode[] = ["off", "ask", "auto"];

/** `MYRMO_CONFIG` if set, else `~/.myrmo/config.json`. */
export function configPath(): string {
  return process.env.MYRMO_CONFIG?.trim() || join(homedir(), ".myrmo", "config.json");
}

export function readConfig(): MyrmoConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    const config: MyrmoConfig = {};
    if (MODES.includes(raw.publish as PublishMode)) config.publish = raw.publish as PublishMode;
    if (typeof raw.agent_id === "string" && AGENT_ID.test(raw.agent_id)) config.agent_id = raw.agent_id;
    const attempts = parseAttempts(raw.min_failed_attempts);
    if (attempts !== undefined) config.min_failed_attempts = attempts;
    if (raw.hook === "on" || raw.hook === "failures" || raw.hook === "off") config.hook = raw.hook;
    if (typeof raw.anonymous === "boolean") config.anonymous = raw.anonymous;
    return config;
  } catch {
    // Missing or unreadable: no choice has been made.
    return {};
  }
}

function parseAttempts(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_MIN_FAILED_ATTEMPTS ? n : undefined;
}

/** Merge `patch` into the file. A key set to `undefined` is removed, which restores its default. */
export function writeConfig(patch: { [K in keyof MyrmoConfig]?: MyrmoConfig[K] | undefined }): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readConfig(), ...patch }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * How publishing is set up, and where that choice came from. `source: "default"` means nobody
 * has chosen yet: the clients then publish nothing until the user has been asked once (the MCP
 * server asks the first time an agent wants to publish, with "ask" preselected).
 */
export function publishChoice(explicit?: PublishMode): { mode: PublishMode; source: "option" | "env" | "file" | "default" } {
  const valid = (v: unknown): v is PublishMode => MODES.includes(v as PublishMode);
  if (valid(explicit)) return { mode: explicit, source: "option" };
  const fromEnv = process.env.MYRMO_PUBLISH?.trim();
  if (valid(fromEnv)) return { mode: fromEnv, source: "env" };
  const fromFile = readConfig().publish;
  if (fromFile) return { mode: fromFile, source: "file" };
  return { mode: "off", source: "default" };
}

export type SettingSource = "option" | "env" | "file" | "default";

/** Failed attempts before a fix is worth publishing: option, then MYRMO_MIN_FAILED_ATTEMPTS, then the file, then 1. */
export function minFailedAttempts(explicit?: number): { value: number; source: SettingSource } {
  const fromOption = parseAttempts(explicit);
  if (fromOption !== undefined) return { value: fromOption, source: "option" };
  const fromEnv = parseAttempts(process.env.MYRMO_MIN_FAILED_ATTEMPTS);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromFile = readConfig().min_failed_attempts;
  if (fromFile !== undefined) return { value: fromFile, source: "file" };
  return { value: DEFAULT_MIN_FAILED_ATTEMPTS, source: "default" };
}

/** What `myrmo-mcp config` can change: its name, what it does, the values it takes, and the default. */
export const SETTINGS = [
  { key: "publish", file: "publish", values: "ask | auto | off", default: "not chosen: nothing is published until you are asked, the first time an agent wants to publish", about: "Whether agents may publish fixes for you. ask shows you each one first." },
  { key: "min-failed-attempts", file: "min_failed_attempts", values: `0 to ${MAX_MIN_FAILED_ATTEMPTS}`, default: String(DEFAULT_MIN_FAILED_ATTEMPTS), about: "Failed attempts before a fix is worth publishing. Higher means fewer, more selective trails." },
  { key: "hook", file: "hook", values: "on | failures | off", default: "on", about: "Claude Code plugin reminders. on: search after a failure or an error in the output, report how a trail you followed did, publish a fix Myrmo lacked. failures: only after a failed command." },
  { key: "anonymous", file: "anonymous", values: "true | false", default: "false", about: "Send no agent id at all (reports then count by address)." },
] as const;

export interface SettingRow {
  key: string;
  value: string;
  source: SettingSource;
  about: string;
  values: string;
  default: string;
}

/** Every setting with its current value and where that value comes from. */
export function settingsReport(): SettingRow[] {
  const file = readConfig();
  const publish = publishChoice();
  const attempts = minFailedAttempts();
  const hookEnv = process.env.MYRMO_HOOK?.trim().toLowerCase();
  const anonEnv = process.env.MYRMO_ANONYMOUS?.trim().toLowerCase();
  const rows: Record<string, { value: string; source: SettingSource }> = {
    publish: { value: publish.source === "default" ? "not chosen" : publish.mode, source: publish.source },
    "min-failed-attempts": { value: String(attempts.value), source: attempts.source },
    hook: hookEnv === "on" || hookEnv === "failures" || hookEnv === "off" ? { value: hookEnv, source: "env" } : file.hook ? { value: file.hook, source: "file" } : { value: "on", source: "default" },
    anonymous: anonEnv ? { value: String(["1", "true"].includes(anonEnv)), source: "env" } : file.anonymous !== undefined ? { value: String(file.anonymous), source: "file" } : { value: "false", source: "default" },
  };
  return SETTINGS.map((s) => ({ key: s.key, ...rows[s.key], about: s.about, values: s.values, default: s.default }));
}

/** Change one setting from its CLI name. The value `reset` removes it from the file (back to the default). */
export function setSetting(key: string, value: string): { ok: true; message: string } | { ok: false; error: string } {
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) return { ok: false, error: `Unknown setting "${key}". Settings: ${SETTINGS.map((s) => s.key).join(", ")}.` };
  if (value === "reset") {
    writeConfig({ [def.file]: undefined });
    return { ok: true, message: `${key} is back to its default (${def.default}).` };
  }
  let patch: MyrmoConfig;
  if (key === "publish") {
    if (!MODES.includes(value as PublishMode)) return { ok: false, error: "publish takes ask, auto or off." };
    patch = { publish: value as PublishMode };
  } else if (key === "min-failed-attempts") {
    const n = parseAttempts(value);
    if (n === undefined) return { ok: false, error: `min-failed-attempts takes a whole number from 0 to ${MAX_MIN_FAILED_ATTEMPTS}.` };
    patch = { min_failed_attempts: n };
  } else if (key === "hook") {
    if (value !== "on" && value !== "failures" && value !== "off") return { ok: false, error: "hook takes on, failures or off." };
    patch = { hook: value };
  } else {
    if (!["true", "false"].includes(value)) return { ok: false, error: "anonymous takes true or false." };
    patch = { anonymous: value === "true" };
  }
  writeConfig(patch);
  return { ok: true, message: `Saved to ${configPath()}: ${key} = ${value}.` };
}

export type AgentIdSource = "option" | "env" | "file" | "generated" | "none";

/**
 * Who this client says it is. Nothing to configure: the first run creates a random id and keeps it in
 * the config file. `MYRMO_AGENT_ID` (or the `agentId` option) overrides it, `false` or
 * `MYRMO_ANONYMOUS=1` sends none. If the file cannot be written the id lives for this process only.
 */
export function agentIdentity(explicit?: string | false): { id?: string; source: AgentIdSource } {
  if (explicit === false) return { source: "none" };
  if (explicit) return { id: explicit, source: "option" };
  const fromEnv = process.env.MYRMO_AGENT_ID?.trim();
  if (fromEnv) return { id: fromEnv, source: "env" };
  if (["1", "true"].includes(process.env.MYRMO_ANONYMOUS?.trim().toLowerCase() ?? "")) return { source: "none" };
  if (readConfig().anonymous === true) return { source: "none" };
  const stored = readConfig().agent_id;
  if (stored) return { id: stored, source: "file" };
  const id = randomUUID().replace(/-/g, "");
  try {
    writeConfig({ agent_id: id });
  } catch {
    // A read-only home directory: the id then lasts as long as this process.
  }
  return { id, source: "generated" };
}
