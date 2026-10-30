// `npx myrmo-mcp init` in a terminal, with no options: a few questions answered with the arrow keys and Enter, instead
// of flags to look up. Only in an interactive terminal: in a script, in CI or with any option, init runs as before.
//
// The key handling is pure (a state and a key in, a state out) so it is tested without a terminal; `terminal()` is the
// thin part that reads keys and draws.

import { emitKeypressEvents } from "node:readline";
import type { PublishMode } from "myrmo";

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
  ask.say("Myrmo: a memory your coding agents share. A few questions (arrows and Enter; Ctrl+C to leave without changes).\n");

  const where = await ask.select<"public" | "org">(
    "Where should your agents look things up and share what they solve?",
    [
      { value: "public", label: "The public colony (myrmo.dev)", hint: "errors anyone can hit, shared with every agent; what is published is public" },
      { value: "org", label: "My organisation's private colony", hint: "you were given its address and an access key" },
    ],
    ctx.savedUrl && !/myrmo\.dev/.test(ctx.savedUrl) ? 1 : 0,
  );

  let url: string | undefined;
  let key: string | undefined;
  if (where === "org") {
    for (;;) {
      url = (
        await ask.text("Colony address (for example http://10.20.0.17:8080):", {
          initial: ctx.savedUrl && !/myrmo\.dev/.test(ctx.savedUrl) ? ctx.savedUrl : "",
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? (/\/\/(www\.)?myrmo\.dev(\/|$)/.test(v) ? "That is the public colony: choose it in the first question instead." : null) : "An address starting with http:// or https://"),
        })
      ).trim().replace(/\/+$/, "");
      const how = await ask.select<"paste" | "file">("Your access key:", [
        { value: "file", label: "Read it from a file", hint: "the invitation saved as a file works: the key stays out of your shell history" },
        { value: "paste", label: "Paste it", hint: "it is not shown while you type" },
      ]);
      if (how === "paste") {
        key = (await ask.text("Access key:", { secret: true, validate: (v) => (KEY_SHAPE.test(v.trim()) ? null : "That does not look like a key (myk_ and 64 characters).") })).trim();
      } else {
        for (;;) {
          const path = (await ask.text("Path of the file with the key:", { validate: (v) => (v.trim() ? null : "A path, please.") })).trim();
          const found = ctx.readKeyFile(path);
          if (found) {
            key = found;
            break;
          }
          ask.say("  No key found in that file (a key starts with myk_). Try another path.");
        }
      }
      ask.say("  Checking the colony...");
      const seen = await ctx.probe(url, key);
      if (seen.ok) {
        const people = seen.people === "named" ? "it counts each person's activity by name" : seen.people === "aggregate" ? "it counts the team's activity as a whole, not per person" : "";
        const what = seen.profile === "organisation" ? "your organisation's colony" : seen.profile === "public" ? "a colony that says it is public" : "a colony (its server is older and does not say what it is; private mode is set from your key)";
        ask.say(`  ✓ Connected: ${what}${people ? `; ${people}` : ""}.`);
        break;
      }
      ask.say(`  ✗ ${seen.detail ?? "It did not answer."}`);
      const next = await ask.select<"retry" | "keep">("What now?", [
        { value: "retry", label: "Enter the address and key again" },
        { value: "keep", label: "Keep them anyway", hint: "for a colony that is not reachable from here right now" },
      ]);
      if (next === "keep") break;
    }
  }

  let clients: string[] = [];
  for (;;) {
    clients = await ask.multi(
      "Which agents should use it? (Space to change, a for all, Enter to go on)",
      ctx.clients.map((c) => ({ value: c.id, label: c.name, hint: c.found ? "found on this machine" : "not found", picked: c.found })),
    );
    if (clients.length) break;
    ask.say("  Choose at least one (Space marks it).");
  }

  const publish = await ask.select<PublishMode>(
    where === "org" ? "When your agents solve something the colony did not know:" : "When your agent solves an error nobody had published:",
    where === "org"
      ? [
          { value: "auto", label: "Share it with the team by itself", hint: "recommended for a team's colony: internal names are kept, credentials and personal data removed" },
          { value: "ask", label: "Ask me each time", hint: "you see exactly what would be sent" },
          { value: "off", label: "Never share, only look things up" },
        ]
      : [
          { value: "ask", label: "Ask me each time", hint: "recommended: you see exactly what would be published, and it is public" },
          { value: "auto", label: "Publish it by itself", hint: "names of people, companies and internal systems are removed first" },
          { value: "off", label: "Never publish, only look things up" },
        ],
  );

  const chosen = ctx.clients.filter((c) => clients.includes(c.id)).map((c) => c.name);
  ask.say("");
  ask.say(`  Colony:     ${where === "org" ? `${url} (your organisation's)` : "https://myrmo.dev (public)"}`);
  ask.say(`  Agents:     ${chosen.length ? chosen.join(", ") : "none"}`);
  ask.say(`  Publishing: ${publish === "auto" ? "by itself" : publish === "ask" ? "ask each time" : "never"}`);
  const go = await ask.select<boolean>("Set it up?", [
    { value: true, label: "Yes, set it up" },
    { value: false, label: "No, leave everything as it is" },
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
          stdout.write(dim("Nothing was changed.\n"));
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
          ? [`${accent("?")} ${bold(question)} ${accent(choices.filter((_, i) => st.picked[i]).map((c) => c.label).join(", ") || "none")}`]
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
        (st) => (st.done ? [`${accent("?")} ${bold(question)} ${accent(shown(st.value))}`] : [`${accent("?")} ${bold(question)} ${shown(st.value)}`, error ? paint("31", `  ${error}`) : dim("  Enter to confirm")]),
        (st) => {
          error = options.validate?.(st.value) ?? "";
          return !error;
        },
      );
      return s.value;
    },
  };
}
