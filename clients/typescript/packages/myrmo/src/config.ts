// The user's own Myrmo settings, kept in one small file that the TypeScript and Python
// clients and the MCP server all read:
//
//   ~/.myrmo/config.json      { "publish": "auto", "agent_id": "3f9c0a7e2b1d4c68a5e0b7d91c2f4a86" }
//
// `publish` is a choice only a person should make (whether agents may publish for them), so it is
// written by `myrmo-mcp config` or by the user's answer to a prompt, never by a model.
// `agent_id` is a random pseudonym the client creates by itself the first time it runs, so that
// reports from different machines behind one address are not mistaken for a single agent. It holds
// no personal data and can be deleted at any time.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PublishMode } from "./types.js";

export interface MyrmoConfig {
  publish?: PublishMode;
  agent_id?: string;
}

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
    return config;
  } catch {
    // Missing or unreadable: no choice has been made.
    return {};
  }
}

export function writeConfig(patch: MyrmoConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readConfig(), ...patch }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * How publishing is set up, and where that choice came from. `source: "default"` means nobody
 * has chosen yet: the clients then publish nothing and explain how to choose.
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
