// The colony kit: client code that an organisation's colony serves to its members (what only a private colony offers),
// installed under ~/.myrmo/kit/<version>/ and loaded from there. It is installed only when its signature verifies
// against a key pinned below: a colony may be reached over plain HTTP inside a company network, and this code runs with
// the person's own permissions.
//
//   GET <colony>/v1/kit                 {format, version, sha256, signature, url}
//   GET <colony>/v1/kit/<version>.json  the bundle {"format":"myrmo-kit/1","version","files":{name: text}}
//
// MYRMO_KIT_DEV=<folder> uses that folder instead, unsigned, for developing the kit; doctor says so.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The keys a kit must be signed with (kit/public-key.pem in the project). A rotation lists both for a while. */
export const KIT_PUBLIC_KEYS = [
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3VgKjIlOum3XojZiKfVvxqJZkSxdXsKIxgGs+HaBv8A=\n-----END PUBLIC KEY-----\n",
];

const NAME = /^[a-z0-9][a-z0-9-]*\.(mjs|json|md)$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}-[0-9a-f]{6,64}$/;

export const kitRoot = (env = process.env) => join(env.MYRMO_HOOK_STATE_DIR || join(env.HOME || homedir(), ".myrmo"), "kit");

/** The kit in use: {version, dir, dev} or null. */
export function currentKit(env = process.env) {
  if (env.MYRMO_KIT_DEV) return existsSync(env.MYRMO_KIT_DEV) ? { version: "dev", dir: env.MYRMO_KIT_DEV, dev: true } : null;
  try {
    const cur = JSON.parse(readFileSync(join(kitRoot(env), "current.json"), "utf8"));
    if (!VERSION.test(String(cur?.version))) return null;
    const dir = join(kitRoot(env), cur.version);
    return existsSync(dir) ? { version: cur.version, dir, dev: false } : null;
  } catch {
    return null;
  }
}

/** The bundle's files, if these bytes are what the manifest says and a pinned key signed them; otherwise it throws. */
export function verifyBundle(bytes, manifest, keys = KIT_PUBLIC_KEYS) {
  if (manifest?.format !== "myrmo-kit/1" || !VERSION.test(String(manifest?.version))) throw new Error("not a kit manifest");
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("the kit does not match its hash");
  const sig = Buffer.from(String(manifest.signature ?? ""), "base64");
  if (!keys.some((k) => { try { return verify(null, bytes, createPublicKey(k), sig); } catch { return false; } })) {
    throw new Error("the kit is not signed by this project's key");
  }
  const bundle = JSON.parse(bytes.toString("utf8"));
  if (bundle.format !== "myrmo-kit/1" || bundle.version !== manifest.version) throw new Error("the kit is not the version announced");
  const files = Object.entries(bundle.files ?? {});
  if (!files.length || files.some(([n, t]) => !NAME.test(n) || typeof t !== "string")) throw new Error("the kit holds a file it should not");
  return files;
}

/**
 * Installs the colony's kit when it is newer than the one in use. Returns {state: "installed"|"current"|"none", version}.
 * "none": the colony serves no kit (the public colony, an older server). Throws when a kit was offered but is not valid.
 */
export async function installKit({ url, apiKey, env = process.env, fetcher = fetch, timeoutMs = 8000, keys = KIT_PUBLIC_KEYS, headers = {} }) {
  if (env.MYRMO_KIT_DEV) return { state: "current", version: "dev" };
  const h = { accept: "application/json", ...headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const base = String(url).replace(/\/+$/, "");
  const res = await fetcher(`${base}/v1/kit`, { headers: h, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404 || res.status === 401 || res.status === 403) return { state: "none" };
  if (!res.ok) throw new Error(`the colony answered ${res.status} for its kit`);
  const manifest = await res.json();
  if (currentKit(env)?.version === manifest.version) return { state: "current", version: manifest.version };
  if (!VERSION.test(String(manifest.version))) throw new Error("not a kit manifest");
  const got = await fetcher(`${base}/v1/kit/${manifest.version}.json`, { headers: h, signal: AbortSignal.timeout(timeoutMs) });
  if (!got.ok) throw new Error(`the colony answered ${got.status} for its kit`);
  const files = verifyBundle(Buffer.from(await got.arrayBuffer()), manifest, keys);
  const root = kitRoot(env);
  const dir = join(root, manifest.version);
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(tmp, name), text);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  writeFileSync(join(root, "current.json.tmp"), JSON.stringify({ version: manifest.version, at: new Date().toISOString() }));
  renameSync(join(root, "current.json.tmp"), join(root, "current.json"));
  prune(root, manifest.version);
  return { state: "installed", version: manifest.version };
}

/** Keeps the kit in use and the one before it; anything else goes. */
function prune(root, keep) {
  try {
    const versions = readdirSync(root).filter((n) => VERSION.test(n) && n !== keep);
    versions.sort((a, b) => statTime(join(root, b)) - statTime(join(root, a)));
    for (const old of versions.slice(1)) rmSync(join(root, old), { recursive: true, force: true });
  } catch {
    /* an old kit left behind does no harm */
  }
}

function statTime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** A module of the kit in use, or null when there is no kit (or the module cannot load). */
export async function loadKit(name, env = process.env) {
  const kit = currentKit(env);
  if (!kit || !NAME.test(name) || !existsSync(join(kit.dir, name))) return null;
  try {
    return await import(pathToFileURL(join(kit.dir, name)).href);
  } catch {
    return null;
  }
}
