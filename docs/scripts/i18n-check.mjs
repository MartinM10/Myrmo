// Keeps the Spanish documentation (docs/es/) in step with the English pages.
//
//   node scripts/i18n-check.mjs           fail when an English page has no Spanish page, or changed since its translation
//   node scripts/i18n-check.mjs --stamp es/teams.md   record that es/teams.md now translates the current English page
//
// Each Spanish page says in its front matter which version of the English page it translates:
//   translated_from: <first 12 hex of the SHA-256 of the English file>
// When the English page changes, the check fails until someone updates the Spanish page and stamps it again.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pages } from "./pages.mjs";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..");
// Version numbers are left out: release-please bumps them in both languages, and a release is not a change to translate.
const hash = (file) =>
  createHash("sha256")
    .update(readFileSync(join(docs, file), "utf8").replace(/\d+\.\d+\.\d+/g, "X.Y.Z"))
    .digest("hex")
    .slice(0, 12);
const STAMP = /^translated_from:\s*([0-9a-f]{12})\s*$/m;

const stamp = process.argv.indexOf("--stamp");
if (stamp !== -1) {
  for (const target of process.argv.slice(stamp + 1)) {
    const english = target.replace(/^es\//, "");
    const path = join(docs, target);
    const text = readFileSync(path, "utf8");
    const line = `translated_from: ${hash(english)}`;
    const next = STAMP.test(text) ? text.replace(STAMP, line) : text.replace(/^---\n/, `---\n${line}\n`);
    if (next === text && !STAMP.test(text)) throw new Error(`${target}: no front matter to stamp`);
    writeFileSync(path, next);
    console.log(`${target}: ${line}`);
  }
  process.exit(0);
}

let failed = false;
for (const english of pages().filter((p) => !p.startsWith("es/"))) {
  const spanish = `es/${english}`;
  if (!existsSync(join(docs, spanish))) {
    console.error(`${spanish}: missing (translate ${english})`);
    failed = true;
    continue;
  }
  const found = readFileSync(join(docs, spanish), "utf8").match(STAMP)?.[1];
  if (found !== hash(english)) {
    console.error(`${spanish}: ${english} changed since it was translated; update it, then run node scripts/i18n-check.mjs --stamp ${spanish}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("every English page has a current Spanish translation");
