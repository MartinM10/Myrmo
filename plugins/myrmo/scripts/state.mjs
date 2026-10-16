// Where the hooks keep what they remember about a session (state.mjs): the last error lines, the trails shown, the
// prompts looked up. It is this person's only: a folder of their own ($XDG_RUNTIME_DIR/myrmo, else ~/.myrmo/state),
// created readable by them alone and refused when it belongs to someone else or is open to others; files written under
// a fresh name with mode 0600 and moved into place, never through a link; and what is read back is checked again, since
// it goes into the agent's context. MYRMO_HOOK_STATE_DIR chooses another folder (tests).

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const posix = (platform) => platform !== "win32" && typeof process.getuid === "function";

/** The hooks' state folder for this person. */
export function stateDir(env = process.env, platform = process.platform) {
  const chosen = env.MYRMO_HOOK_STATE_DIR?.trim();
  if (chosen) return chosen;
  const runtime = platform !== "win32" ? env.XDG_RUNTIME_DIR?.trim() : "";
  return runtime ? join(runtime, "myrmo") : join(homedir(), ".myrmo", "state");
}

/**
 * The folder, made for this person only; null when it cannot be trusted: a link, not a folder, someone else's, or one
 * of theirs that others can write to and that cannot be closed.
 */
export function ensureDir(dir, platform = process.platform) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (posix(platform)) {
      if (st.uid !== process.getuid()) return null;
      if ((st.mode & 0o077) !== 0) {
        chmodSync(dir, 0o700);
        if ((lstatSync(dir).mode & 0o077) !== 0) return null;
      }
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * A session's state file, or null when no folder can be trusted. $XDG_RUNTIME_DIR that cannot be used (gone, someone
 * else's) falls back to ~/.myrmo/state; a folder chosen with MYRMO_HOOK_STATE_DIR does not.
 */
export function stateFile(name, { env = process.env, platform = process.platform, prefix = "" } = {}) {
  const first = stateDir(env, platform);
  const home = join(homedir(), ".myrmo", "state");
  const dir = ensureDir(first, platform) ?? (env.MYRMO_HOOK_STATE_DIR?.trim() || first === home ? null : ensureDir(home, platform));
  if (!dir) return null;
  const safe = String(name ?? "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
  return join(dir, `${prefix}${safe}.json`);
}

const ids = (value, max) => (Array.isArray(value) ? value.filter((id) => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase()).slice(-max) : []);
const line = (value) => (typeof value === "string" ? value.slice(0, 2000) : "");

/** What was read back, as the hooks expect it: trail ids that are UUIDs, lines that are text of bounded length. */
export function cleanState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state = { ...raw };
  for (const key of ["found", "brief"]) {
    if (state[key] == null) continue;
    if (typeof state[key] !== "object" || Array.isArray(state[key])) {
      state[key] = null;
      continue;
    }
    state[key] = { ...state[key], ids: ids(state[key].ids, 5) };
    if ("task" in state[key]) state[key].task = line(state[key].task);
    if (!state[key].ids.length) state[key] = null;
  }
  if ("briefSeen" in state) state.briefSeen = ids(state.briefSeen, 50);
  for (const key of ["nomatch", "failed", "problem"]) {
    if (state[key] == null) continue;
    if (typeof state[key] !== "object" || Array.isArray(state[key])) state[key] = null;
    else if ("line" in state[key]) state[key] = { ...state[key], line: line(state[key].line) };
  }
  return state;
}

/** The state in `file`, or {} when there is none or it cannot be trusted (a link, someone else's). */
export function readState(file, platform = process.platform) {
  if (!file) return {};
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (posix(platform) && st.uid !== process.getuid())) return {};
    return cleanState(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Write `state` to `file`: a new file of this person's only (0600), then moved over the old one. */
export function writeState(file, state) {
  if (!file) return false;
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    writeSync(fd, JSON.stringify(state));
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    return true;
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    return false;
  }
}
