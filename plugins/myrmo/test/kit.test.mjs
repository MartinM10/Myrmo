import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentKit, installKit, loadKit, verifyBundle } from "../scripts/kit.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEYS = [publicKey.export({ type: "spki", format: "pem" })];
const other = generateKeyPairSync("ed25519").privateKey;

function make(files, version = "0.27.0-abcdef1234", key = privateKey) {
  const bytes = Buffer.from(JSON.stringify({ format: "myrmo-kit/1", version, files }));
  const manifest = { format: "myrmo-kit/1", version, sha256: createHash("sha256").update(bytes).digest("hex"), signature: sign(null, bytes, key).toString("base64"), url: `/v1/kit/${version}.json` };
  return { bytes, manifest };
}

const colony = ({ bytes, manifest }, status = 200) => async (url) => {
  if (status !== 200) return { ok: false, status };
  if (url.endsWith("/v1/kit")) return { ok: true, status: 200, json: async () => manifest };
  if (url.endsWith(`/v1/kit/${manifest.version}.json`)) return { ok: true, status: 200, arrayBuffer: async () => bytes };
  return { ok: false, status: 404 };
};

test("a kit is accepted only when the hash and a pinned key's signature match", () => {
  const k = make({ "a.mjs": "export const a = 1;" });
  assert.deepEqual(verifyBundle(k.bytes, k.manifest, KEYS), [["a.mjs", "export const a = 1;"]]);
  assert.throws(() => verifyBundle(Buffer.from(k.bytes.toString().replace("1", "2")), k.manifest, KEYS), /hash/);
  const forged = make({ "a.mjs": "evil" }, undefined, other);
  assert.throws(() => verifyBundle(forged.bytes, forged.manifest, KEYS), /not signed/);
  const sneaky = make({ "../x.mjs": "evil" });
  assert.throws(() => verifyBundle(sneaky.bytes, sneaky.manifest, KEYS), /should not/);
});

test("installs, says when it is current, and a colony without a kit is not an error", async () => {
  const env = { MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "kit-")) };
  const k = make({ "hello.mjs": "export const hello = () => 'hi';" });
  assert.deepEqual(await installKit({ url: "http://c/", env, fetcher: colony(k), keys: KEYS }), { state: "installed", version: "0.27.0-abcdef1234" });
  assert.equal(currentKit(env).version, "0.27.0-abcdef1234");
  assert.equal((await loadKit("hello.mjs", env)).hello(), "hi");
  assert.equal(await loadKit("missing.mjs", env), null);
  assert.equal((await installKit({ url: "http://c", env, fetcher: colony(k), keys: KEYS })).state, "current");
  assert.equal((await installKit({ url: "http://c", env, fetcher: colony(k, 404), keys: KEYS })).state, "none");
  const newer = make({ "hello.mjs": "export const hello = () => 'hello';" }, "0.27.1-0123456789");
  await installKit({ url: "http://c", env, fetcher: colony(newer), keys: KEYS });
  assert.equal(currentKit(env).version, "0.27.1-0123456789");
  assert.ok(existsSync(join(env.MYRMO_HOOK_STATE_DIR, "kit", "0.27.0-abcdef1234")), "the previous kit stays for a while");
});

test("a forged kit is refused and leaves the installed one in place", async () => {
  const env = { MYRMO_HOOK_STATE_DIR: mkdtempSync(join(tmpdir(), "kit-")) };
  await installKit({ url: "http://c", env, fetcher: colony(make({ "a.mjs": "" })), keys: KEYS });
  const forged = make({ "a.mjs": "evil" }, "0.28.0-ffffffffff", other);
  await assert.rejects(installKit({ url: "http://c", env, fetcher: colony(forged), keys: KEYS }), /not signed/);
  assert.equal(currentKit(env).version, "0.27.0-abcdef1234");
});

test("MYRMO_KIT_DEV uses a folder as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitdev-"));
  writeFileSync(join(dir, "x.mjs"), "export const x = 7;");
  const env = { MYRMO_KIT_DEV: dir };
  assert.equal(currentKit(env).dev, true);
  assert.equal((await loadKit("x.mjs", env)).x, 7);
  assert.equal((await installKit({ url: "http://c", env, fetcher: () => assert.fail("no request") })).version, "dev");
  assert.equal(readFileSync(join(dir, "x.mjs"), "utf8"), "export const x = 7;");
});
