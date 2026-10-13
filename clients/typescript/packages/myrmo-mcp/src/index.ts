#!/usr/bin/env node
// myrmo-mcp: run the Myrmo MCP server.
//
//   npx -y myrmo-mcp                    stdio, for one developer (redaction happens on this machine)
//   myrmo-mcp --http --port 3333        Streamable HTTP, stateless, for hosting next to a colony

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Colony, configPath, minFailedAttempts as resolveMinFailedAttempts, publishChoice, readConfig, setSetting, settingsReport, type PublishMode } from "myrmo";
import * as sdk from "myrmo";
import { parseInitArgs, runInit } from "./init.js";
import { createServer, privateMode, VERSION } from "./server.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// MYRMO_PUBLISH wins, then ~/.myrmo/config.json, then "nobody has chosen yet": the first time an agent wants to
// publish, the user is asked (with "ask" preselected) and nothing is sent until they answer.
// The colony this server talks to: MYRMO_URL, else the one `init --url` saved, else the public one.
const colonyUrl = new Colony({ agentId: false }).url;
// `fileColony` arrived with myrmo 0.13; with an older SDK there is no colony in the settings file to read.
const savedColony = (sdk as { fileColony?: (url?: string) => { private?: boolean; api_key?: string } | undefined }).fileColony?.(colonyUrl);
const choice = (publishChoice as (explicit?: PublishMode, url?: string) => ReturnType<typeof publishChoice>)(undefined, colonyUrl);
const publishMode: PublishMode = choice.mode;
const publishChosen = choice.source !== "default";
const minFailedAttempts = resolveMinFailedAttempts().value;
const allowHighRisk = process.env.MYRMO_ALLOW_HIGH_RISK === "1";

if (flag("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const USAGE = `myrmo-mcp ${VERSION}: the Myrmo MCP server and its commands.

  myrmo-mcp                          run the MCP server on stdio (what an agent's client launches)
  myrmo-mcp --http [--port N]        run it over Streamable HTTP, stateless
  myrmo-mcp init [options]           set this machine's agents up (add --url, --key or --key-file, --private for a team colony)
  myrmo-mcp doctor                   check that this machine can use the colony, and say what to fix
  myrmo-mcp config [setting value]   show or change a setting (publish, hook, ...)
  myrmo-mcp export <dir> [--skill]   write the colony's trails as Markdown notes
  myrmo-mcp --version

Docs: https://myrmo.dev/docs/reference/mcp`;
const COMMANDS = ["init", "doctor", "config", "export"];
if (flag("--help") || flag("-h") || args[0] === "help") {
  console.log(USAGE);
  process.exit(0);
}
// A word that is not a command is a mistake, not a request to start the server and wait for input that never comes.
if (args[0] && !args[0].startsWith("-") && !COMMANDS.includes(args[0])) {
  console.error(`Unknown command "${args[0]}".\n\n${USAGE}`);
  process.exit(2);
}

// `myrmo-mcp config` shows every setting, where its value comes from and what it does;
// `myrmo-mcp config <setting> <value>` changes one (`reset` restores the default).
// This is for the person, not the agent: whether agents may publish on their behalf is their call.
if (args[0] === "config") {
  const [, key, value] = args;
  if (key === undefined) {
    console.log(`Settings file: ${configPath()}   (nothing here is required: every setting has a default)`);
    for (const row of settingsReport()) {
      console.log(`  ${row.key.padEnd(20)} ${row.value.padEnd(7)} (${row.source}) ${row.about}  [${row.values}]`);
    }
    console.log(`  ${"agent id".padEnd(20)} ${readConfig().agent_id ?? "(created on first use)"}   a random pseudonym; delete it from the file for a new one`);
    console.log("\nChange one with: npx myrmo-mcp config <setting> <value>      (<value> = reset restores the default)");
  } else if (value === undefined) {
    console.error("Usage: myrmo-mcp config [<setting> <value>]");
    process.exit(2);
  } else {
    const result = setSetting(key, value);
    if (!result.ok) {
      console.error(result.error);
      process.exit(2);
    }
    console.log(result.message);
    if (key === "publish" && (value === "ask" || value === "auto")) {
      console.log("By letting agents publish you accept the terms of service: https://myrmo.dev/docs/legal/terms");
    }
  }
  process.exit(0);
}

// `myrmo-mcp init` registers this server with the MCP clients found on the machine.
// `myrmo-mcp export <dir> [--skill]`: the colony's trails as Markdown notes (an Obsidian vault, a git folder, or with
// --skill a Claude Code skill), so that what a team learned is never tied to Myrmo.
if (args[0] === "export") {
  const dir = args[1];
  if (!dir || dir.startsWith("--")) {
    console.error("Usage: myrmo-mcp export <dir> [--skill]");
    process.exit(2);
  }
  const { writeExport } = await import("./export.js");
  const colony = new Colony({ agentId: false });
  const feed = (colony as unknown as { allTrails?: () => AsyncGenerator<Record<string, unknown>> }).allTrails;
  if (!feed) {
    console.error("This needs myrmo 0.14 or newer next to myrmo-mcp.");
    process.exit(1);
  }
  const items: Record<string, unknown>[] = [];
  for await (const item of feed.call(colony)) items.push(item);
  const written = writeExport(dir, items, { skill: flag("--skill"), source: colony.url });
  console.log(`${written} trails from ${colony.url} written to ${dir}${flag("--skill") ? " as a skill (SKILL.md)" : ""}.`);
  process.exit(0);
}

// `myrmo-mcp doctor`: checks that this machine can use the colony and says what to fix.
if (args[0] === "doctor") {
  const { diagnose, render } = await import("./doctor.js");
  const checks = await diagnose({
    url: colonyUrl,
    saved: savedColony !== undefined,
    apiKey: process.env.MYRMO_API_KEY?.trim() || savedColony?.api_key,
    privateMode: privateMode(colonyUrl, process.env, savedColony?.private === true).on,
    publish: publishMode,
    home: (await import("node:os")).homedir(),
  });
  console.log(render(checks));
  process.exit(checks.some((c) => c.level === "fail") ? 1 : 0);
}

if (args[0] === "init") {
  const parsed = parseInitArgs(args.slice(1));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(2);
  }
  runInit(parsed);
  process.exit(0);
}

if (flag("--http")) {
  await serveHttp(Number(option("--port", process.env.PORT ?? "3333")), option("--host", "0.0.0.0"));
} else {
  const privacy = privateMode(colonyUrl, process.env, savedColony?.private === true);
  // In a private colony the network's addresses and host names stay in what is sent (the colony keeps them too).
  const colony = new Colony({ publish: publishMode, private: privacy.on });
  if (privacy.warning) console.error(`myrmo-mcp: ${privacy.warning}`);
  const server = createServer({
    colony,
    privateColony: privacy.on,
    identity: (() => {
      const key = process.env.MYRMO_API_KEY?.trim() || savedColony?.api_key;
      if (key) return `key ${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
      const id = readConfig().agent_id;
      return id ? `agent ${id.slice(0, 8)}` : undefined;
    })(),
    publishMode,
    publishChosen,
    readPublishChoice: () => {
      const current = (publishChoice as (explicit?: PublishMode, url?: string) => ReturnType<typeof publishChoice>)(undefined, colonyUrl);
      return { mode: current.mode, chosen: current.source !== "default" };
    },
    minFailedAttempts,
    fillLocalEnvironment: true,
    allowHighRisk,
  });
  await server.connect(new StdioServerTransport());
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function serveHttp(port: number, host: string) {
  const http = createHttpServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") return sendJson(res, 200, { status: "ok", version: VERSION });
    if (path !== "/mcp") return sendJson(res, 404, { error: "Use POST /mcp" });
    if (req.method !== "POST") return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null });

    // Every request gets its own server and transport: no sessions, so any replica can answer.
    const headers: Record<string, string> = {};
    const forwarded = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    if (forwarded) headers["x-forwarded-for"] = forwarded;
    const agent = req.headers["x-myrmo-agent"];
    if (typeof agent === "string") headers["x-myrmo-agent"] = agent;
    const auth = req.headers.authorization;
    const colony = new Colony({
      headers,
      apiKey: auth?.startsWith("Bearer ") ? auth.slice(7) : undefined,
      publish: "off",
      cacheTtlMs: 0,
      // The hosted server has no identity of its own: it forwards the header of whoever is calling.
      agentId: false,
    });
    const server = createServer({ colony, publishMode: "off", minFailedAttempts, fillLocalEnvironment: false, hosted: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      const body = await readBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (!res.headersSent) sendJson(res, status, { jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null });
    }
  });
  http.keepAliveTimeout = 65_000;
  http.listen(port, host, () => console.error(`myrmo-mcp ${VERSION} listening on http://${host}:${port}/mcp`));
}
