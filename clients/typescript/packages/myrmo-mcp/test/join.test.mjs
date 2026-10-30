import { test } from "node:test";
import assert from "node:assert/strict";
import { exchange, handleFrom, parseInvitation } from "../dist/join.js";

const CODE = "myi_" + "ab".repeat(32);

test("an invitation link gives the colony and the invitation, which travels after '#'", () => {
  assert.deepEqual(parseInvitation(`https://cloud.myrmo.dev/c/0123456789abcdef0123456789abcdef/join#${CODE}`), {
    url: "https://cloud.myrmo.dev/c/0123456789abcdef0123456789abcdef",
    invite: CODE,
  });
  assert.deepEqual(parseInvitation(`http://192.168.1.10:8080/join#${CODE}`), { url: "http://192.168.1.10:8080", invite: CODE });
  assert.deepEqual(parseInvitation(` https://colony.example.org/join/#${CODE}\n`), { url: "https://colony.example.org", invite: CODE });
});

test("anything else is refused with a sentence for the person", () => {
  for (const bad of ["", "not a link", `ftp://x/join#${CODE}`, "https://cloud.myrmo.dev/c/x/join", "https://cloud.myrmo.dev/c/x/join#myk_" + "0".repeat(64)]) {
    assert.equal(typeof parseInvitation(bad), "string", bad);
  }
});

test("a handle comes from the user name when it can", () => {
  assert.equal(handleFrom("Ana García"), "ana-garcia");
  assert.equal(handleFrom("devbox"), "devbox");
  assert.equal(handleFrom("x"), null);
  assert.equal(handleFrom(undefined), null);
  assert.equal(handleFrom("María.José_2"), "maria.jose_2");
});

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const inv = { url: "https://cloud.example.org/c/abc", invite: CODE };

test("the invitation is exchanged for the person's key, and each refusal says what to do", async () => {
  assert.deepEqual(await exchange(inv, "ana", reply(201, { key: "myk_" + "1".repeat(64) })), { key: "myk_" + "1".repeat(64), name: "ana" });
  assert.match(await exchange(inv, "ana", reply(409, {})), /--name/);
  assert.match(await exchange(inv, "ana", reply(401, {})), /ask for a new one/);
  assert.match(await exchange(inv, "ana", reply(429, {})), /an hour/);
  assert.match(await exchange(inv, "Ana@x", reply(201, {})), /handle/);
  assert.match(await exchange(inv, "ana", async () => { throw new Error("down"); }), /no answer/);
});

test("the request carries the invitation in its body, never in the address", async () => {
  let seen;
  await exchange(inv, "ana", async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status: 500 });
  });
  assert.equal(seen.url, "https://cloud.example.org/c/abc/v1/join");
  assert.ok(!seen.url.includes(CODE));
  assert.equal(JSON.parse(seen.init.body).invite, CODE);
});
