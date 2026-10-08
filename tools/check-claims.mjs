// Claims the website and the docs once made that the code does not back. A phrase on this list must not come back
// until the code does what it says. Run from the repository root:
//   node tools/check-claims.mjs
import { readFileSync } from "node:fs";

const files = [
  "README.md",
  "SECURITY.md",
  "web/index.html",
  "web/colony.html",
  "web/llms.txt",
  "docs/operate/licensing.md",
  "docs/reference/mcp.md",
  "docs/security/safety.md",
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
if (failed) process.exit(1);
console.log(`no stale claims in ${files.length} files`);
