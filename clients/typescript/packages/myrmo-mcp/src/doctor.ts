// `myrmo-mcp doctor`: is this machine set up to use the colony, and if not, what to do. For the person, not the agent.
// Every check says what it found and, when it fails, the one thing to try. Nothing is changed and no text of any
// trail is read: it asks the colony whether it is up, whether it lets this network in and whether this key opens it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeSetUp } from "./init.js";
import { compareVersions, describeColony, VERSION, VERSION_SHAPE } from "./server.js";
import { t } from "./i18n.js";

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
  declared?: { profile?: string; people_detail?: string | null; holdout_percent?: number; effort?: boolean };
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
      ? { level: "ok", name: t("Private mode", "Modo privado"), detail: t(`agents keep your internal names in what they publish${declared === "organisation" ? " (the colony declares itself your organisation's)" : ""}`, `los agentes conservan tus nombres internos en lo que publican${declared === "organisation" ? " (la colonia se declara de tu organización)" : ""}`) }
      : declared === "public"
        ? { level: "ok", name: t("Private mode", "Modo privado"), detail: t("off: the colony declares itself public, so internal names are removed", "desactivado: la colonia se declara pública, así que se quitan los nombres internos") }
        : { level: "warn", name: t("Private mode", "Modo privado"), detail: t("off: agents would strip internal names from what they publish", "desactivado: los agentes quitarían los nombres internos de lo que publican"), fix: declared === "organisation" ? t("Set your access key (npx myrmo-mcp init --url <colony> --key <your key>).", "Configura tu clave de acceso (npx myrmo-mcp init --url <colony> --key <your key>).") : t("This colony does not say what it is (an older server): run the setup command again with --private (or set MYRMO_PRIVATE=1).", "Esta colonia no dice qué es (un servidor más antiguo): vuelve a ejecutar el comando de configuración con --private (o define MYRMO_PRIVATE=1).") },
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
  const version = await call(fetchImpl, `${input.url.replace(/\/+$/, "")}/v1/version`, input.apiKey);
  if ("status" in version && version.status === 200) {
    let latest: string | undefined;
    try {
      latest = (JSON.parse(version.body) as { clients?: { mcp?: string } }).clients?.mcp;
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

  const claude = claudeCodeSetUp(input.home);
  const gemini = join(input.home, ".gemini", "GEMINI.md");
  const geminiRules = existsSync(gemini) && readFileSync(gemini, "utf8").includes("myrmo:start");
  if (claude || geminiRules) {
    checks.push({ level: "ok", name: t("Agents", "Agentes"), detail: [claude ? `Claude Code: ${claude}` : "", geminiRules ? t("Gemini CLI / Antigravity: rules installed", "Gemini CLI / Antigravity: reglas instaladas") : ""].filter(Boolean).join("; ") });
  } else {
    checks.push({ level: "fail", name: t("Agents", "Agentes"), detail: t("no agent on this machine is set up to use Myrmo", "ningún agente de esta máquina está configurado para usar Myrmo"), fix: t("Run the setup command again, then restart Claude Code or Antigravity.", "Vuelve a ejecutar el comando de configuración y reinicia Claude Code o Antigravity.") });
  }
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
