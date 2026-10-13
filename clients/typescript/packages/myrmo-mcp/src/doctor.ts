// `myrmo-mcp doctor`: is this machine set up to use the colony, and if not, what to do. For the person, not the agent.
// Every check says what it found and, when it fails, the one thing to try. Nothing is changed and no text of any
// trail is read: it asks the colony whether it is up, whether it lets this network in and whether this key opens it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeSetUp } from "./init.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  name: string;
  detail: string;
  /** What to try, when the level is not ok. */
  fix?: string;
}

export interface DoctorInput {
  url: string;
  /** True when the URL is the one `init --url` saved, so that its key and mode apply. */
  saved: boolean;
  apiKey?: string;
  privateMode: boolean;
  publish: string;
  nodeVersion?: string;
  home: string;
  fetchImpl?: typeof fetch;
}

const PUBLIC_HOSTS = new Set(["myrmo.dev", "www.myrmo.dev"]);

async function call(fetchImpl: typeof fetch, url: string, key?: string): Promise<{ status: number; body: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "myrmo-mcp-doctor", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(6000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    return { error: String(cause) };
  }
}

export async function diagnose(input: DoctorInput): Promise<Check[]> {
  const checks: Check[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const major = Number((input.nodeVersion ?? process.versions.node).split(".")[0]);
  checks.push(
    major >= 20
      ? { level: "ok", name: "Node.js", detail: `version ${input.nodeVersion ?? process.versions.node}` }
      : { level: "fail", name: "Node.js", detail: `version ${input.nodeVersion ?? process.versions.node} is too old`, fix: "Install Node.js 20 or newer (node --version) and run the command again." },
  );

  let host = "";
  try {
    host = new URL(input.url).host;
  } catch {
    checks.push({ level: "fail", name: "Colony address", detail: `"${input.url}" is not a web address`, fix: "Run the setup command again with --url http://<machine>:8080." });
    return checks;
  }
  const isPublic = PUBLIC_HOSTS.has(host);
  checks.push({
    level: isPublic ? "warn" : "ok",
    name: "Colony",
    detail: `${input.url}${isPublic ? " (the public colony)" : input.saved ? " (saved by init)" : " (from MYRMO_URL)"}`,
    fix: isPublic ? "To use your team's colony, run the setup command you were sent (npx myrmo-mcp init --url ... --key ... --private)." : undefined,
  });
  if (isPublic) return checks;

  const ready = await call(fetchImpl, `${input.url.replace(/\/$/, "")}/readyz`);
  if ("error" in ready) {
    const refused = ready.error === "ECONNREFUSED";
    checks.push({
      level: "fail",
      name: "Reaching the colony",
      detail: refused ? "the machine answered but nothing listens on that port" : `no answer (${ready.error})`,
      fix: refused
        ? "Ask whoever runs the colony whether it is up (bash deploy/private-colony.sh status on its machine)."
        : "Check that you are on the team's network and that the address and port are right; from this machine try: curl " + input.url + "/readyz",
    });
    return checks;
  }
  if (ready.status === 403) {
    checks.push({ level: "fail", name: "Reaching the colony", detail: "the colony refuses connections from this network (403)", fix: "Your machine is not in the networks the colony allows. Tell whoever runs it your IP address (hostname -I)." });
    return checks;
  }
  checks.push(
    ready.status === 200
      ? { level: "ok", name: "Reaching the colony", detail: "it answers and reports itself ready" }
      : { level: "fail", name: "Reaching the colony", detail: `it answered ${ready.status}`, fix: "It is up but not ready (it may still be starting). Try again in a minute, then tell whoever runs it." },
  );
  if (ready.status !== 200) return checks;

  const open = await call(fetchImpl, `${input.url.replace(/\/$/, "")}/v1/stats`, input.apiKey);
  if ("error" in open) {
    checks.push({ level: "fail", name: "Your access key", detail: `no answer (${open.error})`, fix: "Try again; if it persists tell whoever runs the colony." });
  } else if (open.status === 401) {
    checks.push(
      input.apiKey
        ? { level: "fail", name: "Your access key", detail: "the colony does not accept it (401)", fix: "The key was copied wrong or has been revoked. Ask for a new one and run the setup command again." }
        : { level: "fail", name: "Your access key", detail: "this colony needs a key and none is set", fix: "Run the setup command you were sent: npx myrmo-mcp init --url <colony> --key <your key> --private --publish auto." },
    );
  } else if (open.status === 200) {
    checks.push(input.apiKey ? { level: "ok", name: "Your access key", detail: "accepted" } : { level: "warn", name: "Your access key", detail: "this colony does not ask for a key", fix: "If it should be private, tell whoever runs it." });
  } else {
    checks.push({ level: "fail", name: "Your access key", detail: `the colony answered ${open.status}`, fix: "Tell whoever runs the colony." });
  }

  checks.push(
    input.privateMode
      ? { level: "ok", name: "Private mode", detail: "agents keep your internal names in what they publish" }
      : { level: "warn", name: "Private mode", detail: "off: agents would strip internal names from what they publish", fix: "Run the setup command again with --private (or set MYRMO_PRIVATE=1)." },
  );
  checks.push(
    input.publish === "auto"
      ? { level: "ok", name: "Publishing", detail: "agents publish what they solve, to this colony only" }
      : input.publish === "ask"
        ? { level: "ok", name: "Publishing", detail: "you approve each trail before it is sent" }
        : { level: "warn", name: "Publishing", detail: `agents do not publish (${input.publish})`, fix: "npx myrmo-mcp config publish auto   (or ask, to approve each one)" },
  );

  const claude = claudeCodeSetUp(input.home);
  const gemini = join(input.home, ".gemini", "GEMINI.md");
  const geminiRules = existsSync(gemini) && readFileSync(gemini, "utf8").includes("myrmo:start");
  if (claude || geminiRules) {
    checks.push({ level: "ok", name: "Agents", detail: [claude ? `Claude Code: ${claude}` : "", geminiRules ? "Gemini CLI / Antigravity: rules installed" : ""].filter(Boolean).join("; ") });
  } else {
    checks.push({ level: "fail", name: "Agents", detail: "no agent on this machine is set up to use Myrmo", fix: "Run the setup command again, then restart Claude Code or Antigravity." });
  }
  return checks;
}

export function render(checks: Check[]): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = checks.flatMap((c) => [`[${mark[c.level]}] ${c.name}: ${c.detail}`, ...(c.fix ? [`       -> ${c.fix}`] : [])]);
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  lines.push("", failed ? `${failed} problem${failed > 1 ? "s" : ""} to fix, then run this again.` : warned ? "Works, with things worth a look." : "Everything is in place. Restart your agent if you have not since the setup.");
  return lines.join("\n");
}
