// `npx myrmo-mcp init` in a terminal, with no options: a few questions answered with the arrow keys and Enter, instead
// of flags to look up. Only in an interactive terminal: in a script, in CI or with any option, init runs as before.
//
// The key handling is pure (a state and a key in, a state out) so it is tested without a terminal; `terminal()` is the
// thin part that reads keys and draws.

import { emitKeypressEvents } from "node:readline";
import type { PublishMode } from "myrmo";
import { t } from "./i18n.js";

export type Key = { name?: string; sequence?: string; ctrl?: boolean };

export type Choice<T> = { value: T; label: string; hint?: string };

// --- one choice ---------------------------------------------------------------------------------------------------------

export type SelectState = { index: number; count: number; done: boolean; cancelled: boolean };

export function selectKey(s: SelectState, key: Key): SelectState {
  if (key.ctrl && key.name === "c") return { ...s, cancelled: true };
  if (key.name === "up" || key.name === "k") return { ...s, index: (s.index - 1 + s.count) % s.count };
  if (key.name === "down" || key.name === "j" || key.name === "tab") return { ...s, index: (s.index + 1) % s.count };
  if (key.name === "return" || key.name === "enter") return { ...s, done: true };
  const n = Number(key.sequence);
  if (Number.isInteger(n) && n >= 1 && n <= s.count) return { ...s, index: n - 1 };
  return s;
}

// --- several choices ----------------------------------------------------------------------------------------------------

export type MultiState = { index: number; picked: boolean[]; done: boolean; cancelled: boolean };

export function multiKey(s: MultiState, key: Key): MultiState {
  const count = s.picked.length;
  if (key.ctrl && key.name === "c") return { ...s, cancelled: true };
  if (key.name === "up" || key.name === "k") return { ...s, index: (s.index - 1 + count) % count };
  if (key.name === "down" || key.name === "j" || key.name === "tab") return { ...s, index: (s.index + 1) % count };
  if (key.name === "space") return { ...s, picked: s.picked.map((p, i) => (i === s.index ? !p : p)) };
  if (key.sequence === "a") {
    const all = s.picked.every(Boolean);
    return { ...s, picked: s.picked.map(() => !all) };
  }
  if (key.name === "return" || key.name === "enter") return { ...s, done: true };
  return s;
}

// --- text ---------------------------------------------------------------------------------------------------------------

export type TextState = { value: string; done: boolean; cancelled: boolean };

export function textKey(s: TextState, key: Key): TextState {
  if (key.ctrl && key.name === "c") return { ...s, cancelled: true };
  if (key.name === "return" || key.name === "enter") return { ...s, done: true };
  if (key.name === "backspace") return { ...s, value: s.value.slice(0, -1) };
  if (key.ctrl && key.name === "u") return { ...s, value: "" };
  const ch = key.sequence ?? "";
  // Arrows, Home, Delete and the like arrive as escape sequences: they are not text.
  if (ch.startsWith("\x1b") || ["up", "down", "left", "right", "home", "end", "delete", "pageup", "pagedown", "insert", "escape"].includes(key.name ?? "")) return s;
  // A paste arrives as one sequence; control characters are dropped.
  const printable = [...ch].filter((c) => c >= " " && c !== "\x7f").join("");
  return printable && !key.ctrl ? { ...s, value: s.value + printable } : s;
}

// --- the questions ------------------------------------------------------------------------------------------------------

export interface Asker {
  select<T>(question: string, choices: Choice<T>[], initial?: number): Promise<T>;
  multi<T>(question: string, choices: (Choice<T> & { picked: boolean })[]): Promise<T[]>;
  text(question: string, options?: { secret?: boolean; initial?: string; validate?: (v: string) => string | null }): Promise<string>;
  say(line: string): void;
}

export interface WizardContext {
  /** Every client init can set up, with whether it was found on this machine. */
  clients: { id: string; name: string; found: boolean }[];
  /** The colony this machine already uses, if one was saved. */
  savedUrl?: string;
  /** Asks a colony what it is (GET /v1/version with the key), for the person to see before anything is written. */
  probe: (url: string, key?: string) => Promise<{ ok: boolean; status?: number; profile?: string; people?: string | null; detail?: string }>;
  /** The key from a file: the invitation message works, the key is found in it. */
  readKeyFile: (path: string) => string | null;
}

export type WizardResult =
  | { cancelled: true }
  | { cancelled: false; clients: string[]; url?: string; key?: string; publish: PublishMode; publicPublish?: PublishMode };

const KEY_SHAPE = /^[\x21-\x7e]{8,256}$/;

export async function wizard(ask: Asker, ctx: WizardContext): Promise<WizardResult> {
  ask.say(t("Myrmo: a memory your coding agents share. A few questions (arrows and Enter; Ctrl+C to leave without changes).\n", "Myrmo: una memoria que comparten tus agentes de programación. Unas pocas preguntas (flechas y Enter; Ctrl+C para salir sin cambios).\n"));

  const where = await ask.select<"public" | "org">(
    t("Where should your agents look things up and share what they solve?", "¿Dónde deben buscar tus agentes y compartir lo que resuelven?"),
    [
      { value: "public", label: t("The public colony (myrmo.dev)", "La colonia pública (myrmo.dev)"), hint: t("errors anyone can hit, shared with every agent; what is published is public", "errores que cualquiera puede encontrarse, compartidos con todos los agentes; lo publicado es público") },
      { value: "org", label: t("My organisation's private colony", "La colonia privada de mi organización"), hint: t("you were given its address and an access key", "te dieron su dirección y una clave de acceso") },
    ],
    ctx.savedUrl && !/myrmo\.dev/.test(ctx.savedUrl) ? 1 : 0,
  );

  let url: string | undefined;
  let key: string | undefined;
  if (where === "org") {
    for (;;) {
      url = (
        await ask.text(t("Colony address (for example http://10.20.0.17:8080):", "Dirección de la colonia (por ejemplo http://10.20.0.17:8080):"), {
          initial: ctx.savedUrl && !/myrmo\.dev/.test(ctx.savedUrl) ? ctx.savedUrl : "",
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? (/\/\/(www\.)?myrmo\.dev(\/|$)/.test(v) ? t("That is the public colony: choose it in the first question instead.", "Esa es la colonia pública: elígela en la primera pregunta.") : null) : t("An address starting with http:// or https://", "Una dirección que empiece por http:// o https://")),
        })
      ).trim().replace(/\/+$/, "");
      const how = await ask.select<"paste" | "file">(t("Your access key:", "Tu clave de acceso:"), [
        { value: "file", label: t("Read it from a file", "Leerla de un fichero"), hint: t("the invitation saved as a file works: the key stays out of your shell history", "vale la invitación guardada como fichero: la clave no queda en el historial de la shell") },
        { value: "paste", label: t("Paste it", "Pegarla"), hint: t("it is not shown while you type", "no se muestra mientras escribes") },
      ]);
      if (how === "paste") {
        key = (await ask.text(t("Access key:", "Clave de acceso:"), { secret: true, validate: (v) => (KEY_SHAPE.test(v.trim()) ? null : t("That does not look like a key (myk_ and 64 characters).", "Eso no parece una clave (myk_ y 64 caracteres).")) })).trim();
      } else {
        for (;;) {
          const path = (await ask.text(t("Path of the file with the key:", "Ruta del fichero con la clave:"), { validate: (v) => (v.trim() ? null : t("A path, please.", "Una ruta, por favor.")) })).trim();
          const found = ctx.readKeyFile(path);
          if (found) {
            key = found;
            break;
          }
          ask.say(t("  No key found in that file (a key starts with myk_). Try another path.", "  No hay ninguna clave en ese fichero (una clave empieza por myk_). Prueba con otra ruta."));
        }
      }
      ask.say(t("  Checking the colony...", "  Comprobando la colonia..."));
      const seen = await ctx.probe(url, key);
      if (seen.ok) {
        const people = seen.people === "named" ? t("it counts each person's activity by name", "cuenta la actividad de cada persona por su nombre") : seen.people === "aggregate" ? t("it counts the team's activity as a whole, not per person", "cuenta la actividad del equipo en conjunto, no por persona") : "";
        const what = seen.profile === "organisation" ? t("your organisation's colony", "la colonia de tu organización") : seen.profile === "public" ? t("a colony that says it is public", "una colonia que dice ser pública") : t("a colony (its server is older and does not say what it is; private mode is set from your key)", "una colonia (su servidor es más antiguo y no dice qué es; el modo privado se activa con tu clave)");
        ask.say(t(`  ✓ Connected: ${what}${people ? `; ${people}` : ""}.`, `  ✓ Conectado: ${what}${people ? `; ${people}` : ""}.`));
        break;
      }
      ask.say(`  ✗ ${seen.detail ?? t("It did not answer.", "No respondió.")}`);
      const next = await ask.select<"retry" | "keep">(t("What now?", "¿Y ahora?"), [
        { value: "retry", label: t("Enter the address and key again", "Introducir otra vez la dirección y la clave") },
        { value: "keep", label: t("Keep them anyway", "Conservarlas igualmente"), hint: t("for a colony that is not reachable from here right now", "para una colonia a la que ahora mismo no se llega desde aquí") },
      ]);
      if (next === "keep") break;
    }
  }

  let clients: string[] = [];
  for (;;) {
    clients = await ask.multi(
      t("Which agents should use it? (Space to change, a for all, Enter to go on)", "¿Qué agentes deben usarla? (Espacio para cambiar, a para todos, Enter para seguir)"),
      ctx.clients.map((c) => ({ value: c.id, label: c.name, hint: c.found ? t("found on this machine", "encontrado en esta máquina") : t("not found", "no encontrado"), picked: c.found })),
    );
    if (clients.length) break;
    ask.say(t("  Choose at least one (Space marks it).", "  Elige al menos uno (Espacio lo marca)."));
  }

  const publish = await ask.select<PublishMode>(
    where === "org" ? t("When your agents solve something the colony did not know:", "Cuando tus agentes resuelvan algo que la colonia no sabía:") : t("When your agent solves an error nobody had published:", "Cuando tu agente resuelva un error que nadie había publicado:"),
    where === "org"
      ? [
          { value: "auto", label: t("Share it with the team by itself", "Compartirlo con el equipo por su cuenta"), hint: t("recommended for a team's colony: internal names are kept, credentials and personal data removed", "recomendado para la colonia de un equipo: se conservan los nombres internos y se quitan las credenciales y los datos personales") },
          { value: "ask", label: t("Ask me each time", "Preguntarme cada vez"), hint: t("you see exactly what would be sent", "ves exactamente lo que se enviaría") },
          { value: "off", label: t("Never share, only look things up", "No compartir nunca, solo buscar") },
        ]
      : [
          { value: "ask", label: t("Ask me each time", "Preguntarme cada vez"), hint: t("recommended: you see exactly what would be published, and it is public", "recomendado: ves exactamente lo que se publicaría, y es público") },
          { value: "auto", label: t("Publish it by itself", "Publicarlo por su cuenta"), hint: t("names of people, companies and internal systems are removed first", "antes se quitan los nombres de personas, empresas y sistemas internos") },
          { value: "off", label: t("Never publish, only look things up", "No publicar nunca, solo buscar") },
        ],
  );

  const chosen = ctx.clients.filter((c) => clients.includes(c.id)).map((c) => c.name);
  ask.say("");
  ask.say(t(`  Colony:     ${where === "org" ? `${url} (your organisation's)` : "https://myrmo.dev (public)"}`, `  Colonia:    ${where === "org" ? `${url} (de tu organización)` : "https://myrmo.dev (pública)"}`));
  ask.say(t(`  Agents:     ${chosen.length ? chosen.join(", ") : "none"}`, `  Agentes:    ${chosen.length ? chosen.join(", ") : "ninguno"}`));
  ask.say(t(`  Publishing: ${publish === "auto" ? "by itself" : publish === "ask" ? "ask each time" : "never"}`, `  Publicar:   ${publish === "auto" ? "por su cuenta" : publish === "ask" ? "preguntar cada vez" : "nunca"}`));
  const go = await ask.select<boolean>(t("Set it up?", "¿Lo configuro?"), [
    { value: true, label: t("Yes, set it up", "Sí, configúralo") },
    { value: false, label: t("No, leave everything as it is", "No, deja todo como está") },
  ]);
  if (!go) return { cancelled: true };
  if (where === "org") return { cancelled: false, clients, url, key, publish };
  return { cancelled: false, clients, publish, publicPublish: publish };
}

// --- the terminal -------------------------------------------------------------------------------------------------------

/** Whether init may ask: a real terminal on both ends, not CI, and colours allowed or not. */
export function canAsk(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout, env = process.env): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && !env.CI && env.MYRMO_NO_INPUT !== "1";
}

export class Cancelled extends Error {}

export function terminal(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout, env = process.env): Asker {
  const color = !env.NO_COLOR;
  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const dim = (t: string) => paint("2", t);
  const accent = (t: string) => paint("36", t);
  const bold = (t: string) => paint("1", t);
  emitKeypressEvents(stdin);

  /** Draws `lines`, replacing what the previous draw of the same prompt wrote. */
  const drawer = () => {
    let previous = 0;
    return (lines: string[]) => {
      if (previous) stdout.write(`\x1b[${previous}A\r\x1b[0J`);
      stdout.write(lines.join("\n") + "\n");
      previous = lines.length;
    };
  };

  function run<S extends { done: boolean; cancelled: boolean }>(initial: S, reduce: (s: S, k: Key) => S, render: (s: S) => string[], accept: (s: S) => boolean = () => true): Promise<S> {
    const draw = drawer();
    let state = initial;
    draw(render(state));
    return new Promise((resolve, reject) => {
      const onKey = (_: string, key: Key) => {
        let next = reduce(state, key ?? {});
        if (next.done && !accept(next)) next = { ...next, done: false };
        state = next;
        if (state.cancelled) {
          finish();
          stdout.write(dim(t("Nothing was changed.\n", "No se ha cambiado nada.\n")));
          return reject(new Cancelled());
        }
        draw(render(state));
        if (state.done) {
          finish();
          resolve(state);
        }
      };
      const finish = () => {
        stdin.off("keypress", onKey);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
      };
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("keypress", onKey);
    });
  }

  return {
    say: (line) => stdout.write(line + "\n"),
    async select<T>(question: string, choices: Choice<T>[], initial = 0) {
      const s = await run<SelectState>({ index: initial, count: choices.length, done: false, cancelled: false }, selectKey, (st) =>
        st.done
          ? [`${accent("?")} ${bold(question)} ${accent(choices[st.index].label)}`]
          : [`${accent("?")} ${bold(question)}`, ...choices.map((c, i) => `${i === st.index ? accent("❯") : " "} ${i === st.index ? accent(c.label) : c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`)],
      );
      return choices[s.index].value;
    },
    async multi<T>(question: string, choices: (Choice<T> & { picked: boolean })[]) {
      const s = await run<MultiState>({ index: 0, picked: choices.map((c) => c.picked), done: false, cancelled: false }, multiKey, (st) =>
        st.done
          ? [`${accent("?")} ${bold(question)} ${accent(choices.filter((_, i) => st.picked[i]).map((c) => c.label).join(", ") || t("none", "ninguno"))}`]
          : [`${accent("?")} ${bold(question)}`, ...choices.map((c, i) => `${i === st.index ? accent("❯") : " "} ${st.picked[i] ? accent("◉") : "◯"} ${c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`)],
      );
      return choices.filter((_, i) => s.picked[i]).map((c) => c.value);
    },
    async text(question, options = {}) {
      let error = "";
      const shown = (v: string) => (options.secret ? "•".repeat(Math.min(v.length, 40)) : v);
      const s = await run<TextState>(
        { value: options.initial ?? "", done: false, cancelled: false },
        textKey,
        (st) => (st.done ? [`${accent("?")} ${bold(question)} ${accent(shown(st.value))}`] : [`${accent("?")} ${bold(question)} ${shown(st.value)}`, error ? paint("31", `  ${error}`) : dim(t("  Enter to confirm", "  Enter para confirmar"))]),
        (st) => {
          error = options.validate?.(st.value) ?? "";
          return !error;
        },
      );
      return s.value;
    },
  };
}
