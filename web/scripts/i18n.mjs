#!/usr/bin/env node
// Builds the Spanish pages of the website (web/es/*.html) from the English ones and web/i18n/es.json.
//
//   node web/scripts/i18n.mjs           write web/es/
//   node web/scripts/i18n.mjs --check   fail if web/es/ is not what the English pages and the translations make, or if a
//                                       translated text no longer appears in its English page (it changed: translate it)
//
// es.json maps each page to [english, spanish] pairs, applied in order, every occurrence. A pair should carry enough
// markup around its text (`>Docs</a>`) to match only where it is meant to. Links are rewritten so the Spanish pages
// work from /es/: assets and the docs from the site root, the other pages to their Spanish version.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const translations = JSON.parse(readFileSync(join(web, "i18n", "es.json"), "utf8"));
const SITE = "https://myrmo.dev";
const PAGES = Object.keys(translations.pages);

function links(html) {
  return html
    .replace(/((?:href|src|poster)=")(assets\/|llms\.txt|docs\/?)/g, "$1/$2")
    .replace(/href="index\.html(#[^"]*)?"/g, (_, hash = "") => `href="/es/${hash}"`)
    .replace(new RegExp(`href="(${PAGES.filter((p) => p !== "index.html").map((p) => p.replace(".", "\\.")).join("|")})(#[^"]*)?"`, "g"),
      (_, page, hash = "") => `href="/es/${page}${hash}"`)
    .replace(/<html lang="en"/, '<html lang="es"');
}

function build(page) {
  let html = readFileSync(join(web, page), "utf8");
  const missing = [];
  for (const [en, es] of [...(translations.common || []), ...translations.pages[page]]) {
    if (!html.includes(en)) { missing.push(en); continue; }
    html = html.split(en).join(es);
  }
  html = links(html);
  const path = page === "index.html" ? "/es/" : `/es/${page}`;
  html = html
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${SITE}${path}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE}${path}">`)
    .replace(/"inLanguage": "en"/g, '"inLanguage": "es"');
  return { html, missing };
}

let failed = false;
mkdirSync(join(web, "es"), { recursive: true });
for (const page of PAGES) {
  const { html, missing } = build(page);
  for (const text of missing) {
    failed = true;
    console.error(`${page}: no longer in the English page, translate it again: ${JSON.stringify(text.slice(0, 120))}`);
  }
  const out = join(web, "es", page);
  if (check) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== html) {
      failed = true;
      console.error(`web/es/${page} is out of date: run node web/scripts/i18n.mjs`);
    }
  } else {
    writeFileSync(out, html);
    console.log(`wrote web/es/${page}`);
  }
}
process.exit(failed ? 1 : 0);
