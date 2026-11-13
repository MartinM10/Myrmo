#!/usr/bin/env node
// myrmo-mcp: run the Myrmo MCP server.
//
//   npx -y myrmo-mcp                    stdio, for one developer (redaction happens on this machine)
//   myrmo-mcp --http --port 3333        Streamable HTTP, stateless, for hosting next to a colony (loopback unless --host)

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Colony, configPath, minFailedAttempts as resolveMinFailedAttempts, publishChoice, readConfig, setSetting, settingsReport, type PublishMode } from "myrmo";
import * as sdk from "myrmo";
import { parseInitArgs, runInit } from "./init.js";
import { createServer, privateMode, VERSION } from "./server.js";
import { allowedHosts, callerKey, DEFAULT_HTTP_HOST, hostedColonyUrl } from "./hosting.js";
import { clean, readDeclared, rememberDeclared, type ColonyDescription } from "./profile.js";
import { t as tx } from "./i18n.js";

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
  myrmo-mcp --http [--port N] [--host H]  run it over Streamable HTTP, stateless (default host 127.0.0.1)
  myrmo-mcp init [options]           set this machine's agents up (add --url, --key or --key-file, --private for a team colony)
  myrmo-mcp join <invitation link>   join a colony with an invitation and set this machine's agents up for it
  myrmo-mcp doctor                   check that this machine can use the colony, and say what to fix
  myrmo-mcp config [setting value]   show or change a setting (publish, hook, ...)
  myrmo-mcp export <dir> [--skill]   write the colony's trails as Markdown notes
  myrmo-mcp pilot-roi [days] [--json] a private colony's pilot summary (needs MYRMO_ADMIN_TOKEN)
  myrmo-mcp --version

Docs: https://myrmo.dev/docs/reference/mcp`;
const USAGE_ES = `myrmo-mcp ${VERSION}: el servidor MCP de Myrmo y sus comandos.

  myrmo-mcp                          ejecuta el servidor MCP por stdio (lo que lanza el cliente de un agente)
  myrmo-mcp --http [--port N] [--host H]  lo ejecuta por HTTP en streaming, sin estado (host por defecto 127.0.0.1)
  myrmo-mcp init [opciones]          configura los agentes de esta máquina (añade --url, --key o --key-file, --private para la colonia de un equipo)
  myrmo-mcp join <enlace>            se une a una colonia con una invitación y configura para ella los agentes de esta máquina
  myrmo-mcp doctor                   comprueba que esta máquina puede usar la colonia y dice qué arreglar
  myrmo-mcp config [ajuste valor]    enseña o cambia un ajuste (publish, hook, ...)
  myrmo-mcp export <dir> [--skill]   escribe los rastros de la colonia como notas Markdown
  myrmo-mcp pilot-roi [días] [--json] el resumen del piloto de una colonia privada (necesita MYRMO_ADMIN_TOKEN)
  myrmo-mcp --version

Para ver los mensajes en inglés: MYRMO_LANG=en. Documentación: https://myrmo.dev/docs/es/reference/mcp`;
const COMMANDS = ["init", "join", "doctor", "config", "export", "pilot-roi"];
const INIT_USAGE = `myrmo-mcp init [options]: set up the agents on this machine to use Myrmo.

  (no options)                 every agent client found: Claude Code (plugin), Cursor, Windsurf, Gemini CLI,
                               Antigravity, Claude Desktop, VS Code (Copilot), OpenCode, Codex; the public colony
  --client <id>[,<id>]         only these: claude-code, cursor, windsurf, gemini, antigravity, claude-desktop,
                               vscode, opencode, codex
  --url <colony>               your organisation's colony instead of the public one
  --key-file <f> | --key -      its access key, from a file (the invitation message works) or standard input;
                               --key <key> works too, but stays in the shell's history
  --publish auto|ask|off       how agents publish to that colony (otherwise you are asked the first time)
  --private                    only for a colony older than protocol 1.7 (newer ones say what they are)
  --agents-md [file]           also write the usage rules into this repository's AGENTS.md
  --read-only                  with --agents-md: agents in this repository search and report, never publish
  --no-rules                   do not write usage rules into Gemini CLI's or Windsurf's global instructions
  --dry-run                    show what would change, change nothing
  --yes                        do not ask anything (init alone in a terminal asks a few questions)

Afterwards: npx myrmo-mcp doctor (checks everything), npx myrmo-mcp config (shows and changes settings).`;
const INIT_USAGE_ES = `myrmo-mcp init [opciones]: configura los agentes de esta máquina para usar Myrmo.

  (sin opciones)               todos los clientes de agentes que encuentre: Claude Code (plugin), Cursor, Windsurf,
                               Gemini CLI, Antigravity, Claude Desktop, VS Code (Copilot), OpenCode, Codex; la colonia pública
  --client <id>[,<id>]         solo estos: claude-code, cursor, windsurf, gemini, antigravity, claude-desktop,
                               vscode, opencode, codex
  --url <colony>               la colonia de tu organización en lugar de la pública
  --key-file <f> | --key -      su clave de acceso, de un fichero (vale el mensaje de invitación) o de la entrada estándar;
                               --key <key> también funciona, pero queda en el historial de la shell
  --publish auto|ask|off       cómo publican los agentes en esa colonia (si no, se te pregunta la primera vez)
  --private                    solo para una colonia anterior al protocolo 1.7 (las nuevas dicen lo que son)
  --agents-md [file]           escribe también las reglas de uso en el AGENTS.md de este repositorio
  --read-only                  con --agents-md: los agentes de este repositorio buscan y reportan, nunca publican
  --no-rules                   no escribe las reglas de uso en las instrucciones globales de Gemini CLI o Windsurf
  --dry-run                    enseña lo que cambiaría, sin cambiar nada
  --yes                        no pregunta nada (init solo, en una terminal, hace unas pocas preguntas)

Después: npx myrmo-mcp doctor (lo comprueba todo), npx myrmo-mcp config (enseña y cambia los ajustes).`;
if (args[0] === "init" && (flag("--help") || flag("-h"))) {
  console.log(tx(INIT_USAGE, INIT_USAGE_ES));
  process.exit(0);
}
if (args[0] === "join" && (flag("--help") || flag("-h"))) {
  console.log((await import("./join.js")).joinUsage());
  process.exit(0);
}
if (flag("--help") || flag("-h") || args[0] === "help") {
  console.log(tx(USAGE, USAGE_ES));
  process.exit(0);
}
// A word that is not a command is a mistake, not a request to start the server and wait for input that never comes.
if (args[0] && !args[0].startsWith("-") && !COMMANDS.includes(args[0])) {
  console.error(tx(`Unknown command "${args[0]}".\n\n${USAGE}`, `Comando desconocido "${args[0]}".\n\n${USAGE_ES}`));
  process.exit(2);
}

// `myrmo-mcp config` shows every setting, where its value comes from and what it does;
// `myrmo-mcp config <setting> <value>` changes one (`reset` restores the default).
// This is for the person, not the agent: whether agents may publish on their behalf is their call.
if (args[0] === "config") {
  const [, key, value] = args;
  if (key === undefined) {
    console.log(tx(`Settings file: ${configPath()}   (nothing here is required: every setting has a default)`, `Fichero de configuración: ${configPath()}   (nada aquí es obligatorio: cada ajuste tiene un valor por defecto)`));
    for (const row of settingsReport()) {
      console.log(`  ${row.key.padEnd(20)} ${row.value.padEnd(7)} (${row.source}) ${row.about}  [${row.values}]`);
    }
    console.log(`  ${"agent id".padEnd(20)} ${readConfig().agent_id ?? tx("(created on first use)", "(se crea al primer uso)")}   ${tx("a random pseudonym; delete it from the file for a new one", "un seudónimo aleatorio; bórralo del fichero para obtener otro")}`);
    // Which colony this machine uses: the one thing a person most needs to know before an agent publishes anything.
    const saved = readConfig().colony;
    const inUse = process.env.MYRMO_URL?.trim() || saved?.url || "https://myrmo.dev";
    const where = process.env.MYRMO_URL?.trim() ? "MYRMO_URL" : saved?.url ? "file" : "default";
    const kind = /^https?:\/\/(www\.)?myrmo\.dev\/?$/i.test(inUse) ? tx("the PUBLIC colony: what is published there is public", "la colonia PÚBLICA: lo que se publica ahí es público") : tx("your own colony", "tu propia colonia");
    console.log(`  ${"colony".padEnd(20)} ${inUse}   (${where}) ${kind}${saved?.api_key && saved.url === inUse ? tx(", with an access key", ", con clave de acceso") : ""}`);
    console.log(tx("  To change it: npx myrmo-mcp init --url <colony> --key-file <file>; back to the public colony: npx myrmo-mcp init --url https://myrmo.dev", "  Para cambiarla: npx myrmo-mcp init --url <colony> --key-file <file>; para volver a la colonia pública: npx myrmo-mcp init --url https://myrmo.dev"));
    console.log(tx("\nChange one with: npx myrmo-mcp config <setting> <value>      (<value> = reset restores the default)", "\nCambia uno con: npx myrmo-mcp config <setting> <value>      (<value> = reset vuelve al valor por defecto)"));
  } else if (value === undefined) {
    console.error(tx("Usage: myrmo-mcp config [<setting> <value>]", "Uso: myrmo-mcp config [<setting> <value>]"));
    process.exit(2);
  } else {
    const result = setSetting(key, value);
    if (!result.ok) {
      console.error(result.error);
      process.exit(2);
    }
    console.log(result.message);
    if (key === "publish" && (value === "ask" || value === "auto")) {
      console.log(tx("By letting agents publish you accept the terms of service: https://myrmo.dev/docs/legal/terms", "Al dejar publicar a los agentes aceptas las condiciones del servicio: https://myrmo.dev/docs/es/legal/terms"));
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
    console.error(tx("Usage: myrmo-mcp export <dir> [--skill]", "Uso: myrmo-mcp export <dir> [--skill]"));
    process.exit(2);
  }
  const { writeExport } = await import("./export.js");
  const colony = new Colony({ agentId: false });
  const feed = (colony as unknown as { allTrails?: () => AsyncGenerator<Record<string, unknown>> }).allTrails;
  if (!feed) {
    console.error(tx("This needs myrmo 0.14 or newer next to myrmo-mcp.", "Esto necesita myrmo 0.14 o superior junto a myrmo-mcp."));
    process.exit(1);
  }
  const items: Record<string, unknown>[] = [];
  for await (const item of feed.call(colony)) items.push(item);
  const written = writeExport(dir, items, { skill: flag("--skill"), source: colony.url });
  console.log(tx(`${written} trails from ${colony.url} written to ${dir}${flag("--skill") ? " as a skill (SKILL.md)" : ""}.`, `${written} rastros de ${colony.url} escritos en ${dir}${flag("--skill") ? " como skill (SKILL.md)" : ""}.`));
  process.exit(0);
}

const colonyKey = process.env.MYRMO_API_KEY?.trim() || savedColony?.api_key;

// `myrmo-mcp pilot-roi [days] [--json]`: the pilot summary of a private colony, for its operator. The server renders the
// text, so this command and `myrmo-server pilot-roi` always say the same thing.
if (args[0] === "pilot-roi") {
  const daysArg = args.slice(1).find((a) => !a.startsWith("-"));
  const days = Math.min(90, Math.max(1, Number.parseInt(daysArg ?? "14", 10) || 14));
  const token = process.env.MYRMO_ADMIN_TOKEN?.trim();
  if (!token) {
    console.error(tx("pilot-roi needs the colony's operator token: MYRMO_ADMIN_TOKEN=<token> npx myrmo-mcp pilot-roi [days]", "pilot-roi necesita el token de operador de la colonia: MYRMO_ADMIN_TOKEN=<token> npx myrmo-mcp pilot-roi [días]"));
    process.exit(2);
  }
  const json = flag("--json");
  const url = `${colonyUrl.replace(/\/+$/, "")}/v1/admin/pilot-roi?days=${days}${json ? "" : "&format=text"}`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) {
      console.error(`${colonyUrl} answered ${res.status}: ${body.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) console.error(tx("Check MYRMO_ADMIN_TOKEN: it is the colony's operator token, not a person's key.", "Revisa MYRMO_ADMIN_TOKEN: es el token de operador de la colonia, no la clave de una persona."));
      if (res.status === 404) console.error(tx("This colony is older than the pilot summary: upgrade it.", "Esta colonia es anterior al resumen del piloto: actualízala."));
      process.exit(1);
    }
    process.stdout.write(json ? `${JSON.stringify(JSON.parse(body), null, 2)}\n` : body);
    process.exit(0);
  } catch (err) {
    console.error(tx(`Could not reach ${colonyUrl}: ${err instanceof Error ? err.message : String(err)}`, `No se pudo llegar a ${colonyUrl}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

/** GET /v1/version from the colony, or null. The saved key belongs to the saved colony only (fileColony matches the URL). */
async function askVersion(timeoutMs: number): Promise<{ clients?: { mcp?: string }; colony?: unknown } | null> {
  try {
    const res = await fetch(`${colonyUrl.replace(/\/+$/, "")}/v1/version`, {
      headers: { accept: "application/json", "x-myrmo-client": `myrmo-mcp/${VERSION}`, ...(colonyKey ? { authorization: `Bearer ${colonyKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as { clients?: { mcp?: string }; colony?: unknown }) : null;
  } catch {
    return null;
  }
}

// `myrmo-mcp doctor`: checks that this machine can use the colony and says what to fix.
if (args[0] === "doctor") {
  const { diagnose, render } = await import("./doctor.js");
  const answer = await askVersion(5000);
  const declared = clean(answer?.colony) ?? readDeclared(colonyUrl);
  if (answer?.colony) rememberDeclared(colonyUrl, answer.colony);
  const checks = await diagnose({
    url: colonyUrl,
    saved: savedColony !== undefined,
    apiKey: colonyKey,
    privateMode: privateMode(colonyUrl, process.env, savedColony?.private === true, declared, Boolean(colonyKey)).on,
    declared,
    publish: publishMode,
    home: (await import("node:os")).homedir(),
  });
  console.log(render(checks));
  process.exit(checks.some((c) => c.level === "fail") ? 1 : 0);
}

if (args[0] === "join") {
  const { exchange, handleFrom, joinUsage, parseInvitation } = await import("./join.js");
  if (!args[1]) {
    console.log(joinUsage());
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const { userInfo } = await import("node:os");
  const link = args[1] === "-" ? readFileSync(0, "utf8") : args[1];
  const inv = parseInvitation(link);
  if (typeof inv === "string") {
    console.error(inv);
    process.exit(2);
  }
  let name = option("--name", "") || handleFrom(process.env.USER ?? process.env.USERNAME ?? userInfo().username) || "";
  if (!name) {
    console.error(tx("Say how the colony should know you: --name <handle> (2 to 32 lowercase letters, digits, '.', '-' or '_').", "Di cómo debe conocerte la colonia: --name <alias> (de 2 a 32 letras minúsculas, dígitos, '.', '-' o '_')."));
    process.exit(2);
  }
  const publish = option("--publish", "auto");
  if (!["auto", "ask", "off"].includes(publish)) {
    console.error(tx("--publish takes auto, ask or off", "--publish acepta auto, ask u off"));
    process.exit(2);
  }
  const clientsArg = option("--client", "");
  // The options are checked before the invitation is spent; the key here is a stand-in for the one the colony gives.
  const initArgs = ["--url", inv.url, "--key", "myk_" + "0".repeat(64), "--publish", publish, ...(clientsArg ? ["--client", clientsArg] : [])];
  const parsed = parseInitArgs(initArgs);
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(2);
  }
  if (flag("--dry-run")) {
    console.log(tx(`Would join ${inv.url} as "${name}", then set this machine's agents up for it (publishing: ${publish}).`, `Se uniría a ${inv.url} como "${name}" y después configuraría para ella los agentes de esta máquina (publicación: ${publish}).`));
    process.exit(0);
  }
  const joined = await exchange(inv, name);
  if (typeof joined === "string") {
    console.error(tx(`Could not join: ${joined}.`, `No se pudo unir: ${joined}.`));
    process.exit(1);
  }
  console.log(tx(`Joined ${inv.url} as "${joined.name}". Setting up this machine's agents...\n`, `Te has unido a ${inv.url} como "${joined.name}". Configurando los agentes de esta máquina...\n`));
  runInit({ ...parsed, key: joined.key, keySource: "file" });
  console.log(tx("\nCheck it any time with: npx myrmo-mcp doctor", "\nCompruébalo cuando quieras con: npx myrmo-mcp doctor"));
  process.exit(0);
}

if (args[0] === "init") {
  const { canAsk, Cancelled, terminal, wizard } = await import("./wizard.js");
  // `init` alone in a terminal asks a few questions (arrows and Enter); any option, --yes, a script or CI: as before.
  if (args.length === 1 && canAsk()) {
    const { existsSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { CLIENT_IDS, findClaudeCli, keyIn, targets } = await import("./init.js");
    const home = homedir();
    const found = new Map(targets(home).map((t) => [t.id, { name: t.name, found: existsSync(t.marker) }]));
    const clients = CLIENT_IDS.map((id) =>
      id === "claude-code"
        ? { id, name: "Claude Code", found: Boolean(findClaudeCli(home)) || existsSync(join(home, ".claude")) }
        : { id, name: found.get(id)?.name ?? id, found: found.get(id)?.found ?? false },
    );
    try {
      const answer = await wizard(terminal(), {
        clients,
        savedUrl: readConfig().colony?.url,
        readKeyFile: (path) => {
          try {
            return keyIn(readFileSync(path.replace(/^~(?=\/)/, home), "utf8")) ?? null;
          } catch {
            return null;
          }
        },
        probe: async (url, key) => {
          try {
            const res = await fetch(`${url}/v1/version`, { headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(5000) });
            const body = (await res.json().catch(() => null)) as { colony?: { profile?: string; people_detail?: string | null }; error?: { message?: string } } | null;
            if (res.ok) return { ok: true, status: res.status, profile: body?.colony?.profile, people: body?.colony?.people_detail ?? null };
            const why = res.status === 401 ? tx("The colony does not accept this key (copied wrong, or revoked).", "La colonia no acepta esta clave (mal copiada o revocada).") : res.status === 403 ? (body?.error?.message ?? tx("This machine's network is not allowed to connect.", "La red de esta máquina no tiene permitido conectarse.")) : tx(`The colony answered ${res.status}.`, `La colonia respondió ${res.status}.`);
            return { ok: false, status: res.status, detail: why };
          } catch {
            return { ok: false, detail: tx("No answer from that address (wrong address, or not reachable from this network).", "Esa dirección no responde (dirección equivocada, o no se llega desde esta red).") };
          }
        },
      });
      if (answer.cancelled) {
        console.log(tx("Nothing was changed.", "No se ha cambiado nada."));
        process.exit(0);
      }
      const opts: Parameters<typeof runInit>[0] = { clients: answer.clients, dryRun: false };
      if (answer.url) Object.assign(opts, { url: answer.url, key: answer.key, private: Boolean(answer.key), publish: answer.publish });
      else {
        // Back to the public colony when another one was saved, and its publishing choice.
        const saved = readConfig().colony?.url;
        if (saved && !/^https?:\/\/(www\.)?myrmo\.dev\/?$/i.test(saved)) opts.url = "https://myrmo.dev";
        if (answer.publicPublish) setSetting("publish", answer.publicPublish);
      }
      console.log("");
      runInit(opts);
      console.log(tx("\nCheck it any time with: npx myrmo-mcp doctor", "\nCompruébalo cuando quieras con: npx myrmo-mcp doctor"));
      process.exit(0);
    } catch (err) {
      if (err instanceof Cancelled) process.exit(130);
      throw err;
    }
  }
  const parsed = parseInitArgs(args.slice(1).filter((a) => a !== "--yes"));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(2);
  }
  runInit(parsed);
  process.exit(0);
}

if (flag("--http")) {
  await serveHttp(Number(option("--port", process.env.PORT ?? "3333")), option("--host", DEFAULT_HTTP_HOST));
} else {
  // What the colony says it is decides private mode (protocol 1.7). Known from an earlier start, it is used at once and
  // refreshed in the background; the first time, the server waits up to two seconds for the colony to say it.
  let declared: ColonyDescription | undefined = readDeclared(colonyUrl);
  let latest: string | undefined;
  const asked = askVersion(5000).then((body) => {
    latest = body?.clients?.mcp;
    if (body?.colony) {
      rememberDeclared(colonyUrl, body.colony);
      declared = clean(body.colony) ?? declared;
    }
  });
  // Waiting only matters where the answer can change the mode: one's own colony, with a key or a --private flag.
  const couldBePrivate = Boolean(colonyKey) || process.env.MYRMO_PRIVATE === "1" || savedColony?.private === true;
  if (!declared && couldBePrivate && !/^https?:\/\/(www\.)?myrmo\.dev(\/|$)/i.test(colonyUrl)) {
    await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  }
  const privacy = privateMode(colonyUrl, process.env, savedColony?.private === true, declared, Boolean(colonyKey));
  // In a private colony the network's addresses and host names stay in what is sent (the colony keeps them too).
  // It says which client it is, so an operator sees in the admin panel who runs an old one.
  const colony = new Colony({ publish: publishMode, private: privacy.on, keepPersonal: declared?.keep_personal === true, headers: { "x-myrmo-client": `myrmo-mcp/${VERSION}` } });
  if (privacy.warning) console.error(`myrmo-mcp: ${privacy.warning}`);
  const server = createServer({
    colony,
    privateColony: privacy.on,
    keepPersonal: declared?.keep_personal === true,
    identity: (() => {
      const key = colonyKey;
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
    latestVersion: () => latest,
    colonyDescription: () => declared,
    fillLocalEnvironment: true,
    allowHighRisk,
  });
  await server.connect(new StdioServerTransport());
}

/** Loopback and private addresses: where a reverse proxy of the same deployment connects from. */
function trustedPeer(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return (
    a === "::1" ||
    /^127\./.test(a) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a)
  );
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
  const hosts = allowedHosts(port);
  const url = hostedColonyUrl();
  const http = createHttpServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") return sendJson(res, 200, { status: "ok", version: VERSION });
    if (path !== "/mcp") return sendJson(res, 404, { error: "Use POST /mcp" });
    if (req.method !== "POST") return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null });

    // Every request gets its own server and transport: no sessions, so any replica can answer.
    const headers: Record<string, string> = {};
    // The caller's address, for the colony's per-address limits: X-Forwarded-For only from a proxy of this deployment
    // (loopback or a private network, as the gateway's MYRMO_TRUSTED_PROXIES default), never from a caller who reached
    // this port directly and could otherwise choose the address its quotas are counted against.
    const peer = req.socket.remoteAddress ?? "";
    const claimed = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
    const forwarded = (trustedPeer(peer) && claimed ? claimed.split(",")[0] : peer).trim();
    if (forwarded) headers["x-forwarded-for"] = forwarded;
    const agent = req.headers["x-myrmo-agent"];
    if (typeof agent === "string") headers["x-myrmo-agent"] = agent;
    const colony = new Colony({
      url,
      headers,
      // The caller's own key or none: never MYRMO_API_KEY or a key saved on this machine, which anyone who can reach
      // this port would otherwise use.
      apiKey: callerKey(req.headers.authorization),
      publish: "off",
      cacheTtlMs: 0,
      // The hosted server has no identity of its own: it forwards the header of whoever is calling.
      agentId: false,
    });
    const server = createServer({ colony, publishMode: "off", minFailedAttempts, fillLocalEnvironment: false, hosted: true });
    // A web page can make a browser send requests to this port under a name it controls (DNS rebinding): only the
    // Host names this server is meant for are answered (MYRMO_MCP_ALLOWED_HOSTS).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(hosts ? { enableDnsRebindingProtection: true, allowedHosts: hosts } : {}),
    });
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
  http.listen(port, host, () =>
    console.error(`myrmo-mcp ${VERSION} listening on http://${host}:${port}/mcp for ${url}; Host names answered: ${hosts ? hosts.join(", ") : "any (MYRMO_MCP_ALLOWED_HOSTS=*)"}`),
  );
}
