// Check a trail against the protocol schema on this machine, without sending it anywhere. A preview, or a publish the
// user has not agreed to, must send nothing: the colony's own check (POST /v1/validate) runs only once publishing is
// agreed. The schema is the protocol's own file, copied next to this one at build time (scripts/copy-hooks.mjs).
//
// It understands the subset of JSON Schema (draft 7) that protocol/trail.v1.schema.json uses.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;
export interface Issue {
  path: string;
  message: string;
}

let cached: Schema | null | undefined;

/** The bundled trail schema, or null when this build has none. */
export function trailSchema(): Schema | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "trail.v1.schema.json"), "utf8")) as Schema;
  } catch {
    cached = null;
  }
  return cached;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const matchesType = (v: unknown, t: string) =>
  t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeOf(v) === t;
/** A pattern this engine cannot compile is left to the colony's own check. */
const matchesPattern = (pattern: string, value: string) => {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return true;
  }
};
const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

function resolve(root: Schema, node: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let at: unknown = root;
  for (const part of ref.slice(2).split("/")) at = (at as Schema | undefined)?.[part];
  return (at as Schema) ?? {};
}

function check(root: Schema, raw: Schema, value: unknown, path: string, out: Issue[]): void {
  const s = resolve(root, raw);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({ path, message: `must be ${types.join(" or ")}` });
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) out.push({ path, message: `must be one of ${JSON.stringify(s.enum)}` });
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) out.push({ path, message: `must be at least ${s.minLength} characters` });
    if (typeof s.maxLength === "number" && length > s.maxLength) out.push({ path, message: `must be at most ${s.maxLength} characters` });
    if (typeof s.pattern === "string" && !matchesPattern(s.pattern, value)) out.push({ path, message: `must match ${s.pattern}` });
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) out.push({ path, message: `must be at least ${s.minimum}` });
    if (typeof s.maximum === "number" && value > s.maximum) out.push({ path, message: `must be at most ${s.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) out.push({ path, message: `must have at least ${s.minItems} items` });
    if (typeof s.maxItems === "number" && value.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} items` });
    if (s.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push({ path, message: "must not repeat items" });
    if (s.items && typeof s.items === "object") value.forEach((v, i) => check(root, s.items as Schema, v, pointer(path, i), out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in obj)) out.push({ path: pointer(path, key), message: "is required" });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) check(root, props[key], v, pointer(path, key), out);
      else if (s.additionalProperties === false) out.push({ path: pointer(path, key), message: "is not a field of the protocol" });
      else if (s.additionalProperties && typeof s.additionalProperties === "object") check(root, s.additionalProperties as Schema, v, pointer(path, key), out);
    }
  }
  if (s.not && typeof s.not === "object" && validates(root, s.not as Schema, value, path)) out.push({ path, message: "is not allowed here" });
  if (s.if && typeof s.if === "object") {
    const branch = validates(root, s.if as Schema, value, path) ? s.then : s.else;
    if (branch && typeof branch === "object") check(root, branch as Schema, value, path, out);
  }
}

function validates(root: Schema, schema: Schema, value: unknown, path: string): boolean {
  const out: Issue[] = [];
  check(root, schema, value, path, out);
  return out.length === 0;
}

/** What is wrong with a trail by the protocol schema; null when this build has no schema to check against. */
export function checkTrail(trail: unknown, schema: Schema | null = trailSchema()): Issue[] | null {
  if (!schema) return null;
  const out: Issue[] = [];
  check(schema, schema, trail, "", out);
  return out;
}
