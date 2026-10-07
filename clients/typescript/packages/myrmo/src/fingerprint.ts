// Error fingerprints. `fingerprint2` (fp2, the one the colony indexes) is a port of protocol/fingerprint_v2.py: a hash of
// the message alone, with the labels that wrap an error line dropped, because a searcher knows the line it holds and
// nothing reliable about the error type a trail's author declared. `fingerprint` (fp1: runtime, type and message) is
// the retired one, a port of protocol/fingerprint_v1.py. The shared vectors in protocol/fingerprint.v1.vectors.json and
// protocol/fingerprint.v2.vectors.json are normative; see test/fingerprint.test.mjs.

import { createHash } from "node:crypto";

export const PREFIX = "fp1_";
export const PREFIX_2 = "fp2_";
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

// Labels removed from the start of the message, one after another, at most MAX_LABELS of them. Matched on the text as
// written (before lowercasing): the capital letter is what tells a class name from a word. Exactly the pattern of
// protocol/fingerprint_v2.py.
const MAX_LABELS = 4;
const CLASS = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*(?:Error|Exception|Warning|Failure)`;
const SEVERITY =
  String.raw`(?:Error|ERROR|error|Fatal|FATAL|fatal|Warning|WARNING|warning|Panic|PANIC|panic|Exception|EXCEPTION|exception|Err|ERR|Caused by)` +
  String.raw`(?:\[[A-Za-z0-9_]+\])?`;
const TOOL_CODE = String.raw`(?:error|warning)\s+[A-Z]{1,5}[0-9]{2,5}`; // "error TS2322", "warning CS0168"
const LABEL = new RegExp(String.raw`^(?:(?:Uncaught\s+)?(?:${CLASS}|${SEVERITY}|${TOOL_CODE})\s*:\s+|npm\s+(?:ERR!|error)\s+)`);

/** Drop the leading exception classes, severity words and tool codes of an error line. */
export function stripLabels(message: string): string {
  let text = message;
  for (let i = 0; i < MAX_LABELS; i++) {
    const shorter = text.replace(LABEL, "");
    if (shorter === text) break;
    text = shorter;
  }
  return text;
}

/** fp2: strip everything that varies between machines or between wrappers, but not between errors. */
export function normalizeMessage2(message: string): string {
  let text = stripLabels(message.normalize("NFKC").trim()).toLowerCase();
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, MAX_NORMALIZED_CHARS).join("");
}

/**
 * The fingerprint the colony indexes: a hash of the error message alone. The key a trail is filed under is the one
 * a searcher computes from the line it holds.
 */
export function fingerprint2(message: string): string {
  return PREFIX_2 + createHash("sha256").update(normalizeMessage2(message), "utf8").digest("hex").slice(0, 16);
}

/** fp1, the retired fingerprint: the colony no longer indexes it. Use `fingerprint2`. */
export function fingerprint(runtime: string, errorType: string, message: string): string {
  const material = [runtime.trim().toLowerCase(), nfkcLower(errorType).trim(), normalizeMessage(errorType, message)].join(SEPARATOR);
  return PREFIX + createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/** `Type: message` → `Type`, for callers that only have the error line. */
export function guessErrorType(errorLine: string): string {
  const head = errorLine.split(":", 1)[0]?.trim() ?? "";
  return errorLine.includes(":") && head.length > 0 && head.length <= 64 && !head.includes(" ") ? head : "";
}
