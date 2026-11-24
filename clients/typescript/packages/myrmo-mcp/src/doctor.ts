// `myrmo-mcp doctor`: is this machine set up to use the colony, and if not, what to do. For the person, not the agent.
// Every check says what it found and, when it fails, the one thing to try. Nothing is changed and no text of any
// trail is read: it asks the colony whether it is up, whether it lets this network in and whether this key opens it.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGY_WORKLOG_EVENTS, AGY_WORKLOG_GROUP, CLINE_HOOK_EVENTS, CLINE_MARK, GEMINI_HOOK_EVENTS, GEMINI_HOOK_NAME, claudeCodeSetUp, claudeWorkLogHook, clineHooksDir, clineInstalled, geminiInstalled, targets } from "./init.js";
import { compareVersions, describeColony, VERSION, VERSION_SHAPE } from "./server.js";
import { t } from "./i18n.js";
import { findKit, GET_KIT, type KitInfo } from "./kit.js";

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
  /** What the colony says it is (GET /v1/version), when it said it. */
  declared?: { profile?: string; people_detail?: string | null; holdout_percent?: number; effort?: boolean; worklog_scopes?: string[] };
  publish: string;
  nodeVersion?: string;
  home: string;
  fetchImpl?: typeof fetch;
  /** The environment this command runs in: where MYRMO_WORKLOG is looked for (default: process.env). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The colony kit in use (default: the one installed on this machine, src/kit.ts `findKit`). */
  kit?: KitInfo | null;
}

/**
 * The colony kit: what only an organisation's colony offers on the client side, installed from it. One line for a
 * private colony, or wherever a kit is installed or offered; none otherwise.
 */
export function kitCheck(kit: KitInfo | null, offered: string | undefined, privateMode: boolean): Check | null {
  const name = t("Colony kit", "Kit de la colonia");
  if (kit?.dev) {
    return { level: "warn", name, detail: t(`a kit in development, unsigned (MYRMO_KIT_DEV=${kit.dir})`, `un kit en desarrollo, sin firmar (MYRMO_KIT_DEV=${kit.dir})`), fix: t("Unset MYRMO_KIT_DEV unless you are developing the kit.", "Quita MYRMO_KIT_DEV salvo que estés desarrollando el kit.") };
  }
  if (kit) {
    if (offered && offered !== kit.version) {
      return { level: "warn", name, detail: t(`${kit.version} installed, this colony offers ${offered}`, `${kit.version} instalado, esta colonia ofrece ${offered}`), fix: t(`${GET_KIT}   (Claude Code updates it by itself when a session starts)`, `${GET_KIT}   (Claude Code lo actualiza solo al empezar una sesión)`) };
    }
    return { level: "ok", name, detail: t(`${kit.version} installed`, `${kit.version} instalado`) };
  }
  if (offered) {
    return { level: "warn", name, detail: t(`none installed; this colony offers ${offered} (the team's work log and its tools come with it)`, `ninguno instalado; esta colonia ofrece ${offered} (el registro de trabajo del equipo y sus herramientas vienen con él)`), fix: t(`${GET_KIT}   (Claude Code installs it by itself when a session starts)`, `${GET_KIT}   (Claude Code lo instala solo al empezar una sesión)`) };
  }
  return privateMode ? { level: "ok", name, detail: t("none installed, and this colony offers none", "ninguno instalado, y esta colonia no ofrece ninguno") } : null;
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

/** The node an Antigravity work log command starts, as init wrote it; undefined for a bare `node` or another shape. */
export function agyHookNode(command: string): string | undefined {
  const m = /^'([^']+)'\s/.exec(command) ?? /^([^\s"']+)\s+"/.exec(command);
  return m && m[1] !== "node" ? m[1] : undefined;
}

/** The node a Gemini CLI hook command starts, as init wrote it (the first quoted path); undefined for another shape. */
export function geminiHookNode(command: string): string | undefined {
  return /(?:MYRMO_WORKLOG=1|&)\s+'([^']+)'/.exec(command)?.[1];
}

/** The node a Cline hook file starts, as init wrote it; undefined when the file is not ours or has another shape. */
export function clineHookNode(text: string): string | undefined {
  if (!text.includes(CLINE_MARK)) return undefined;
  return /exec '((?:[^']|'\\'')+)'/.exec(text)?.[1]?.replace(/'\\''/g, "'") ?? /& "([^"]+)"/.exec(text)?.[1];
}

/**
 * Where Claude Code gets MYRMO_WORKLOG=1, or null: the shell this runs in, the `env` block of ~/.claude/settings.json
 * (which applies however Claude Code is started, from a terminal or from VS Code), or a work log hook registered there
 * with the variable on its own command line.
 */
export function claudeWorkLogSource(home: string, env: NodeJS.ProcessEnv): string | null {
  let settings: { env?: Record<string, unknown>; hooks?: unknown } | undefined;
  try {
    settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    settings = undefined;
  }
  if (String(settings?.env?.MYRMO_WORKLOG ?? "") === "1") return t("MYRMO_WORKLOG=1 in ~/.claude/settings.json", "MYRMO_WORKLOG=1 en ~/.claude/settings.json");
  if (/MYRMO_WORKLOG=1[^"]*worklog-hook\.mjs/.test(JSON.stringify(settings?.hooks ?? ""))) return t("the work log hook in ~/.claude/settings.json", "el hook del registro en ~/.claude/settings.json");
  if (env.MYRMO_WORKLOG === "1") return t("MYRMO_WORKLOG=1 in this shell", "MYRMO_WORKLOG=1 en esta terminal");
  return null;
}

/**
 * Private mode on this machine (plugins/myrmo/scripts/privacy.mjs): a machine paused with ~/.myrmo/worklog-paused, or
 * MYRMO_WORKLOG_PAUSE=1, sends nothing to Myrmo from any session, and a person can forget the file is there; sessions
 * made private with //privado are counted, never read. Nothing is sent.
 */
/** Why a missing hook matters to private mode: without it, //privado cannot stop a call to Myrmo. */
const privateGap = (missing: string[], es = false) =>
  missing.some((e) => e === "PreToolUse" || e === "BeforeTool") ? (es ? " (sin él, //privado no puede parar una llamada a Myrmo)" : " (without it, //privado cannot stop a call to Myrmo)") : "";

export function privacyCheck(home: string, env: NodeJS.ProcessEnv = process.env): Check | null {
  const name = t("Private mode", "Modo privado");
  const file = join(home, ".myrmo", "worklog-paused");
  if (env.MYRMO_WORKLOG_PAUSE === "1" || existsSync(file)) {
    const there = existsSync(file);
    return {
      level: "warn",
      name,
      detail: t(`this machine is paused (${there ? file : "MYRMO_WORKLOG_PAUSE=1"}): no session sends anything to Myrmo (no lookups, no work log, no publications)`, `esta máquina está en pausa (${there ? file : "MYRMO_WORKLOG_PAUSE=1"}): ninguna sesión envía nada a Myrmo (ni consultas, ni registro de trabajo, ni publicaciones)`),
      fix: there ? t(`Delete ${file} to share again`, `Borra ${file} para volver a compartir`) : t("Unset MYRMO_WORKLOG_PAUSE to share again", "Quita MYRMO_WORKLOG_PAUSE para volver a compartir"),
    };
  }
  let sessions = 0;
  try {
    sessions = readdirSync(join(home, ".myrmo", "private")).filter((f) => f.endsWith(".json")).length;
  } catch {
    sessions = 0;
  }
  if (!sessions) return null;
  return { level: "ok", name, detail: t(`${sessions} session${sessions === 1 ? "" : "s"} made private with //privado (type //compartir in one to share it again)`, `${sessions} ${sessions === 1 ? "sesión hecha privada" : "sesiones hechas privadas"} con //privado (escribe //compartir en una para volver a compartirla)`) };
}

/**
 * The work log, client by client: which agents on this machine record what they do in it, and which cannot yet. Only
 * for a colony that keeps one; nothing is sent and no text is read.
 */
export async function workLogChecks(input: DoctorInput, fetchImpl: typeof fetch): Promise<Check[]> {
  const scopes = input.declared?.worklog_scopes;
  if (!input.privateMode || !Array.isArray(scopes) || scopes.length === 0) return [];
  const name = t("Work log", "Registro de trabajo");
  const checks: Check[] = [];
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;

  const enrolled = await call(fetchImpl, `${input.url.replace(/\/+$/, "")}/v1/worklog/matters?limit=1`, input.apiKey);
  if ("status" in enrolled && enrolled.status === 403) {
    checks.push({ level: "warn", name, detail: t("this colony keeps one, but your key is not enrolled in it", "esta colonia lo lleva, pero tu clave no está inscrita"), fix: t("Ask whoever runs the colony to enrol your key in the work log", "Pide a quien opera la colonia que inscriba tu clave en el registro de trabajo") });
    return checks;
  }
  // The hooks of Cline, Gemini CLI and Antigravity run a script that comes with the colony kit, copied to ~/.myrmo/hooks.
  const script = (file: string) => existsSync(join(input.home, ".myrmo", "hooks", file));
  const noScript = {
    detail: t("the hooks are in place, but the script they run is not on this machine (it comes with the colony kit)", "los hooks están puestos, pero el script que ejecutan no está en esta máquina (viene con el kit de la colonia)"),
    fix: t(`${GET_KIT}   then   npx myrmo-mcp@latest init --worklog`, `${GET_KIT}   y después   npx myrmo-mcp@latest init --worklog`),
  };

  let capturing = 0;
  if (claudeCodeSetUp(input.home)) {
    const source = claudeWorkLogSource(input.home, env);
    let settingsText = "";
    try {
      settingsText = readFileSync(join(input.home, ".claude", "settings.json"), "utf8");
    } catch {
      settingsText = "";
    }
    const hook = claudeWorkLogHook(settingsText);
    const plugin = /"MYRMO_WORKLOG"\s*:\s*"1"/.test(settingsText) || env.MYRMO_WORKLOG === "1";
    if (hook && plugin) {
      capturing++;
      checks.push({ level: "warn", name: `${name}, Claude Code`, detail: t("recorded twice: by the plugin (MYRMO_WORKLOG=1) and by a work log hook of its own", "se registra dos veces: por el plugin (MYRMO_WORKLOG=1) y por un hook del registro aparte"), fix: t("Keep one: remove the worklog-hook.mjs entries from ~/.claude/settings.json, or MYRMO_WORKLOG=1 from its env", "Deja uno: quita de ~/.claude/settings.json las entradas de worklog-hook.mjs, o MYRMO_WORKLOG=1 de su env") });
    } else if (source) {
      capturing++;
      checks.push({ level: "ok", name: `${name}, Claude Code`, detail: t(`recorded (${source})`, `se registra (${source})`) });
    } else {
      checks.push({
        level: "warn",
        name: `${name}, Claude Code`,
        detail: t("not recorded: MYRMO_WORKLOG=1 is set nowhere Claude Code reads it", "no se registra: MYRMO_WORKLOG=1 no está en ningún sitio que lea Claude Code"),
        fix: t('Add "env": { "MYRMO_WORKLOG": "1" } to ~/.claude/settings.json (it works however Claude Code is started), then restart it', 'Añade "env": { "MYRMO_WORKLOG": "1" } a ~/.claude/settings.json (vale arranques Claude Code como lo arranques) y reinícialo'),
      });
    }
  }

  if (clineInstalled(input.home)) {
    const missing: string[] = [];
    const foreign: string[] = [];
    const broken: string[] = [];
    for (const event of CLINE_HOOK_EVENTS) {
      const file = join(clineHooksDir(input.home), platform === "win32" ? `${event}.ps1` : event);
      if (!existsSync(file)) {
        missing.push(event);
        continue;
      }
      const node = clineHookNode(readFileSync(file, "utf8"));
      if (!node) foreign.push(event);
      else if (!existsSync(node)) broken.push(event);
    }
    const fix = t("npx myrmo-mcp@latest init --worklog   then reload VS Code (Developer: Reload Window)", "npx myrmo-mcp@latest init --worklog   y recarga VS Code (Developer: Reload Window)");
    if (missing.length === CLINE_HOOK_EVENTS.length) {
      checks.push({ level: "warn", name: `${name}, Cline`, detail: t("not recorded: the hooks are not installed", "no se registra: los hooks no están instalados"), fix });
    } else if (broken.length) {
      checks.push({ level: "warn", name: `${name}, Cline`, detail: t(`not recorded: the hooks start a node that no longer exists (${broken.join(", ")})`, `no se registra: los hooks arrancan un node que ya no existe (${broken.join(", ")})`), fix });
    } else if (missing.length) {
      checks.push({ level: "warn", name: `${name}, Cline`, detail: t(`incomplete: ${missing.join(", ")} missing${privateGap(missing)}`, `incompleto: falta ${missing.join(", ")}${privateGap(missing, true)}`), fix });
    } else if (foreign.length < CLINE_HOOK_EVENTS.length && !script("cline-hook.mjs")) {
      checks.push({ level: "warn", name: `${name}, Cline`, ...noScript });
    } else {
      capturing++;
      checks.push({ level: "ok", name: `${name}, Cline`, detail: foreign.length ? t(`recorded, except ${foreign.join(", ")}: hooks of your own are in their place`, `se registra, salvo ${foreign.join(", ")}: en su lugar hay hooks tuyos`) : t("recorded (hooks in place; reload VS Code once after installing them)", "se registra (hooks instalados; recarga VS Code una vez tras instalarlos)") });
    }
  }

  let geminiChecked = false;
  if (geminiInstalled(input.home)) {
    const file = join(input.home, ".gemini", "settings.json");
    let settings: any = {};
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* missing or damaged: no hooks */
    }
    const commands = new Map<string, string>();
    for (const event of GEMINI_HOOK_EVENTS) {
      const defs: any[] = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
      const hook = defs.flatMap((d) => (Array.isArray(d?.hooks) ? d.hooks : [])).find((h: any) => h?.name === GEMINI_HOOK_NAME);
      if (typeof hook?.command === "string") commands.set(event, hook.command);
    }
    const uses = /myrmo/i.test(JSON.stringify(settings?.mcpServers ?? {}));
    if (commands.size || uses) {
      geminiChecked = true;
      const missing = GEMINI_HOOK_EVENTS.filter((e) => !commands.has(e));
      const broken = [...commands].filter(([, c]) => {
        const node = geminiHookNode(c);
        return node !== undefined && !existsSync(node);
      }).map(([e]) => e);
      const fix = t("npx myrmo-mcp@latest init --worklog   then restart Gemini CLI", "npx myrmo-mcp@latest init --worklog   y reinicia Gemini CLI");
      if (missing.length === GEMINI_HOOK_EVENTS.length) {
        checks.push({ level: "warn", name: `${name}, Gemini CLI`, detail: t("not recorded: the hooks are not installed", "no se registra: los hooks no están instalados"), fix });
      } else if (broken.length) {
        checks.push({ level: "warn", name: `${name}, Gemini CLI`, detail: t(`not recorded: the hooks start a node that no longer exists (${broken.join(", ")})`, `no se registra: los hooks arrancan un node que ya no existe (${broken.join(", ")})`), fix });
      } else if (missing.length) {
        checks.push({ level: "warn", name: `${name}, Gemini CLI`, detail: t(`incomplete: ${missing.join(", ")} missing${privateGap(missing)}`, `incompleto: falta ${missing.join(", ")}${privateGap(missing, true)}`), fix });
      } else if (settings?.hooksConfig?.enabled === false) {
        checks.push({ level: "warn", name: `${name}, Gemini CLI`, detail: t("not recorded: hooks are turned off in Gemini CLI (hooksConfig.enabled: false)", "no se registra: los hooks están desactivados en Gemini CLI (hooksConfig.enabled: false)"), fix: t("Remove hooksConfig.enabled: false from ~/.gemini/settings.json, or run /hooks enable-all", "Quita hooksConfig.enabled: false de ~/.gemini/settings.json, o ejecuta /hooks enable-all") });
      } else if (!script("gemini-hook.mjs")) {
        checks.push({ level: "warn", name: `${name}, Gemini CLI`, ...noScript });
      } else {
        capturing++;
        checks.push({ level: "ok", name: `${name}, Gemini CLI`, detail: t("recorded (hooks in place; restart Gemini CLI once after installing them)", "se registra (hooks instalados; reinicia Gemini CLI una vez tras instalarlos)") });
      }
    }
  }

  // Antigravity (its editor, 2.0 and the agy CLI): the work log's group in ~/.gemini/config/hooks.json.
  let agyChecked = false;
  const agyMcp = join(input.home, ".gemini", "config", "mcp_config.json");
  const agyHooks = join(input.home, ".gemini", "config", "hooks.json");
  const agyUses = existsSync(agyMcp) && /myrmo/i.test(readFileSync(agyMcp, "utf8"));
  if (agyUses || existsSync(agyHooks)) {
    let hooks: any = {};
    try {
      hooks = JSON.parse(readFileSync(agyHooks, "utf8"));
    } catch {
      /* missing or damaged: no hooks */
    }
    const group = hooks?.[AGY_WORKLOG_GROUP];
    const commands = new Map<string, string>();
    for (const event of AGY_WORKLOG_EVENTS) {
      const command = Array.isArray(group?.[event]) ? group[event].find((h: any) => typeof h?.command === "string")?.command : undefined;
      if (command) commands.set(event, command);
    }
    if (commands.size || agyUses) {
      agyChecked = true;
      const missing = AGY_WORKLOG_EVENTS.filter((e) => !commands.has(e));
      const broken = [...commands].filter(([, c]) => {
        const node = agyHookNode(c);
        return node !== undefined && !existsSync(node);
      }).map(([e]) => e);
      const fix = t("npx myrmo-mcp@latest init --worklog   then start a new conversation in Antigravity", "npx myrmo-mcp@latest init --worklog   y abre una conversación nueva en Antigravity");
      if (missing.length === AGY_WORKLOG_EVENTS.length) {
        checks.push({ level: "warn", name: `${name}, Antigravity`, detail: t("not recorded: the hook is not installed", "no se registra: el hook no está instalado"), fix });
      } else if (broken.length) {
        checks.push({ level: "warn", name: `${name}, Antigravity`, detail: t(`not recorded: the hook starts a node that no longer exists (${broken.join(", ")})`, `no se registra: el hook arranca un node que ya no existe (${broken.join(", ")})`), fix });
      } else if (missing.length) {
        checks.push({ level: "warn", name: `${name}, Antigravity`, detail: t(`incomplete: ${missing.join(", ")} missing${privateGap(missing)}`, `incompleto: falta ${missing.join(", ")}${privateGap(missing, true)}`), fix });
      } else if (group?.enabled === false) {
        checks.push({ level: "warn", name: `${name}, Antigravity`, detail: t(`not recorded: the hook is turned off ("enabled": false in ${AGY_WORKLOG_GROUP})`, `no se registra: el hook está desactivado ("enabled": false en ${AGY_WORKLOG_GROUP})`), fix });
      } else if (!script("antigravity-worklog.mjs")) {
        checks.push({ level: "warn", name: `${name}, Antigravity`, ...noScript });
      } else {
        capturing++;
        checks.push({ level: "ok", name: `${name}, Antigravity`, detail: t("recorded (hook in place; it starts with the next conversation)", "se registra (hook instalado; empieza con la próxima conversación)") });
      }
    }
  }

  // Everything else Myrmo can set up talks to the colony through its tools, but has no hook that records the work.
  const others = targets(input.home, platform)
    .filter((c) => c.id !== "claude-desktop" && !(geminiChecked && c.id === "gemini") && !(agyChecked && c.id === "antigravity") && existsSync(c.file) && /myrmo/i.test(readFileSync(c.file, "utf8")))
    .map((c) => c.name);
  if (others.length) {
    checks.push({
      level: capturing ? "ok" : "warn",
      name: t(`${name}, other agents`, `${name}, otros agentes`),
      detail: t(`${others.join(", ")}: not recorded (Myrmo has no work log hook for them yet)`, `${others.join(", ")}: no se registra (Myrmo aún no tiene hook del registro para ellos)`),
      ...(capturing ? {} : { fix: t("Use Claude Code, Cline, Gemini CLI or Antigravity for the work you want in the work log", "Usa Claude Code, Cline, Gemini CLI o Antigravity para el trabajo que quieras en el registro") }),
    });
  }
  return checks;
}

export async function diagnose(input: DoctorInput): Promise<Check[]> {
  const checks: Check[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const major = Number((input.nodeVersion ?? process.versions.node).split(".")[0]);
  checks.push(
    major >= 20
      ? { level: "ok", name: "Node.js", detail: t(`version ${input.nodeVersion ?? process.versions.node}`, `versión ${input.nodeVersion ?? process.versions.node}`) }
      : { level: "fail", name: "Node.js", detail: t(`version ${input.nodeVersion ?? process.versions.node} is too old`, `la versión ${input.nodeVersion ?? process.versions.node} es demasiado antigua`), fix: t("Install Node.js 20 or newer (node --version) and run the command again.", "Instala Node.js 20 o superior (node --version) y vuelve a ejecutar el comando.") },
  );

  let host = "";
  try {
    host = new URL(input.url).host;
  } catch {
    checks.push({ level: "fail", name: t("Colony address", "Dirección de la colonia"), detail: t(`"${input.url}" is not a web address`, `"${input.url}" no es una dirección web`), fix: t("Run the setup command again with --url http://<machine>:8080.", "Vuelve a ejecutar el comando de configuración con --url http://<machine>:8080.") });
    return checks;
  }
  const isPublic = PUBLIC_HOSTS.has(host);
  checks.push({
    level: isPublic ? "warn" : "ok",
    name: t("Colony", "Colonia"),
    detail: `${input.url}${isPublic ? t(" (the public colony)", " (la colonia pública)") : input.saved ? t(" (saved by init)", " (guardada por init)") : t(" (from MYRMO_URL)", " (de MYRMO_URL)")}`,
    fix: isPublic ? t("To use your team's colony, run the setup command you were sent (npx myrmo-mcp init --url ... --key ... --private).", "Para usar la colonia de tu equipo, ejecuta el comando de configuración que te enviaron (npx myrmo-mcp init --url ... --key ... --private).") : undefined,
  });
  if (isPublic) return checks;

  const ready = await call(fetchImpl, `${input.url.replace(/\/$/, "")}/readyz`);
  if ("error" in ready) {
    const refused = ready.error === "ECONNREFUSED";
    checks.push({
      level: "fail",
      name: t("Reaching the colony", "Llegar a la colonia"),
      detail: refused ? t("the machine answered but nothing listens on that port", "la máquina respondió pero nada escucha en ese puerto") : t(`no answer (${ready.error})`, `sin respuesta (${ready.error})`),
      fix: refused
        ? t("Ask whoever runs the colony whether it is up.", "Pregunta a quien gestiona la colonia si está en marcha.")
        : t("Check that you are on the team's network and that the address and port are right; from this machine try: curl ", "Comprueba que estás en la red del equipo y que la dirección y el puerto son correctos; desde esta máquina prueba: curl ") + input.url + "/readyz",
    });
    return checks;
  }
  if (ready.status === 403) {
    let said = "";
    try {
      said = JSON.parse(ready.body)?.error?.message ?? "";
    } catch {
      said = "";
    }
    const seen = /it sees you as ([0-9a-f]+(?:[.:][0-9a-f]+)+)/i.exec(said)?.[1];
    const dockerNetwork = !!seen && /^172\.(1[6-9]|2\d|3[01])\./.test(seen);
    checks.push({
      level: "fail",
      name: t("Reaching the colony", "Llegar a la colonia"),
      detail: t(`the colony refuses connections from this network (403)${seen ? `: it sees you as ${seen}` : ""}`, `la colonia rechaza las conexiones desde esta red (403)${seen ? `: te ve como ${seen}` : ""}`),
      fix: dockerNetwork
        ? t("You are probably on the colony's own machine: use its network address in the URL (not localhost or 127.0.0.1), and run the setup command again.", "Probablemente estás en la propia máquina de la colonia: usa su dirección de red en la URL (no localhost ni 127.0.0.1) y vuelve a ejecutar el comando de configuración.")
        : seen
          ? t(`Tell whoever runs the colony to allow ${seen}. If that is not your machine's address, a router between you and the colony is translating it, and that shared address is the one to allow.`, `Pide a quien gestiona la colonia que permita ${seen}. Si esa no es la dirección de tu máquina, un router entre tú y la colonia la está traduciendo, y es esa dirección compartida la que hay que permitir.`)
          : t("Your machine is not in the networks the colony allows. Tell whoever runs it your address.", "Tu máquina no está en las redes que permite la colonia. Dile tu dirección a quien la gestiona."),
    });
    return checks;
  }
  checks.push(
    ready.status === 200
      ? { level: "ok", name: t("Reaching the colony", "Llegar a la colonia"), detail: t("it answers and reports itself ready", "responde y dice que está lista") }
      : { level: "fail", name: t("Reaching the colony", "Llegar a la colonia"), detail: t(`it answered ${ready.status}`, `respondió ${ready.status}`), fix: t("It is up but not ready (it may still be starting). Try again in a minute, then tell whoever runs it.", "Está en marcha pero no lista (puede que aún esté arrancando). Inténtalo dentro de un minuto y, si sigue, díselo a quien la gestiona.") },
  );
  if (ready.status !== 200) return checks;

  const open = await call(fetchImpl, `${input.url.replace(/\/$/, "")}/v1/stats`, input.apiKey);
  if ("error" in open) {
    checks.push({ level: "fail", name: t("Your access key", "Tu clave de acceso"), detail: t(`no answer (${open.error})`, `sin respuesta (${open.error})`), fix: t("Try again; if it persists tell whoever runs the colony.", "Inténtalo otra vez; si sigue, díselo a quien gestiona la colonia.") });
  } else if (open.status === 401) {
    checks.push(
      input.apiKey
        ? { level: "fail", name: t("Your access key", "Tu clave de acceso"), detail: t("the colony does not accept it (401)", "la colonia no la acepta (401)"), fix: t("The key was copied wrong or has been revoked. Ask for a new one and run the setup command again.", "La clave se copió mal o se ha revocado. Pide una nueva y vuelve a ejecutar el comando de configuración.") }
        : { level: "fail", name: t("Your access key", "Tu clave de acceso"), detail: t("this colony needs a key and none is set", "esta colonia necesita una clave y no hay ninguna"), fix: t("Run the setup command you were sent: npx myrmo-mcp init --url <colony> --key <your key> --publish auto.", "Ejecuta el comando de configuración que te enviaron: npx myrmo-mcp init --url <colony> --key <your key> --publish auto.") },
    );
  } else if (open.status === 200) {
    checks.push(input.apiKey ? { level: "ok", name: t("Your access key", "Tu clave de acceso"), detail: t("accepted", "aceptada") } : { level: "warn", name: t("Your access key", "Tu clave de acceso"), detail: t("this colony does not ask for a key", "esta colonia no pide clave"), fix: t("If it should be private, tell whoever runs it.", "Si debería ser privada, díselo a quien la gestiona.") });
  } else {
    checks.push({ level: "fail", name: t("Your access key", "Tu clave de acceso"), detail: t(`the colony answered ${open.status}`, `la colonia respondió ${open.status}`), fix: t("Tell whoever runs the colony.", "Díselo a quien gestiona la colonia.") });
  }

  // A key travels in every request: on plain HTTP anyone on the network path can read it.
  try {
    const u = new URL(input.url);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
    if (u.protocol === "http:" && !local && input.apiKey) {
      checks.push({ level: "warn", name: t("Encryption", "Cifrado"), detail: t("plain HTTP: your key and what you share cross the network unencrypted", "HTTP sin cifrar: tu clave y lo que compartes cruzan la red sin cifrar"), fix: t("Fine on a network you trust; elsewhere ask whoever runs the colony to put TLS (HTTPS) in front of it.", "Vale en una red de confianza; en otro caso pide a quien gestiona la colonia que ponga TLS (HTTPS) delante.") });
    }
  } catch {
    /* the URL was checked above */
  }
  const declared = input.declared?.profile;
  checks.push(
    input.privateMode
      ? { level: "ok", name: t("Organisation colony", "Colonia de organización"), detail: t(`agents keep your internal names in what they publish${declared === "organisation" ? " (the colony declares itself your organisation's)" : ""}`, `los agentes conservan tus nombres internos en lo que publican${declared === "organisation" ? " (la colonia se declara de tu organización)" : ""}`) }
      : declared === "public"
        ? { level: "ok", name: t("Organisation colony", "Colonia de organización"), detail: t("off: the colony declares itself public, so internal names are removed", "desactivado: la colonia se declara pública, así que se quitan los nombres internos") }
        : { level: "warn", name: t("Organisation colony", "Colonia de organización"), detail: t("off: agents would strip internal names from what they publish", "desactivado: los agentes quitarían los nombres internos de lo que publican"), fix: declared === "organisation" ? t("Set your access key (npx myrmo-mcp init --url <colony> --key <your key>).", "Configura tu clave de acceso (npx myrmo-mcp init --url <colony> --key <your key>).") : t("This colony does not say what it is (an older server): run the setup command again with --private (or set MYRMO_PRIVATE=1).", "Esta colonia no dice qué es (un servidor más antiguo): vuelve a ejecutar el comando de configuración con --private (o define MYRMO_PRIVATE=1).") },
  );
  if (input.declared?.profile === "organisation") {
    checks.push({ level: "ok", name: t("What the colony keeps", "Lo que guarda la colonia"), detail: describeColony(input.declared) });
  }
  checks.push(
    input.publish === "auto"
      ? { level: "ok", name: t("Publishing", "Publicación"), detail: t("agents publish what they solve, to this colony only", "los agentes publican lo que resuelven, solo en esta colonia") }
      : input.publish === "ask"
        ? { level: "ok", name: t("Publishing", "Publicación"), detail: t("you approve each trail before it is sent", "apruebas cada rastro antes de enviarlo") }
        : { level: "warn", name: t("Publishing", "Publicación"), detail: t(`agents do not publish (${input.publish})`, `los agentes no publican (${input.publish})`), fix: t("npx myrmo-mcp config publish auto   (or ask, to approve each one)", "npx myrmo-mcp config publish auto   (o ask, para aprobar cada uno)") },
  );

  // Is this client the one the colony was released with? An older one misses what came after it.
  let offeredKit: string | undefined;
  const version = await call(fetchImpl, `${input.url.replace(/\/+$/, "")}/v1/version`, input.apiKey);
  if ("status" in version && version.status === 200) {
    let latest: string | undefined;
    try {
      const clients = (JSON.parse(version.body) as { clients?: { mcp?: string; kit?: string } }).clients;
      latest = clients?.mcp;
      offeredKit = typeof clients?.kit === "string" ? clients.kit.slice(0, 80) : undefined;
    } catch {
      latest = undefined;
    }
    if (latest && !VERSION_SHAPE.test(latest)) latest = undefined;
    if (latest && compareVersions(VERSION, latest) < 0) {
      checks.push({ level: "warn", name: t("Myrmo version", "Versión de Myrmo"), detail: t(`myrmo-mcp ${VERSION} here, ${latest} released with this colony`, `myrmo-mcp ${VERSION} aquí, ${latest} publicada con esta colonia`), fix: t("Claude Code: claude plugin update myrmo@myrmo (or /plugin > Marketplaces > myrmo > Enable auto-update). Other clients: npx myrmo-mcp@latest init with the same options as the first time.", "Claude Code: claude plugin update myrmo@myrmo (o /plugin > Marketplaces > myrmo > Enable auto-update). Otros clientes: npx myrmo-mcp@latest init con las mismas opciones que la primera vez.") });
    } else if (latest) {
      checks.push({ level: "ok", name: t("Myrmo version", "Versión de Myrmo"), detail: t(`myrmo-mcp ${VERSION}, up to date with this colony`, `myrmo-mcp ${VERSION}, al día con esta colonia`) });
    }
  }

  const kitLine = kitCheck(input.kit !== undefined ? input.kit : await findKit(input.env ?? process.env), offeredKit, input.privateMode);
  if (kitLine) checks.push(kitLine);

  const claude = claudeCodeSetUp(input.home);
  const gemini = join(input.home, ".gemini", "GEMINI.md");
  const geminiRules = existsSync(gemini) && readFileSync(gemini, "utf8").includes("myrmo:start");
  if (claude || geminiRules) {
    checks.push({ level: "ok", name: t("Agents", "Agentes"), detail: [claude ? `Claude Code: ${claude}` : "", geminiRules ? t("Gemini CLI / Antigravity: rules installed", "Gemini CLI / Antigravity: reglas instaladas") : ""].filter(Boolean).join("; ") });
  } else {
    checks.push({ level: "fail", name: t("Agents", "Agentes"), detail: t("no agent on this machine is set up to use Myrmo", "ningún agente de esta máquina está configurado para usar Myrmo"), fix: t("Run the setup command again, then restart Claude Code or Antigravity.", "Vuelve a ejecutar el comando de configuración y reinicia Claude Code o Antigravity.") });
  }
  const privacy = privacyCheck(input.home, input.env ?? process.env);
  if (privacy) checks.push(privacy);
  checks.push(...(await workLogChecks(input, fetchImpl)));
  checks.push({
    level: "ok",
    name: "Claude Desktop",
    detail: t("if you use it here, enable only one Myrmo integration there (the Plugin, for the public colony, or an Extension, for this one) — never both at once", "si lo usas aquí, activa allí una sola integración de Myrmo (el Plugin, para la colonia pública, o una Extension, para esta), nunca las dos a la vez"),
    fix: t("With both on, a tool call can be answered by the wrong one, silently: https://myrmo.dev/docs/reference/mcp#claude-desktop-when-the-colony-sits-behind-another-machine", "Con las dos activadas, una llamada a una herramienta puede responderla la equivocada, en silencio: https://myrmo.dev/docs/es/reference/mcp#claude-desktop-when-the-colony-sits-behind-another-machine"),
  });
  return checks;
}

export function render(checks: Check[]): string {
  const mark = { ok: "ok  ", warn: t("warn", "ojo "), fail: t("FAIL", "MAL ") };
  const lines = checks.flatMap((c) => [`[${mark[c.level]}] ${c.name}: ${c.detail}`, ...(c.fix ? [`       -> ${c.fix}`] : [])]);
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  lines.push("", failed ? t(`${failed} problem${failed > 1 ? "s" : ""} to fix, then run this again.`, `${failed} problema${failed > 1 ? "s" : ""} que arreglar; después vuelve a ejecutar esto.`) : warned ? t("Works, with things worth a look.", "Funciona, con cosas que conviene mirar.") : t("Everything is in place. Restart your agent if you have not since the setup.", "Todo está en orden. Reinicia tu agente si no lo has hecho desde la configuración."));
  return lines.join("\n");
}
