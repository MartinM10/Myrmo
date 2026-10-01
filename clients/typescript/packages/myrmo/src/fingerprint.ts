// Error fingerprint v1, a port of protocol/fingerprint_v1.py. The shared vectors in
// protocol/fingerprint.v1.vectors.json are normative; see test/fingerprint.test.mjs.

import { createHash } from "node:crypto";

export const PREFIX = "fp1_";
const MAX_NORMALIZED_CHARS = 300;
const SEPARATOR = "\u001f";

const rule = (pattern: string, replacement: string): [RegExp, string] => [new RegExp(pattern, "g"), replacement];

// Applied in order, exactly as in the reference implementation.
const RULES: [RegExp, string][] = [
  rule(String.raw`\b[a-z][a-z0-9+.\-]*:\/\/[^\s'"<>]+`, "<url>"),
  rule(String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, "<uuid>"),
  rule(String.raw`\b0x[0-9a-f]+\b`, "<hex>"),
  rule(String.raw`\b[0-9a-f]{12,}\b`, "<hex>"),
  rule(String.raw`\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`, "<ip>"),
  rule(String.raw`\b[a-z]:\\[^\s'"]+`, "<path>"),
  rule(String.raw`(?<![\w.<>])(?:~|\.{1,2})?\/(?:[^\s'"\/:]+\/)*[^\s'"\/:]*`, "<path>"),
  rule(String.raw`(?<![\w<>\/])[\w.\-]+(?:\/[\w.\-]+)+`, "<path>"),
  rule(String.raw`\b(?=[a-z_]*\d)(?=[0-9_]*[a-z])\w{12,}\b`, "<id>"),
  rule(String.raw`\bline \d+`, "line <n>"),
  rule(String.raw`:\d+(?::\d+)?\b`, ":<n>"),
  rule(String.raw`\b\d{4,}\b`, "<n>"),
];

const nfkcLower = (text: string) => text.normalize("NFKC").toLowerCase();

/** Strip everything that varies between machines but not between errors. */
export function normalizeMessage(errorType: string, message: string): string {
  let text = nfkcLower(message).trim();
  const prefix = `${nfkcLower(errorType).trim()}:`;
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, MAX_NORMALIZED_CHARS).join("");
}

export function fingerprint(runtime: string, errorType: string, message: string): string {
  const material = [runtime.trim().toLowerCase(), nfkcLower(errorType).trim(), normalizeMessage(errorType, message)].join(SEPARATOR);
  return PREFIX + createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/** `Type: message` → `Type`, for callers that only have the error line. */
export function guessErrorType(errorLine: string): string {
  const head = errorLine.split(":", 1)[0]?.trim() ?? "";
  return errorLine.includes(":") && head.length > 0 && head.length <= 64 && !head.includes(" ") ? head : "";
}
