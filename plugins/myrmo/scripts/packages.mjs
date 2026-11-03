// Generated from clients/typescript/packages/myrmo/src/packages.ts by clients/typescript/scripts/sync-plugin-redact.mjs.
// Do not edit: change the SDK, build it and run that script. The SDK's tests check that this copy is current.
// The packages a project declares, read from its manifests, so a search can say which versions the caller has without
// the model having to. Only names and versions of direct dependencies leave the manifest: no paths, no registry
// addresses, no scripts. Best effort: a file that cannot be read or parsed is skipped.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** The protocol allows 50 packages in an environment; a search names the few that matter. */
export const MAX_DETECTED_PACKAGES = 30;
const read = (path) => {
    try {
        return existsSync(path) ? readFileSync(path, "utf8") : null;
    }
    catch {
        return null;
    }
};
/** A version spec that points at a place (a path, a repository, a workspace) rather than at a registry release. */
const notRegistry = (spec) => /^(workspace:|file:|link:|portal:|git|github:|https?:|npm:)|[\\/]/i.test(spec.trim());
function node(cwd, scoped) {
    const text = read(join(cwd, "package.json"));
    if (text === null)
        return [];
    let manifest;
    try {
        manifest = JSON.parse(text);
    }
    catch {
        return [];
    }
    const lock = (() => {
        try {
            const raw = read(join(cwd, "package-lock.json"));
            return raw ? JSON.parse(raw) : null;
        }
        catch {
            return null;
        }
    })();
    const out = [];
    const own = typeof manifest.name === "string" ? manifest.name : "";
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const deps = manifest[field];
        if (!deps || typeof deps !== "object")
            continue;
        for (const [name, spec] of Object.entries(deps)) {
            if (typeof spec !== "string" || name === own || notRegistry(spec))
                continue;
            if (!scoped && name.startsWith("@"))
                continue;
            // The installed release when a lock file says which, else the range the manifest asks for.
            const installed = lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
            out.push({ name, version: installed ?? spec.trim() });
        }
    }
    return out;
}
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
/** `numpy[extra]==1.24.4 ; python_version > "3"` → `numpy` and `1.24.4`; only `==` and `~=` name a release. */
function requirement(line) {
    const spec = line.split("#")[0].split(";")[0].trim();
    if (!spec || spec.startsWith("-") || /[\\/@]|:\/\//.test(spec.replace(/\[[^\]]*\]/g, "")))
        return null;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:(===?|~=)\s*([A-Za-z0-9.*+!_-]+))?/.exec(spec);
    if (!m)
        return null;
    return m[3] && !m[3].includes("*") ? { name: m[1], version: m[3] } : { name: m[1] };
}
/** `[[package]]` blocks of poetry.lock and uv.lock: the release each package is installed at. */
function locked(text) {
    const out = new Map();
    if (!text)
        return out;
    for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
        const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        if (name && version)
            out.set(normalize(name), version);
    }
    return out;
}
function python(cwd) {
    const found = [];
    for (const file of ["requirements.txt", "requirements-dev.txt", "requirements/base.txt", "requirements/prod.txt"]) {
        for (const line of (read(join(cwd, file)) ?? "").split(/\r?\n/)) {
            const p = requirement(line);
            if (p)
                found.push(p);
        }
    }
    const pyproject = read(join(cwd, "pyproject.toml"));
    if (pyproject) {
        const project = /^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)^\]/m.exec(pyproject)?.[1] ?? "";
        for (const m of project.matchAll(/"([^"]+)"/g)) {
            const p = requirement(m[1]);
            if (p)
                found.push(p);
        }
        const poetry = /^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
        for (const m of poetry.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)"[^}]*\})/gm)) {
            if (m[1].toLowerCase() === "python")
                continue;
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
export function detectPackages(cwd = process.cwd(), options = {}) {
    if (process.env.MYRMO_DETECT_PACKAGES === "0")
        return [];
    const max = options.max ?? MAX_DETECTED_PACKAGES;
    const seen = new Set();
    const all = [];
    for (const p of [...node(cwd, options.scoped === true), ...python(cwd)]) {
        const key = normalize(p.name);
        if (seen.has(key))
            continue;
        seen.add(key);
        all.push(p);
    }
    const text = (options.query ?? "").toLowerCase();
    // `pkg-3` is not named by a text about `pkg-37`: the name must stand alone.
    const named = (p) => text.length > 0 && new RegExp(`(^|[^a-z0-9._@/-])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9._-])`).test(text);
    return [...all.filter(named), ...(options.onlyNamed ? [] : all.filter((p) => !named(p)))].slice(0, max);
}
/** The first line of a version file, when it is a release with a minor (`20.11.0`, `3.12`): a bare major is no match for one. */
const versionFile = (path) => {
    const first = (read(path) ?? "").split(/\r?\n/)[0]?.trim().replace(/^v/i, "") ?? "";
    return /^\d+\.\d+(\.\d+)?$/.test(first) ? first : undefined;
};
/**
 * The language runtime of the project in `cwd`: `node` when it has a `package.json`, `python` when it has Python
 * manifests, and nothing when it has both or neither (a guess would be wrong half the time). The release only when the
 * project pins one in `.nvmrc`, `.node-version` or `.python-version`.
 */
export function detectRuntime(cwd = process.cwd()) {
    if (process.env.MYRMO_DETECT_PACKAGES === "0")
        return undefined;
    const isNode = existsSync(join(cwd, "package.json"));
    const isPython = ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py"].some((f) => existsSync(join(cwd, f)));
    if (isNode === isPython)
        return undefined;
    const version = isNode ? (versionFile(join(cwd, ".nvmrc")) ?? versionFile(join(cwd, ".node-version"))) : versionFile(join(cwd, ".python-version"));
    return { name: isNode ? "node" : "python", ...(version ? { version } : {}) };
}
