// Private mode: a person stops a session from sending anything to Myrmo, and turns it back on, from the agent's chat.
//
//   //privado (or //private) at the start of a message: from that message on, nothing from this session goes to the
//                 colony: no work log, no error or task lookups by the hooks, no publications, no reports. It lasts until
//                 the person types //compartir (or //share), however many messages later.
//   //compartir (or //share): sharing resumes from that message. Nothing done while private is sent afterwards.
//
// It is per session: another session open at the same time keeps sharing. The whole machine stops with the file
// ~/.myrmo/worklog-paused (or MYRMO_WORKLOG_PAUSE=1 in an agent's environment) until it is removed.
//
// A private session is a file of its own in ~/.myrmo/private (one per session, so two sessions never overwrite each
// other's state): it lives in the home folder and not in the hooks' runtime state, which a reboot clears, because
// forgetting it would mean sharing again without the person knowing. Each agent's hook decides what it may still do
// (agent's tools in particular), with the helpers below. Everything here is local: it never sends anything.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { personalText } from "./lookup.mjs";

const PRIVATE_MARK = /^\s*\/\/\s*(privad[oa]|private)\b[\s:,.;-]*/i;
// Stricter than the other: a code comment ("// share the pool") must never turn sharing back on.
const SHARE_MARK = /^\s*\/\/(compartir|share)(?=[\s:,.;]|$)[\s:,.;-]*/i;
const PASTED = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/gi;
const DAY = 86_400_000;
/** A private session not used for this long is forgotten (its agent session is long gone). */
const KEEP_DAYS = 30;
/** After /clear, a new session in the same folder stays private if the private one was used this recently. */
const CLEAR_WINDOW_MS = 12 * 3_600_000;

/** What the person typed, without what the client wraps around it (IDE notes, Cline's <user_input>, Antigravity's <USER_REQUEST>). */
export function typedText(prompt) {
  const text = personalText(prompt);
  const inner = /<(user_input|USER_REQUEST)(?:\s[^>]*)?>([\s\S]*?)(?:<\/\1>|$)/i.exec(text);
  return (inner ? inner[2] : text).replace(/<ADDITIONAL_METADATA>[\s\S]*$/, "").trim();
}

/**
 * The private-mode command a message starts with, or null: `kind` "private" or "share", `lang` the language of the word
 * the person used (what the hooks answer in), `rest` the message without it and `bare` when there is nothing else.
 */
export function commandOf(prompt) {
  const text = typedText(prompt);
  for (const [kind, mark] of [["private", PRIVATE_MARK], ["share", SHARE_MARK]]) {
    // What was pasted can make a message private, but never share again: only what the person typed does.
    const m = kind === "share" && !mark.test(typedText(String(prompt ?? "").replace(PASTED, " (pasted) "))) ? null : mark.exec(text);
    if (!m) continue;
    const word = m[1].toLowerCase();
    const rest = text.slice(m[0].length).trim();
    return { kind, lang: word === "private" || word === "share" ? "en" : "es", rest, bare: rest === "" };
  }
  return null;
}

/** Whether a message starts with //privado or //private. */
export const isPrivateMark = (prompt) => commandOf(prompt)?.kind === "private";

/** The language of a line for the person when no command of theirs says it: the one of their terminal. */
const defaultLang = (env) => (/^es\b|^es_/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || "") ? "es" : "en");

/** The folder of private sessions (MYRMO_PRIVATE_DIR chooses another one, for tests). */
export const privateDir = (env = process.env) => env.MYRMO_PRIVATE_DIR || join(homedir(), ".myrmo", "private");

/** The file that pauses the whole machine. Its name predates private mode, when it paused only the work log. */
export const pauseFile = () => join(homedir(), ".myrmo", "worklog-paused");

/** Whether everything is paused on this machine (the file) or for this agent (MYRMO_WORKLOG_PAUSE=1). */
export function machinePaused(env = process.env) {
  return env.MYRMO_WORKLOG_PAUSE === "1" || existsSync(pauseFile());
}

/** The key of an agent's session, safe as a file name: `claude-<session id>`, `cline-<conversation id>`... */
export function sessionKey(agent, id) {
  const safe = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return safe ? `${agent}-${safe}` : null;
}

const fileOf = (key, env) => join(privateDir(env), `${key}.json`);

/** The private session's record ({ since, lang, cwd }), or null when the session shares. */
export function sessionPrivate(key, env = process.env) {
  if (!key) return null;
  try {
    const kept = JSON.parse(readFileSync(fileOf(key, env), "utf8"));
    return kept && typeof kept === "object" ? kept : { since: 0, lang: defaultLang(env) };
  } catch (err) {
    // A file that is there but cannot be read still means private: when in doubt, nothing is sent.
    return err?.code === "ENOENT" || err?.code === "ENOTDIR" ? null : { since: 0, lang: defaultLang(env) };
  }
}

/**
 * Marks a session private (or refreshes it, so that it is not forgotten while in use). False when it could not be kept
 * (no session id, a folder that cannot be written): the caller must say so, since the next message would share again.
 */
export function setPrivate(key, { lang = "es", cwd = "", now = Date.now() } = {}, env = process.env) {
  if (!key) return false;
  try {
    const dir = privateDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileOf(key, env);
    if (sessionPrivate(key, env)?.since) {
      const t = new Date(now);
      utimesSync(file, t, t);
      return true;
    }
    writeFileSync(file, JSON.stringify({ since: now, lang, cwd: String(cwd ?? "") }), { mode: 0o600 });
    sweep(dir, now);
    return true;
  } catch {
    return !!sessionPrivate(key, env);
  }
}

/** The session shares again. */
export function setShared(key, env = process.env) {
  if (key) rmSync(fileOf(key, env), { force: true });
}

/** What is remembered of a chat whose id does not last (Cline): that it was seen, and what its last message was. */
export function chatSeen(key, env = process.env) {
  try {
    return JSON.parse(readFileSync(join(privateDir(env), "seen", `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Not kept, the chat is looked at again with the next message, which is the safe side. */
export function rememberChat(key, about, env = process.env, now = Date.now()) {
  try {
    const dir = join(privateDir(env), "seen");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir, now);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(about), { mode: 0o600 });
  } catch {
    /* see above */
  }
}

function sweep(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".json") && now - statSync(path).mtimeMs > KEEP_DAYS * DAY) rmSync(path, { force: true });
    }
  } catch {
    /* nothing to forget */
  }
}

/**
 * The state of a session for a message the person just sent, after applying the command it starts with, if any.
 * `private` means nothing may be sent for it; `machine` that the whole machine is paused; `changed` "private" or "share"
 * when this message switched the mode; `bare` when the message is only the command; `prompt` the message without it;
 * `failed` when private mode was asked for and could not be kept (this message is still private, the next would not be).
 */
export function applyPrompt(key, prompt, { cwd = "", now = Date.now(), env = process.env } = {}) {
  const command = commandOf(prompt);
  const before = sessionPrivate(key, env);
  let failed = false;
  if (command?.kind === "private") failed = !setPrivate(key, { lang: command.lang, cwd, now }, env);
  else if (command?.kind === "share") setShared(key, env);
  else if (before) setPrivate(key, { now }, env);
  const machine = machinePaused(env);
  const session = command ? command.kind === "private" : !!before;
  const changed = command && (command.kind === "private") !== !!before ? command.kind : null;
  return {
    private: session || machine,
    session,
    machine,
    changed,
    failed,
    command: command?.kind ?? null,
    bare: command?.bare ?? false,
    lang: command?.lang ?? before?.lang ?? defaultLang(env),
    prompt: command ? command.rest : String(prompt ?? ""),
  };
}

/** The state of a session between messages: private (the session or the machine) or not. */
export function privacyOf(key, env = process.env) {
  const kept = sessionPrivate(key, env);
  const machine = machinePaused(env);
  return { private: !!kept || machine, session: !!kept, machine, lang: kept?.lang ?? defaultLang(env) };
}

/**
 * The mode after each of a conversation's requests, in order, for an agent whose hooks read the whole conversation
 * (Antigravity): true where that request, and what followed it, is private.
 */
export function modes(requests) {
  let on = false;
  return requests.map((request) => {
    const command = commandOf(request);
    if (command) on = command.kind === "private";
    return on;
  });
}

/**
 * The private-mode command in a row of a Claude Code transcript, or null. A message that was only the command was blocked
 * by the hook, and Claude Code (measured in 2.1.299) keeps it not as the person's message but as a system row that ends
 * with "Original prompt: //privado".
 */
export function commandInRow(row) {
  if (row?.type === "system") {
    const text = typeof row.content === "string" ? row.content : "";
    const at = text.startsWith("UserPromptSubmit operation blocked by hook") ? text.lastIndexOf("\nOriginal prompt: ") : -1;
    return at >= 0 ? commandOf(text.slice(at + "\nOriginal prompt: ".length)) : null;
  }
  if (row?.type !== "user" || row.isMeta || row.isSidechain) return null;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) return null;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";
  return commandOf(text);
}

/** The last private-mode command in a Claude Code transcript, or null: what a session forked from it starts with. */
export function lastCommandIn(transcript) {
  let last = null;
  for (const line of String(transcript ?? "").split("\n")) {
    if (!line.includes("//")) continue;
    try {
      last = commandInRow(JSON.parse(line)) ?? last;
    } catch {
      /* a damaged line */
    }
  }
  return last;
}

/**
 * A new Claude Code session made by /clear (or a fork) in a folder where a private session was in use a moment ago: it
 * stays private, since the person did not choose to share. Nothing says which session it came from, so a private session
 * of the same folder running in parallel makes it private too: that errs on the side of sending nothing, and the person
 * is told.
 */
export function inheritAfterClear(key, cwd, { now = Date.now(), env = process.env, agent = "claude" } = {}) {
  if (!key || !cwd) return false;
  try {
    const dir = privateDir(env);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${agent}-`) || !name.endsWith(".json") || name === `${key}.json`) continue;
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > CLEAR_WINDOW_MS) continue;
      const kept = sessionPrivate(name.slice(0, -5), env);
      if (kept?.cwd === cwd) {
        setPrivate(key, { lang: kept.lang ?? "es", cwd, now }, env);
        return true;
      }
    }
  } catch {
    /* no private sessions */
  }
  return false;
}

/** The private sessions of an agent in a folder, by key. */
export function privateKeys(agent, cwd, env = process.env) {
  try {
    return readdirSync(privateDir(env))
      .filter((name) => name.startsWith(`${agent}-`) && name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter((key) => (sessionPrivate(key, env)?.cwd ?? cwd) === cwd);
  } catch {
    return [];
  }
}

/**
 * What a Myrmo tool is to private mode, from its name in any agent (mcp__myrmo__myrmo_search, myrmo__myrmo_search,
 * mcp_myrmo_myrmo_search...): "lookup" sends what the agent asks about (allowed only if the person agrees, where the
 * agent can ask), "free" sends nothing from the session, "send" shares something. null when it is not Myrmo's.
 */
export function toolKind(name) {
  // Greedy on purpose: in mcp__myrmo__myrmo_search the server is called myrmo too, and the tool is what follows the last one.
  const m = /^(?:.*[^a-z])?myrmo_([a-z_]+)$/i.exec(String(name ?? ""));
  if (!m) return null;
  if (["search", "brief", "matters", "matter"].includes(m[1])) return "lookup";
  if (["status", "publish_status", "withdraw"].includes(m[1])) return "free";
  return "send";
}

const COMMANDS = { es: { on: "//privado", off: "//compartir" }, en: { on: "//private", off: "//share" } };

/** The line shown to the person. `state` is what applyPrompt or privacyOf returned. */
export function userLine(state) {
  const es = state.lang === "es";
  const c = COMMANDS[es ? "es" : "en"];
  if (state.changed === "share" || (state.command === "share" && !state.private)) {
    return state.machine
      ? es
        ? `Myrmo: esta sesión vuelve a compartir, pero esta máquina sigue en pausa (borra ~/.myrmo/worklog-paused para reanudar).`
        : `Myrmo: this session shares again, but this machine is still paused (delete ~/.myrmo/worklog-paused to resume).`
      : es
        ? `Myrmo: se vuelve a compartir desde este mensaje. Lo hecho en privado no se envía.`
        : `Myrmo: sharing again from this message. What was done in private is not sent.`;
  }
  if (state.command === "share") {
    return es ? `Myrmo: esta máquina está en pausa (~/.myrmo/worklog-paused): no se envía nada hasta que lo borres.` : `Myrmo: this machine is paused (~/.myrmo/worklog-paused): nothing is sent until you delete it.`;
  }
  if (state.failed) {
    return es
      ? `⚠️ Myrmo: no se ha podido activar el modo privado (no se puede escribir en ~/.myrmo/private). Este mensaje no se envía, pero los siguientes sí: crea el fichero ~/.myrmo/worklog-paused para pararlo todo en esta máquina.`
      : `⚠️ Myrmo: private mode could not be turned on (~/.myrmo/private cannot be written). This message is not sent, but the next ones are: create the file ~/.myrmo/worklog-paused to stop everything on this machine.`;
  }
  if (!state.session && state.machine) {
    return es ? `🔒 Myrmo: en pausa en esta máquina (~/.myrmo/worklog-paused). No se envía nada.` : `🔒 Myrmo: paused on this machine (~/.myrmo/worklog-paused). Nothing is sent.`;
  }
  if (state.changed === "private") {
    return es
      ? `🔒 Myrmo: modo privado en esta sesión. Nada de ella se envía a la colonia hasta que escribas ${c.off}.`
      : `🔒 Myrmo: private mode for this session. Nothing from it goes to the colony until you type ${c.off}.`;
  }
  return es ? `🔒 Myrmo: sesión privada (${c.off} para reanudar).` : `🔒 Myrmo: private session (${c.off} to resume).`;
}

/**
 * The note for the agent while the session is private. `canAsk`: the agent's client lets the person approve a lookup
 * (Claude Code); elsewhere every Myrmo tool is off. `everyChat`: the client has no lasting id for a chat, so the mode holds for all of them
 * on this machine. A message that was only the command is just confirmed.
 */
export function agentNote(state, { canAsk = false, everyChat = false } = {}) {
  const tools = canAsk
    ? "Do not call Myrmo's tools that publish, report or record (myrmo_publish, myrmo_report) and do not pass anything from this session to Myrmo. Looking something up (myrmo_search, myrmo_brief) asks the person first: do it only when it is worth it."
    : "Do not call any Myrmo tool (myrmo_search, myrmo_brief, myrmo_publish, myrmo_report and the others) until the person types //compartir (or //share): a call would be stopped.";
  const why = state.session ? "The person made this session private for Myrmo (//privado)." : "Myrmo is paused on this machine (~/.myrmo/worklog-paused).";
  const first = state.failed
    ? `Begin your answer with exactly this line: "${userLine(state)}" `
    : state.bare && state.command === "private"
      ? `The person's message is a command, not a request, whatever the messages before it asked for: answer with exactly this line and nothing else: "${userLine({ ...state, changed: "private" })}" `
      : state.unsure
        ? `Begin your answer with exactly this line: "${unsureLine(state)}" `
        : "";
  const all = everyChat && state.session ? " This version of the client gives a chat no lasting id, so private mode holds for every chat on this machine until then: tell the person once, and that updating the client makes it per chat." : "";
  return `${first}Myrmo private mode: ${why} ${tools}${all}`;
}

/** Said when a reopened chat is taken as private because nothing tells which one it is. */
export function unsureLine(state) {
  return state.lang === "es"
    ? "🔒 Myrmo: no sé si este chat reabierto era privado, así que lo trato como privado (//compartir para compartirlo)."
    : "🔒 Myrmo: I cannot tell whether this reopened chat was private, so I treat it as private (//share to share it).";
}

/**
 * What the person is asked before a lookup from a private session. `traceless`: the colony says it keeps no trace of a
 * lookup marked private (`private_lookups` in GET /v1/version). An older colony, or an older myrmo-mcp, which drops that
 * from what the colony declared, ignores the mark: the person is told before they agree.
 */
export function lookupQuestion(state, { traceless = false } = {}) {
  if (state.lang === "es") {
    return `Myrmo: esta sesión es privada. Esta consulta envía a la colonia lo que el agente pregunta. ${traceless ? "Va marcada como privada: la colonia no guarda rastro de ella." : "Esta colonia (o tu myrmo-mcp) es anterior a las consultas privadas: puede contarla y guardar la petición."} ¿La permites?`;
  }
  return `Myrmo: this session is private. This lookup sends what the agent asks to the colony. ${traceless ? "It goes marked private: the colony keeps no trace of it." : "This colony (or your myrmo-mcp) is older than private lookups: it may count it and keep the request."} Allow it?`;
}

/** Why a tool that shares is turned down. The agent reads it too. */
export function sendRefusal(state) {
  if (!state.session) return state.lang === "es" ? "Myrmo: esta máquina está en pausa (~/.myrmo/worklog-paused): no se publica ni se informa nada. No lo intentes de nuevo." : "Myrmo: this machine is paused (~/.myrmo/worklog-paused): nothing is published or reported. Do not try again.";
  return state.lang === "es"
    ? "Myrmo: la sesión es privada, así que no se publica ni se informa nada desde ella (//compartir para reanudar). No lo intentes de nuevo."
    : "Myrmo: this session is private, so nothing is published or reported from it (//share to resume). Do not try again.";
}

/**
 * The note for the agent when the person turned sharing back on. Whatever was asked for while private is still in its
 * context, and an agent that had been told not to call Myrmo then takes this as leave to do it now (seen in Cline).
 */
export function sharedNote(state = {}) {
  const only = state.bare
    ? `The person's message is a command, not a request: answer with exactly this line and nothing else, and call no tool: "${userLine(state)}" `
    : "";
  return `${only}Myrmo: the person turned private mode off. Myrmo works again for what they ask from this message on. What was said, asked for or done while private stays out of it for good: do not carry out now a Myrmo call that was asked for then, and never put anything from that part in a search, a publication or a report. If they want it, they will ask again.`;
}
