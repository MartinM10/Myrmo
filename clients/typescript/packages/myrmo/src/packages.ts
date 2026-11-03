// The packages a project declares, read from its manifests, so a search can say which versions the caller has without
// the model having to. Only names and versions of direct dependencies leave the manifest: no paths, no registry
// addresses, no scripts. Best effort: a file that cannot be read or parsed is skipped.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Package } from "./types.js";

/** The protocol allows 50 packages in an environment; a search names the few that matter. */
export const MAX_DETECTED_PACKAGES = 30;

export interface DetectOptions {
  /** The error text: packages it names come first, since they are the ones that matter. */
  query?: string;
  max?: number;
  /** Scoped npm names (`@scope/name`) are often private packages: left out unless the colony is the organisation's own. */
  scoped?: boolean;
  /** Only the packages `query` names, for a trail: its packages are the ones relevant to the problem, not a lockfile. */
  onlyNamed?: boolean;
}

const read = (path: string): string | null => {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
};

/** A version spec that points at a place (a path, a repository, a workspace) rather than at a registry release. */
const notRegistry = (spec: string) => /^(workspace:|file:|link:|portal:|git|github:|https?:|npm:)|[\\/]/i.test(spec.trim());

function node(cwd: string, scoped: boolean): Package[] {
  const text = read(join(cwd, "package.json"));
  if (text === null) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const lock = (() => {
    try {
      const raw = read(join(cwd, "package-lock.json"));
      return raw ? (JSON.parse(raw) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }) : null;
    } catch {
      return null;
    }
  })();
  const out: Package[] = [];
  const own = typeof manifest.name === "string" ? manifest.name : "";
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string" || name === own || notRegistry(spec)) continue;
      if (!scoped && name.startsWith("@")) continue;
      // The installed release when a lock file says which, else the range the manifest asks for.
      const installed = lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
      out.push({ name, version: installed ?? spec.trim() });
    }
  }
  return out;
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** `numpy[extra]==1.24.4 ; python_version > "3"` → `numpy` and `1.24.4`; only `==` and `~=` name a release. */
function requirement(line: string): Package | null {
  const spec = line.split("#")[0].split(";")[0].trim();
  if (!spec || spec.startsWith("-") || /[\\/@]|:\/\//.test(spec.replace(/\[[^\]]*\]/g, ""))) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:(===?|~=)\s*([A-Za-z0-9.*+!_-]+))?/.exec(spec);
  if (!m) return null;
  return m[3] && !m[3].includes("*") ? { name: m[1], version: m[3] } : { name: m[1] };
}

/** `[[package]]` blocks of poetry.lock and uv.lock: the release each package is installed at. */
function locked(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) out.set(normalize(name), version);
  }
  return out;
}

function python(cwd: string): Package[] {
  const found: Package[] = [];
  for (const file of ["requirements.txt", "requirements-dev.txt", "requirements/base.txt", "requirements/prod.txt"]) {
    for (const line of (read(join(cwd, file)) ?? "").split(/\r?\n/)) {
      const p = requirement(line);
      if (p) found.push(p);
    }
  }
  const pyproject = read(join(cwd, "pyproject.toml"));
  if (pyproject) {
    const project = /^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)^\]/m.exec(pyproject)?.[1] ?? "";
    for (const m of project.matchAll(/"([^"]+)"/g)) {
      const p = requirement(m[1]);
      if (p) found.push(p);
    }
    const poetry = /^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
    for (const m of poetry.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)"[^}]*\})/gm)) {
      if (m[1].toLowerCase() === "python") continue;
      const spec = (m[2] ?? m[3] ?? "").trim();
      found.push({ name: m[1], ...(spec && !notRegistry(spec) ? { version: spec } : {}) });
    }
  }
  const installed = new Map([...locked(read(join(cwd, "poetry.lock"))), ...locked(read(join(cwd, "uv.lock")))]);
  return found.map((p) => (installed.has(normalize(p.name)) ? { name: p.name, version: installed.get(normalize(p.name)) } : p));
}

/**
 * The direct dependencies of the project in `cwd`: Node (`package.json`, with the release `package-lock.json` pins) and
 * Python (`requirements*.txt`, `pyproject.toml`, with the release `poetry.lock` or `uv.lock` pins). Names the error
 * text mentions come first, then the manifest's order, at most `max`.
 */
export function detectPackages(cwd: string = process.cwd(), options: DetectOptions = {}): Package[] {
  if (process.env.MYRMO_DETECT_PACKAGES === "0") return [];
  const max = options.max ?? MAX_DETECTED_PACKAGES;
  const seen = new Set<string>();
  const all: Package[] = [];
  for (const p of [...node(cwd, options.scoped === true), ...python(cwd)]) {
    const key = normalize(p.name);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(p);
  }
  const text = (options.query ?? "").toLowerCase();
  // `pkg-3` is not named by a text about `pkg-37`: the name must stand alone.
  const named = (p: Package) => text.length > 0 && new RegExp(`(^|[^a-z0-9._@/-])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9._-])`).test(text);
  return [...all.filter(named), ...(options.onlyNamed ? [] : all.filter((p) => !named(p)))].slice(0, max);
}
