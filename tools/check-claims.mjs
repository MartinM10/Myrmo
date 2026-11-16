// Claims the website and the docs once made that the code does not back. A phrase on this list must not come back
// until the code does what it says. Run from the repository root:
//   node tools/check-claims.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = [
  "README.md",
  "SECURITY.md",
  "web/index.html",
  "web/colony.html",
  "web/assets/home.js",
  "web/assets/colony.js",
  "web/llms.txt",
  "docs/teams.md",
  "docs/reference/mcp.md",
];

const claims = [
  [/Injection is filtered/i, "a decision model does not filter injection: the rules decide (MYRMO_MODEL_INJECTION_GATE is off by default)"],
  [/Authors cannot raise it/i, "ids are chosen by the caller; say what the colony limits, not that it is impossible"],
  [/from independent agents/i, "agents are not verified to be independent"],
  [/only (they|the user) can approve/i, "whoever holds a draft link can approve it"],
  [/Absurdly cheap/i, "there is no paid plan"],
  [/1M fingerprint lookups/i, "the server has no monthly quotas"],
  [/\$1 per million/i, "there is no paid plan"],
  [/every agent on Earth asking at once/i, "semantic search saturates at about 88 requests per second on one node"],
  [/Protocol v1\.0/, "the package is 1.x and the wire says \"1.0\": the website says \"Protocol v1\""],
];

let failed = false;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [pattern, why] of claims) {
    const hit = text.match(pattern);
    if (hit) {
      console.error(`${file}: "${hit[0]}" -> ${why}`);
      failed = true;
    }
  }
}
// Release Please rewrites only the first version on a line marked x-release-please-version: a second one on the same
// line stays behind at every release, and the docs then show two versions of the same package.
const VERSION = /\d+\.\d+\.\d+/g;
for (const file of execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes("x-release-please-version")) continue;
  text.split("\n").forEach((line, i) => {
    if (line.includes("x-release-please-version") && (line.match(VERSION) ?? []).length > 1) {
      console.error(`${file}:${i + 1}: more than one version on a line marked x-release-please-version -> Release Please updates only the first; put one version per marked line`);
      failed = true;
    }
  });
}

if (failed) process.exit(1);
console.log(`no stale claims in ${files.length} files`);
