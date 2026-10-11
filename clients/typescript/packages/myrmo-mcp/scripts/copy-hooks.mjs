// Copies the Antigravity hook and the scripts it needs from the Claude Code plugin into dist/hooks, so that
// `npx myrmo-mcp init` can install the hook for Antigravity users who have no Claude Code plugin. One source of truth:
// plugins/myrmo/scripts, found by walking up from this package (the repository, or a Docker build that copies it in).
// Missing, the build fails: a package without its hooks must never be published.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
let from = "";
for (let dir = pkg; ; dir = dirname(dir)) {
  const candidate = join(dir, "plugins", "myrmo", "scripts");
  if (existsSync(join(candidate, "antigravity-hook.mjs"))) {
    from = candidate;
    break;
  }
  if (dirname(dir) === dir) break;
}
if (!from) {
  console.error("copy-hooks: plugins/myrmo/scripts not found above " + pkg + "; copy it into the build.");
  process.exit(1);
}
const to = join(pkg, "dist", "hooks");
mkdirSync(to, { recursive: true });
for (const file of ["antigravity-hook.mjs", "on-failure.mjs", "lookup.mjs"]) copyFileSync(join(from, file), join(to, file));
