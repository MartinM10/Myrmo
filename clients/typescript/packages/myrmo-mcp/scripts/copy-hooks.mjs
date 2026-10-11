// Copies the Antigravity hook and the scripts it needs from the Claude Code plugin into dist/hooks, so that
// `npx myrmo-mcp init` can install the hook for Antigravity users who have no Claude Code plugin. One source of truth:
// plugins/myrmo/scripts.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "..", "..", "..", "plugins", "myrmo", "scripts");
const to = join(here, "..", "dist", "hooks");
mkdirSync(to, { recursive: true });
for (const file of ["antigravity-hook.mjs", "on-failure.mjs", "lookup.mjs"]) copyFileSync(join(from, file), join(to, file));
