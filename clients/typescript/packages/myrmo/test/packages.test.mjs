import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackages, detectRuntime } from "../dist/index.js";

const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-pkgs-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
};
const names = (list) => list.map((p) => p.name);

test("a Node project: direct dependencies, the locked release when there is one, the range when not", () => {
  const dir = project({
    "package.json": { name: "app", dependencies: { react: "^18.2.0", lodash: "~4.17.0" }, devDependencies: { vitest: "^1.0.0" } },
    "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "18.3.1" }, "node_modules/react-dom": { version: "18.3.1" } } },
  });
  assert.deepEqual(detectPackages(dir), [
    { name: "react", version: "18.3.1" },
    { name: "lodash", version: "~4.17.0" },
    { name: "vitest", version: "^1.0.0" },
  ]);
});

test("what points at a place, a workspace sibling or the project itself is not a package", () => {
  const dir = project({
    "package.json": {
      name: "app",
      dependencies: { app: "1.0.0", shared: "workspace:*", local: "file:../local", fork: "github:someone/fork", tarball: "https://example.org/x.tgz", real: "2.1.0" },
    },
  });
  assert.deepEqual(names(detectPackages(dir)), ["real"]);
});

test("scoped npm names stay out unless the colony is the organisation's own", () => {
  const dir = project({ "package.json": { dependencies: { "@acme/billing": "1.2.0", react: "18.2.0" } } });
  assert.deepEqual(names(detectPackages(dir)), ["react"]);
  assert.deepEqual(names(detectPackages(dir, { scoped: true })), ["@acme/billing", "react"]);
});

test("a Python project: requirements pins, pyproject dependencies, the release a lock file pins", () => {
  const dir = project({
    "requirements.txt": "numpy==1.24.4\nrequests[socks]~=2.31\n# comment\n-r other.txt\n-e ./local\npandas>=2.0  # a floor says nothing about the release\n./wheel.whl\n",
    "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n  "flask>=3.0",\n  "httpx==0.27.0",\n]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nsqlalchemy = "^2.0"\ndjango = { version = "^5.0", extras = ["argon2"] }\n',
    "poetry.lock": '[[package]]\nname = "Flask"\nversion = "3.0.3"\n\n[[package]]\nname = "numpy"\nversion = "1.26.0"\n',
  });
  const found = detectPackages(dir);
  const by = Object.fromEntries(found.map((p) => [p.name, p.version]));
  assert.equal(by.numpy, "1.26.0", "the lock file wins over the pin");
  assert.equal(by.requests, "2.31");
  assert.equal(by.pandas, undefined, "a lower bound is not a release");
  assert.equal(by.flask, "3.0.3");
  assert.equal(by.httpx, "0.27.0");
  assert.equal(by.sqlalchemy, "^2.0");
  assert.equal(by.django, "^5.0");
  assert.ok(!("python" in by), "the interpreter is not a package");
  assert.ok(!names(found).some((n) => /local|wheel|other/.test(n)), "paths and includes are not packages");
});

test("the packages the error names come first, and there are at most 30", () => {
  const deps = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg-${i}`, "1.0.0"]));
  const dir = project({ "package.json": { dependencies: deps } });
  const found = detectPackages(dir, { query: "TypeError in pkg-37 while loading" });
  assert.equal(found.length, 30);
  assert.equal(found[0].name, "pkg-37");
});

test("nothing to read gives an empty list, and so does the opt-out", () => {
  assert.deepEqual(detectPackages(project({ "notes.txt": "x" })), []);
  assert.deepEqual(detectPackages(project({ "package.json": "{ not json" })), []);
  const dir = project({ "package.json": { dependencies: { react: "18.2.0" } } });
  process.env.MYRMO_DETECT_PACKAGES = "0";
  try {
    assert.deepEqual(detectPackages(dir), []);
  } finally {
    delete process.env.MYRMO_DETECT_PACKAGES;
  }
});

test("the Claude Code plugin's hook reads dependencies with this very code (scripts/sync-plugin-redact.mjs)", async () => {
  const { packagesCopy } = await import("../../../scripts/sync-plugin-redact.mjs");
  const { readFileSync } = await import("node:fs");
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const copy = readFileSync(new URL("../../../../../plugins/myrmo/scripts/packages.mjs", import.meta.url), "utf8");
  const built = readFileSync(new URL("../dist/packages.js", import.meta.url), "utf8");
  assert.equal(lf(copy), lf(packagesCopy(built)), "out of date: run npm run build && node scripts/sync-plugin-redact.mjs in clients/typescript");
});

test("onlyNamed keeps the packages the text names and nothing else", () => {
  const dir = project({ "package.json": { dependencies: { react: "^18.2.0", lodash: "4.17.21", vue: "3.4.0" } } });
  assert.deepEqual(detectPackages(dir, { query: "TypeError thrown by react while rendering", onlyNamed: true }), [{ name: "react", version: "^18.2.0" }]);
  assert.deepEqual(detectPackages(dir, { query: "nothing here", onlyNamed: true }), []);
});

test("the runtime comes from the manifests, the release only from a version file, and a mixed project says nothing", () => {
  assert.deepEqual(detectRuntime(project({ "package.json": {} })), { name: "node" });
  assert.deepEqual(detectRuntime(project({ "package.json": {}, ".nvmrc": "v20.11.0\n" })), { name: "node", version: "20.11.0" });
  assert.deepEqual(detectRuntime(project({ "package.json": {}, ".nvmrc": "20\n" })), { name: "node" }, "a bare major is no release");
  assert.deepEqual(detectRuntime(project({ "pyproject.toml": "[project]\nname='x'\n", ".python-version": "3.12\n" })), { name: "python", version: "3.12" });
  assert.equal(detectRuntime(project({ "package.json": {}, "requirements.txt": "numpy\n" })), undefined);
  assert.equal(detectRuntime(project({ "notes.txt": "x" })), undefined);
});

test("detectPackages and detectRuntime reproduce the shared vectors (protocol/project_packages.v1.vectors.json)", async () => {
  const { readFileSync } = await import("node:fs");
  const vectors = JSON.parse(readFileSync(new URL("../../../../../protocol/project_packages.v1.vectors.json", import.meta.url), "utf8"));
  for (const c of vectors.packages) assert.deepEqual(detectPackages(project(c.files), c.options), c.expected, c.why);
  for (const c of vectors.runtime) assert.deepEqual(detectRuntime(project(c.files)) ?? null, c.expected, c.why);
});
