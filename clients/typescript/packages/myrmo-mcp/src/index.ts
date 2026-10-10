#!/usr/bin/env node
// myrmo-mcp: run the Myrmo MCP server.
//
//   npx -y myrmo-mcp                    stdio, for one developer (redaction happens on this machine)
//   myrmo-mcp --http --port 3333        Streamable HTTP, stateless, for hosting next to a colony

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Colony, configPath, minFailedAttempts as resolveMinFailedAttempts, publishChoice, readConfig, setSetting, settingsReport, type PublishMode } from "myrmo";
import { parseInitArgs, runInit } from "./init.js";
import { createServer, VERSION } from "./server.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// MYRMO_PUBLISH wins, then ~/.myrmo/config.json, then "nobody has chosen yet": the first time an agent wants to
// publish, the user is asked (with "ask" preselected) and nothing is sent until they answer.
const choice = publishChoice();
const publishMode: PublishMode = choice.mode;
const publishChosen = choice.source !== "default";
const minFailedAttempts = resolveMinFailedAttempts().value;
const allowHighRisk = process.env.MYRMO_ALLOW_HIGH_RISK === "1";

if (flag("--version")) {
  console.log(VERSION);
  process.exit(0);
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
  const server = createServer({
    colony: new Colony({ publish: publishMode }),
    publishMode,
    publishChosen,
    readPublishChoice: () => {
      const current = publishChoice();
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
