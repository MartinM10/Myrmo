// Measured effort: what solving a problem cost this session, read from Claude Code's own transcript, sent to an
// organisation's colony so it can show what it saves (the Value tab of its panel).
//
// Claude Code writes every model response to the session's transcript with its usage (input, output, cache reads and
// writes). When a problem is solved, the hook adds up the responses between the first failed command and the fix, and
// sends the sums with the error line the problem started with: `unaided` when the colony had no trail, `aided` when a
// trail was followed and the agent reported it worked. Only numbers and the model leave the machine besides the error
// line, which the colony turns into a fingerprint and does not keep.
//
// Only to a colony that declares it collects them (an organisation's, `colony.effort` in GET /v1/version). MYRMO_EFFORT=off
// turns it off for a session, `"effort": "off"` in the settings file for good.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { clientHeader, colonyOf, redactFor } from "./lookup.mjs";

/** Whether this machine sends effort records to its colony. */
export function effortEnabled(env = process.env, settings = {}) {
  if (env.MYRMO_EFFORT === "off" || settings?.effort === "off") return false;
  const colony = colonyOf(env, settings);
  return colony.private && colony.declared?.effort === true;
}

/**
 * The usage of the model responses written between `from` and `to` (milliseconds), from a transcript's JSON lines.
 * A response is written once per content block with the same id and usage, so each id counts once.
 */
export function usageBetween(text, from, to) {
  const byId = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    const message = entry.message ?? {};
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    byId.set(message.id ?? entry.uuid ?? `${at}`, { usage, model: typeof message.model === "string" ? message.model : "" });
  }
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const sums = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0 };
  const models = new Map();
  for (const { usage, model } of byId.values()) {
    sums.input_tokens += n(usage.input_tokens);
    sums.output_tokens += n(usage.output_tokens);
    sums.cache_read_tokens += n(usage.cache_read_input_tokens);
    sums.cache_write_tokens += n(usage.cache_creation_input_tokens);
    sums.turns += 1;
    if (model) models.set(model, (models.get(model) ?? 0) + 1);
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { ...sums, model };
}

const CAP = 10_000_000;

/** The record for POST /v1/effort, or null when there is nothing worth sending. */
export function effortRecord({ role, line, trailId, from, to, usage }) {
  if (!line || String(line).length < 8 || !usage || usage.turns === 0) return null;
  if (role === "aided" && !trailId) return null;
  const clip = (v) => Math.min(CAP, v);
  return {
    protocol_version: "1.7",
    role,
    error: String(line).slice(0, 2000),
    ...(role === "aided" ? { trail_id: trailId } : {}),
    effort: {
      input_tokens: clip(usage.input_tokens),
      output_tokens: clip(usage.output_tokens),
      cache_read_tokens: clip(usage.cache_read_tokens),
      cache_write_tokens: clip(usage.cache_write_tokens),
      turns: Math.min(10_000, usage.turns),
      wall_time_seconds: Math.max(0, Math.min(86_400, Math.round((to - from) / 1000))),
    },
    agent_info: { model: usage.model || "unknown", framework: "claude-code" },
  };
}

/** Sends one record; true when the colony took it. Never throws. */
export async function sendEffort(record, { env = process.env, settings = {}, fetcher = fetch, timeoutMs = 4000 } = {}) {
  const colony = colonyOf(env, settings);
  const headers = { "content-type": "application/json", "user-agent": "myrmo-claude-code-hook/1", ...clientHeader() };
  if (env.MYRMO_AGENT_ID) headers["x-myrmo-agent"] = env.MYRMO_AGENT_ID;
  if (colony.apiKey) headers.authorization = `Bearer ${colony.apiKey}`;
  // The error line is redacted on this machine, as the SDK does before it sends one.
  const body = { ...record, error: redactFor(colony, record.error).slice(0, 2000) };
  try {
    const res = await fetcher(`${colony.url}/v1/effort`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The last `max` bytes of a file: a problem is solved within the hour, and a long session's transcript can be huge. */
export function readTail(path, max = 32 * 1024 * 1024) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Reads the transcript and sends the record for a solved problem, when this machine sends them. */
export async function measureAndSend(event, transcriptPath, { env = process.env, settings = {}, fetcher = fetch, now = Date.now() } = {}) {
  if (!event || !transcriptPath || !effortEnabled(env, settings)) return false;
  let text = "";
  try {
    text = readTail(transcriptPath);
  } catch {
    return false;
  }
  const to = event.to ?? now;
  const record = effortRecord({ ...event, to, usage: usageBetween(text, event.from, to) });
  return record ? sendEffort(record, { env, settings, fetcher }) : false;
}
