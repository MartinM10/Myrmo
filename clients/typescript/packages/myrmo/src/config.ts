// The user's own Myrmo settings, kept in one small file that the TypeScript and Python
// clients and the MCP server all read:
//
//   ~/.myrmo/config.json      { "publish": "auto" }
//
// The file records choices only a person should make (whether agents may publish for them),
// so it is written by `myrmo-mcp config` or by the user's answer to a prompt, never by a model.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PublishMode } from "./types.js";

export interface MyrmoConfig {
  publish?: PublishMode;
}

const MODES: PublishMode[] = ["off", "ask", "auto"];

/** `MYRMO_CONFIG` if set, else `~/.myrmo/config.json`. */
export function configPath(): string {
  return process.env.MYRMO_CONFIG?.trim() || join(homedir(), ".myrmo", "config.json");
}

export function readConfig(): MyrmoConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    const publish = MODES.includes(raw.publish as PublishMode) ? (raw.publish as PublishMode) : undefined;
    return publish ? { publish } : {};
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
