// What a colony says it is (GET /v1/version, `colony`, protocol 1.7), remembered per URL so the next start knows it
// before the colony answers. The Claude Code hooks read and write the same file (plugins/myrmo/scripts/lookup.mjs).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "myrmo";

export type ColonyDescription = {
  profile?: "public" | "organisation";
  keys_required?: boolean;
  task_search?: boolean;
  effort?: boolean;
  people_detail?: "aggregate" | "named" | null;
  holdout_percent?: number;
};

const trim = (url: string) => url.trim().replace(/\/+$/, "");

export function profilesPath(): string {
  return join(dirname(configPath()), "colonies.json");
}

/** Only the fields a client acts on, with the types it expects: the file and the colony's answer are both untrusted. */
export function clean(value: unknown): ColonyDescription | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.profile !== "public" && v.profile !== "organisation") return undefined;
  const out: ColonyDescription = { profile: v.profile };
  if (typeof v.keys_required === "boolean") out.keys_required = v.keys_required;
  if (typeof v.task_search === "boolean") out.task_search = v.task_search;
  if (typeof v.effort === "boolean") out.effort = v.effort;
  if (v.people_detail === "aggregate" || v.people_detail === "named") out.people_detail = v.people_detail;
  if (typeof v.holdout_percent === "number" && v.holdout_percent >= 0 && v.holdout_percent <= 20) out.holdout_percent = Math.round(v.holdout_percent);
  return out;
}

export function readDeclared(url: string, file = profilesPath()): ColonyDescription | undefined {
  try {
    const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, { colony?: unknown }>;
    return clean(all?.[trim(url)]?.colony);
  } catch {
    return undefined;
  }
}

export function rememberDeclared(url: string, colony: unknown, file = profilesPath(), now = Date.now()): void {
  const c = clean(colony);
  if (!c) return;
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    all = {};
  }
  all[trim(url)] = { colony: c, at: new Date(now).toISOString() };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* without the file the next start asks the colony again */
  }
}
