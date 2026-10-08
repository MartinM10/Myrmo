// The colony page groups runtime spellings (`jvm`, `java`) with a copy of the table in server/src/runtime.rs.
// This fails when the two differ, so that a name added on the server is added to the page too.
//   node tools/check-runtime-aliases.mjs        (from the repository root)
import { readFileSync } from "node:fs";

const names = (list) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

const rust = readFileSync("server/src/runtime.rs", "utf8");
const start = rust.indexOf("const ALIASES");
const table = rust.slice(start, rust.indexOf("];", start));
const server = Object.fromEntries([...table.matchAll(/\("([^"]+)",\s*&\[([^\]]*)\]\)/g)].map((m) => [m[1], names(m[2])]));

const html = readFileSync("web/colony.html", "utf8");
const from = html.indexOf("const RUNTIME_ALIASES = {");
const block = html.slice(from, html.indexOf("};", from));
const page = Object.fromEntries([...block.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)].map((m) => [m[1], names(m[2])]));

const a = JSON.stringify(server, Object.keys(server).sort());
const b = JSON.stringify(page, Object.keys(page).sort());
if (!Object.keys(server).length || a !== b) {
  console.error("Runtime aliases differ between server/src/runtime.rs and web/colony.html:");
  console.error("  server:", JSON.stringify(server));
  console.error("  page:  ", JSON.stringify(page));
  process.exit(1);
}
console.log(`runtime aliases agree (${Object.keys(server).length} runtimes)`);
