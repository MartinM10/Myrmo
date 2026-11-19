// The colony kit, seen from myrmo-mcp. What only an organisation's colony offers on the client side is not in this
// package: the colony serves it to its members as a signed kit, installed in ~/.myrmo/kit/<version>/. The logic that
// finds, verifies and installs it is the plugin's kit.mjs, which the build copies into dist/hooks: it is imported from
// there, not written again here.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfig } from "myrmo";
import { t as tx } from "./i18n.js";

/** The kit in use: its version and folder; `dev` when MYRMO_KIT_DEV points at a folder of one being developed. */
export interface KitInfo {
  version: string;
  dir: string;
  dev?: boolean;
}

export interface KitInstall {
  state: "installed" | "current" | "none";
  version?: string;
}

/** What dist/hooks/kit.mjs exports. */
export interface KitApi {
  currentKit(env?: NodeJS.ProcessEnv): KitInfo | null;
  installKit(o: { url: string; apiKey?: string; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> }): Promise<KitInstall>;
  loadKit(name: string, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null>;
}

/** The package's own hook scripts (scripts/copy-hooks.mjs puts them there). */
export const packageHooks = () => join(dirname(fileURLToPath(import.meta.url)), "hooks");

/** kit.mjs from the package's hooks, or null if it cannot load (a broken install). */
export async function kitApi(from: string = packageHooks()): Promise<KitApi | null> {
  try {
    return (await import(pathToFileURL(join(from, "kit.mjs")).href)) as KitApi;
  } catch {
    return null;
  }
}

/** The kit in use on this machine, or null. */
export async function findKit(env: NodeJS.ProcessEnv = process.env, from?: string): Promise<KitInfo | null> {
  return (await kitApi(from))?.currentKit(env) ?? null;
}

/** The kit's text for the agents (its instructions.md), when it has one. */
export function kitInstructions(kit: KitInfo | null | undefined): string | undefined {
  if (!kit) return undefined;
  try {
    const text = readFileSync(join(kit.dir, "instructions.md"), "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** The kit's scripts, which a hook installed outside Claude Code's plugin runs from ~/.myrmo/hooks (a self-contained set). */
export function kitScripts(kit: KitInfo): string[] {
  try {
    return readdirSync(kit.dir).filter((n) => n.endsWith(".mjs")).sort();
  } catch {
    return [];
  }
}

/** What the MCP server takes from the kit: its tools and its text for the agent. */
export interface ServerKit {
  version: string;
  registerTools?: (ctx: Record<string, unknown>) => string[];
  instructions?: string;
}

/** The kit's parts for the MCP server, or undefined when there is no kit. */
export async function serverKit(env: NodeJS.ProcessEnv = process.env, from?: string): Promise<ServerKit | undefined> {
  const api = await kitApi(from);
  const kit = api?.currentKit(env);
  if (!api || !kit) return undefined;
  const tools = await api.loadKit("mcp-tools.mjs", env);
  const registerTools = typeof tools?.registerTools === "function" ? (tools.registerTools as ServerKit["registerTools"]) : undefined;
  return { version: kit.version, registerTools, instructions: kitInstructions(kit) };
}

/** Why a colony serves no kit, for the person. */
export const NO_KIT = () =>
  tx(
    "this colony serves no kit (it is the public colony, a server older than the kit, or the key is not a member's)",
    "esta colonia no sirve ningún kit (es la colonia pública, un servidor anterior al kit, o la clave no es de un miembro)",
  );

/** How to get the kit, for a message that needs it. */
export const GET_KIT = "npx myrmo-mcp@latest kit";

/**
 * Installs or updates the colony's kit and says what happened in one line. The colony is the one given, else the one
 * saved by `init --url` (its key goes only to that colony). Returns the kit in use afterwards, or null.
 */
export async function installFromColony(
  o: { url?: string; key?: string; dryRun?: boolean; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; from?: string; client?: string },
  log: (line: string) => void,
): Promise<KitInfo | null> {
  const env = o.env ?? process.env;
  const api = await kitApi(o.from);
  if (!api) {
    log(tx("Kit: this myrmo-mcp cannot load its kit installer (dist/hooks/kit.mjs); reinstall it", "Kit: este myrmo-mcp no puede cargar su instalador del kit (dist/hooks/kit.mjs); reinstálalo"));
    return null;
  }
  const saved = readConfig().colony;
  const norm = (u?: string) => (u ?? "").trim().replace(/\/+$/, "");
  const url = norm(o.url) || norm(saved?.url);
  const key = o.key ?? (saved && norm(saved.url) === url ? saved.api_key : undefined);
  if (!url) {
    log(tx("Kit: no colony saved on this machine: run init with --url and --key first", "Kit: no hay ninguna colonia guardada en esta máquina: ejecuta antes init con --url y --key"));
    return api.currentKit(env);
  }
  if (o.dryRun) {
    log(tx(`Kit: would install or update the kit ${url} serves`, `Kit: se instalaría o actualizaría el kit que sirve ${url}`));
    return api.currentKit(env);
  }
  try {
    const r = await api.installKit({ url, apiKey: key, env, ...(o.fetcher ? { fetcher: o.fetcher } : {}), ...(o.client ? { headers: { "x-myrmo-client": o.client } } : {}) });
    if (r.state === "installed") log(tx(`Kit: installed ${r.version} from ${url}`, `Kit: instalado ${r.version} desde ${url}`));
    else if (r.state === "current") log(tx(`Kit: ${r.version} from ${url}, up to date`, `Kit: ${r.version} de ${url}, al día`));
    else log(tx(`Kit: none installed: ${NO_KIT()}`, `Kit: no se ha instalado: ${NO_KIT()}`));
  } catch (err) {
    log(tx(`Kit: not installed: ${err instanceof Error ? err.message : String(err)}`, `Kit: no se ha instalado: ${err instanceof Error ? err.message : String(err)}`));
  }
  return api.currentKit(env);
}

/** Whether a folder holds a kit's work log scripts for one agent (what init copies for it). */
export const kitHas = (kit: KitInfo | null | undefined, script: string): boolean => Boolean(kit && existsSync(join(kit.dir, script)));
