// `npx myrmo-mcp init` in a terminal asks with arrows and Enter: the keys, and the questions in order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canAsk, multiKey, selectKey, textKey, wizard } from "../dist/wizard.js";

const keys = (reduce, state, ...names) => names.reduce((s, k) => reduce(s, typeof k === "string" ? { name: k, sequence: k } : k), state);

test("one choice: arrows wrap around, a number jumps, Enter accepts, Ctrl+C leaves", () => {
  const s0 = { index: 0, count: 3, done: false, cancelled: false };
  assert.equal(keys(selectKey, s0, "up").index, 2);
  assert.equal(keys(selectKey, s0, "down", "down", "down").index, 0);
  assert.equal(selectKey(s0, { sequence: "2" }).index, 1);
  assert.equal(keys(selectKey, s0, "down", "return").done, true);
  assert.equal(selectKey(s0, { name: "c", ctrl: true }).cancelled, true);
});

test("several choices: Space toggles, a toggles all, Enter accepts", () => {
  const s0 = { index: 0, picked: [true, false, false], done: false, cancelled: false };
  assert.deepEqual(keys(multiKey, s0, "down", "space").picked, [true, true, false]);
  assert.deepEqual(multiKey(s0, { sequence: "a" }).picked, [true, true, true]);
  assert.deepEqual(multiKey({ ...s0, picked: [true, true, true] }, { sequence: "a" }).picked, [false, false, false]);
  assert.equal(keys(multiKey, s0, "return").done, true);
});

test("text: typing, a paste, backspace; control characters are not typed", () => {
  const s0 = { value: "", done: false, cancelled: false };
  let s = textKey(s0, { sequence: "http://10.20.0.17:8080" });
  s = textKey(s, { name: "backspace" });
  assert.equal(s.value, "http://10.20.0.17:808");
  assert.equal(textKey(s, { sequence: "\x1b[A", name: "up" }).value, s.value);
  assert.equal(textKey(s, { name: "u", ctrl: true }).value, "");
  assert.equal(textKey(s, { name: "return" }).done, true);
});

test("init asks only in a real terminal, never in CI or when told not to", () => {
  const tty = { isTTY: true };
  assert.equal(canAsk(tty, tty, {}), true);
  assert.equal(canAsk(tty, tty, { CI: "true" }), false);
  assert.equal(canAsk(tty, tty, { MYRMO_NO_INPUT: "1" }), false);
  assert.equal(canAsk({ isTTY: false }, tty, {}), false);
});

/** An asker that answers from a script and records what it was asked. */
function scripted(answers) {
  const asked = [];
  const said = [];
  return {
    asked,
    said,
    asker: {
      say: (l) => said.push(l),
      async select(q, choices) {
        asked.push(q);
        const want = answers.shift();
        const c = choices.find((x) => x.value === want);
        assert.ok(c, `"${q}" has no choice ${JSON.stringify(want)}: ${choices.map((x) => x.value)}`);
        return c.value;
      },
      async multi(q, choices) {
        asked.push(q);
        const want = answers.shift();
        return want === "found" ? choices.filter((c) => c.picked).map((c) => c.value) : want;
      },
      async text(q, opts = {}) {
        asked.push(q);
        const v = answers.shift();
        assert.equal(opts.validate?.(v) ?? null, null, `${q} refused ${v}`);
        return v;
      },
    },
  };
}

const clients = [
  { id: "claude-code", name: "Claude Code", found: true },
  { id: "cursor", name: "Cursor", found: false },
  { id: "antigravity", name: "Antigravity", found: true },
];

test("the public colony: agents found are preselected, publishing asks by default", async () => {
  const { asker, asked } = scripted(["public", "found", "ask", true]);
  const r = await wizard(asker, { clients, probe: async () => ({ ok: true }), readKeyFile: () => null });
  assert.deepEqual(r, { cancelled: false, clients: ["claude-code", "antigravity"], publish: "ask", publicPublish: "ask" });
  assert.equal(asked.length, 4);
});

test("an organisation's colony: address, key from the invitation file, a check, then the rest", async () => {
  const key = "myk_" + "ab".repeat(32);
  const probes = [];
  const { asker, said } = scripted(["org", "http://10.20.0.17:8080/", "file", "~/invitation.txt", ["claude-code"], "auto", true]);
  const r = await wizard(asker, {
    clients,
    probe: async (url, k) => (probes.push([url, k]), { ok: true, profile: "organisation", people: "aggregate" }),
    readKeyFile: (p) => (p === "~/invitation.txt" ? key : null),
  });
  assert.deepEqual(r, { cancelled: false, clients: ["claude-code"], url: "http://10.20.0.17:8080", key, publish: "auto" });
  assert.deepEqual(probes, [["http://10.20.0.17:8080", key]]);
  assert.ok(said.some((l) => /Connected: your organisation's colony; it counts the team's activity as a whole/.test(l)));
});

test("a wrong key is said before anything is written, and can be entered again", async () => {
  const good = "myk_" + "cd".repeat(32);
  let calls = 0;
  const { asker, said } = scripted(["org", "http://10.20.0.17:8080", "paste", "myk_" + "00".repeat(32), "retry", "http://10.20.0.17:8080", "paste", good, ["cursor"], "ask", true]);
  const r = await wizard(asker, { clients, probe: async (_, k) => (calls++, k === good ? { ok: true, profile: "organisation" } : { ok: false, detail: "The colony does not accept this key." }), readKeyFile: () => null });
  assert.equal(r.key, good);
  assert.equal(calls, 2);
  assert.ok(said.some((l) => /does not accept this key/.test(l)));
});

test("the public colony's address is refused as a private colony, and No changes nothing", async () => {
  const { asker } = scripted(["org"]);
  const v = await new Promise((resolve) => {
    // Capture the check, then leave the wizard waiting for an answer that never comes.
    asker.text = (q, opts) => (resolve(opts.validate("https://myrmo.dev")), new Promise(() => {}));
    wizard(asker, { clients, probe: async () => ({ ok: true }), readKeyFile: () => null });
  });
  assert.match(v, /public colony/);
  const no = scripted(["public", "found", "off", false]);
  assert.deepEqual(await wizard(no.asker, { clients, probe: async () => ({ ok: true }), readKeyFile: () => null }), { cancelled: true });
});
