// The Claude Code plugin's hooks run with plain node and no packages, and still redact what they send to a colony with
// the SDK's own rules: plugins/myrmo/scripts/redact.mjs is the SDK's built redact.js with a header. Run this after
// changing packages/myrmo/src/redact.ts and building; the SDK's tests fail while the copy differs.
//
//   npm run build && node scripts/sync-plugin-redact.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const HEADER =
  "// Generated from clients/typescript/packages/myrmo/src/redact.ts by clients/typescript/scripts/sync-plugin-redact.mjs.\n" +
  "// Do not edit: change the SDK, build it and run that script. The SDK's tests check that this copy is current.\n";

export function pluginCopy(built) {
  return HEADER + built;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = readFileSync(join(here, "..", "packages", "myrmo", "dist", "redact.js"), "utf8");
  const target = join(here, "..", "..", "..", "plugins", "myrmo", "scripts", "redact.mjs");
  writeFileSync(target, pluginCopy(built));
  console.log(`wrote ${target}`);
}
