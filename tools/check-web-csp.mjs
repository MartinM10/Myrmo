// The website's Content-Security-Policy (deploy/nginx-web.conf) runs only script files: an inline <script> or an
// onclick="..." in a page would silently stop working in production. This fails when a page has one, and checks
// that the colony page honours ?api= only on a local copy. Run from the repository root:
//   node tools/check-web-csp.mjs
import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";

let failed = false;
const fail = (message) => {
  console.error(message);
  failed = true;
};

const pages = readdirSync("web").filter((f) => f.endsWith(".html"));
for (const page of pages) {
  const html = readFileSync(`web/${page}`, "utf8");
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    // Data blocks (structured data for search engines) are not run, so the policy does not apply to them.
    if (/\bsrc=/i.test(attrs) || /type="application\/ld\+json"/i.test(attrs)) continue;
    fail(`web/${page}: inline <script${attrs}> (move it to a file in web/assets/)`);
  }
  for (const m of html.matchAll(/<[^>]*\s(on[a-z]+)\s*=/gi)) fail(`web/${page}: inline event handler ${m[1]}= (use addEventListener)`);
  if (/javascript:/i.test(html)) fail(`web/${page}: javascript: URL`);
}

// apiBase from web/assets/common.js, run as the page would run it.
const sandbox = { window: {}, URL, URLSearchParams };
vm.runInNewContext(readFileSync("web/assets/common.js", "utf8"), sandbox);
const { apiBase, compact } = sandbox.window.Myrmo;
const at = (href) => {
  const u = new URL(href);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port, search: u.search, origin: u.origin };
};
const cases = [
  ["https://myrmo.dev/colony.html", "https://myrmo.dev"],
  ["https://myrmo.dev/colony.html?api=https://evil.example", "https://myrmo.dev"],
  ["https://colony.example.org/colony.html?api=http://localhost:8080", "https://colony.example.org"],
  ["http://localhost:3000/colony.html", "http://localhost:8080"],
  ["http://localhost:3000/colony.html?api=http://localhost:9090/", "http://localhost:9090"],
  ["http://127.0.0.1:5500/colony.html?api=https://myrmo.dev", "https://myrmo.dev"],
  ["http://127.0.0.1:5500/colony.html?api=javascript:alert(1)", "http://127.0.0.1:5500"],
  ["http://127.0.0.1:5500/colony.html?api=not a url", "http://127.0.0.1:5500"],
];
for (const [href, want] of cases) {
  const got = apiBase(at(href));
  if (got !== want) fail(`apiBase(${href}) = ${got}, want ${want}`);
}
for (const [value, want] of [[41200, "41.2k"], ["7", "7"], ['<img src=x onerror="alert(1)">', "—"], [undefined, "—"]]) {
  if (compact(value) !== want) fail(`compact(${JSON.stringify(value)}) = ${compact(value)}, want ${want}`);
}

if (failed) process.exit(1);
console.log(`no inline scripts in ${pages.length} pages; ?api= is local only`);
