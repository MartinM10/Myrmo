// Copies the Antigravity hook and the scripts it needs from the Claude Code plugin into dist/hooks, so that
// `npx myrmo-mcp init` can install the hook for Antigravity users who have no Claude Code plugin. One source of truth:
// plugins/myrmo/scripts, found by walking up from this package (the repository, or a Docker build that copies it in).
// Also copies the protocol's trail schema into dist, for checking a trail on this machine before anything is sent
// (src/check.ts).
// Missing, the build fails: a package without its hooks or its schema must never be published.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The first `relative` above this package that holds `marker`, or "". */
function above(relative, marker) {
  for (let dir = pkg; ; dir = dirname(dir)) {
    const candidate = join(dir, relative);
    if (existsSync(join(candidate, marker))) return candidate;
    if (dirname(dir) === dir) return "";
  }
}

const from = above(join("plugins", "myrmo", "scripts"), "antigravity-hook.mjs");
if (!from) {
  console.error("copy-hooks: plugins/myrmo/scripts not found above " + pkg + "; copy it into the build.");
  process.exit(1);
}
const to = join(pkg, "dist", "hooks");
mkdirSync(to, { recursive: true });
for (const file of ["antigravity-hook.mjs", "on-failure.mjs", "lookup.mjs", "effort.mjs", "state.mjs", "redact.mjs"]) copyFileSync(join(from, file), join(to, file));

const protocol = above("protocol", "trail.v1.schema.json");
if (!protocol) {
  console.error("copy-hooks: protocol/trail.v1.schema.json not found above " + pkg + "; copy it into the build.");
  process.exit(1);
}
copyFileSync(join(protocol, "trail.v1.schema.json"), join(pkg, "dist", "trail.v1.schema.json"));
