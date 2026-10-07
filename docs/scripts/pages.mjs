// The markdown pages of the documentation site.

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The markdown pages of the site, as paths relative to the docs folder (README.md is the GitHub entry point, not a page). */
export function pages() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "scripts" || entry.name === "public") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && relative(docs, path) !== "README.md") out.push(relative(docs, path).split("\\").join("/"));
    }
  };
  walk(docs);
  return out.sort();
}
