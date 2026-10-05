#!/usr/bin/env node
// myrmo-mcp: run the Myrmo MCP server.
//
//   npx -y myrmo-mcp                    stdio, for one developer (redaction happens on this machine)
//   myrmo-mcp --http --port 3333        Streamable HTTP, stateless, for hosting next to a colony

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Colony, configPath, publishChoice, readConfig, writeConfig, type PublishMode } from "myrmo";
import { parseInitArgs, runInit } from "./init.js";
import { createServer, VERSION } from "./server.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// MYRMO_PUBLISH wins, then ~/.myrmo/config.json, then "nobody has chosen yet" (nothing is published).
const choice = publishChoice();
const publishMode: PublishMode = choice.mode;
const publishChosen = choice.source !== "default";
const minFailedAttempts = Number(process.env.MYRMO_MIN_FAILED_ATTEMPTS ?? 1);
const allowHighRisk = process.env.MYRMO_ALLOW_HIGH_RISK === "1";

if (flag("--version")) {
  console.log(VERSION);
  process.exit(0);
}

// `myrmo-mcp config` shows the user's settings; `myrmo-mcp config publish auto|ask|off` changes them.
// This is for the person, not the agent: whether agents may publish on their behalf is their call.
if (args[0] === "config") {
  if (args[1] === "publish") {
    if (!["auto", "ask", "off"].includes(args[2] ?? "")) {
      console.error("Usage: myrmo-mcp config publish auto|ask|off");
      process.exit(2);
    }
    writeConfig({ publish: args[2] as PublishMode });
    console.log(`Saved to ${configPath()}: agents publish with publish=${args[2]}.`);
  } else {
    console.log(`Settings file: ${configPath()}`);
    console.log(`publish: ${readConfig().publish ?? "(not chosen yet: agents publish nothing)"}${process.env.MYRMO_PUBLISH ? `   (MYRMO_PUBLISH=${process.env.MYRMO_PUBLISH} overrides it)` : ""}`);
    console.log(`agent id: ${readConfig().agent_id ?? "(created on first use)"}   (a random pseudonym; delete it from the file to get a new one, MYRMO_ANONYMOUS=1 sends none)`);
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
  const server = createServer({ colony: new Colony({ publish: publishMode }), publishMode, publishChosen, minFailedAttempts, fillLocalEnvironment: true, allowHighRisk });
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
