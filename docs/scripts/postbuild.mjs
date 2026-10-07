// After `vitepress build`: put the markdown next to the HTML, and write one file with all of it.
//
// Every page is served as HTML (for people) and, with `.md` added to its address, as the markdown it is written in: an agent
// reads that with a fraction of the tokens and none of the page chrome. `llms-full.txt` is all the pages in one file, for an
// agent that wants the whole documentation in one request. The page list of `web/llms.txt` is kept by `llms.mjs`.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pages } from "./pages.mjs";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(docs, ".vitepress", "dist");
const site = (process.env.MYRMO_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
if (!existsSync(dist)) {
  console.error("Run `vitepress build` first.");
  process.exit(1);
}

const files = pages();
const parts = [];
for (const file of files) {
  const target = join(dist, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(docs, file), target);
  const url = `${site}/docs/${file.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
  parts.push(`<!-- ${url} -->\n\n${readFileSync(join(docs, file), "utf8").trim()}\n`);
}
writeFileSync(join(dist, "llms-full.txt"), `# Myrmo documentation\n\nThe whole documentation in one file. Each page starts with a comment that gives its address.\n\n${parts.join("\n---\n\n")}`);
console.log(`markdown for ${files.length} pages and llms-full.txt written to ${relative(docs, dist)}`);
