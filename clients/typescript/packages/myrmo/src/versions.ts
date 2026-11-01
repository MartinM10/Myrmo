// Which versions of a package an environment tells apart, so that a trail written for react 17 is not offered as if it
// were for react 18. The colony and the Python SDK do the same; all three reproduce protocol/package_versions.v1.vectors.json.

import type { Package } from "./types.js";

export interface PackageMismatch {
  name: string;
  /** The version the caller has. */
  yours: string;
  /** The version the trail was written for. */
  trail: string;
}

/**
 * The part of a version that tells releases apart: the major (`18.2.0` → `18`), or major.minor while the major is 0
 * (`0.20.1` → `0.20`), since a 0.x release may break. A leading `v`, `^`, `~`, `=`, `<` or `>` is ignored. `null` when
 * the version holds no number (`latest`).
 */
export function majorOf(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const m = /^[\s^~=<>!v]*(\d+)(?:\.(\d+))?/i.exec(version);
  if (!m) return null;
  const major = String(Number(m[1]));
  return major === "0" && m[2] !== undefined ? `0.${Number(m[2])}` : major;
}

/**
 * The packages the caller has that the trail names in another major version, in the caller's order. A package without
 * a version on either side never mismatches, and neither does one the trail does not name.
 */
export function packageMismatches(mine: readonly Package[] | undefined, trail: readonly Package[] | null | undefined): PackageMismatch[] {
  if (!mine?.length || !trail?.length) return [];
  const out: PackageMismatch[] = [];
  for (const m of mine) {
    const ours = majorOf(m.version);
    if (!m.name || ours === null) continue;
    const named = trail.find((p) => typeof p?.name === "string" && p.name.toLowerCase() === m.name.toLowerCase() && majorOf(p.version) !== null);
    if (named && majorOf(named.version) !== ours) out.push({ name: m.name, yours: String(m.version), trail: String(named.version) });
  }
  return out;
}
