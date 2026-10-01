// Client-side redaction: the same detectors the colony runs, applied before anything
// leaves the machine. Keep in sync with server/src/redact.rs.

export type RedactionReport = Record<string, number>;

type Replacer = (match: string, ...groups: string[]) => string | null;

interface Rule {
  kind: string;
  pattern: RegExp;
  replace: Replacer;
}

const full = (kind: string) => `<redacted:${kind}>`;
const r = (kind: string, source: string, flags: string, replace: Replacer): Rule => ({
  kind,
  pattern: new RegExp(source, `g${flags}`),
  replace,
});

const RULES: Rule[] = [
  r("private_key", String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`, "", () => full("private_key")),
  r("api_key", String.raw`\bsk-ant-[A-Za-z0-9_\-]{20,}`, "", () => full("api_key")),
  r("api_key", String.raw`\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}`, "", () => full("api_key")),
  r("api_key", String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}`, "", () => full("api_key")),
  r("api_key", String.raw`\bglpat-[A-Za-z0-9_\-]{20,}`, "", () => full("api_key")),
  r("api_key", String.raw`\bxox[abprs]-[A-Za-z0-9\-]{10,}`, "", () => full("api_key")),
  r("api_key", String.raw`\bAIza[0-9A-Za-z_\-]{35}`, "", () => full("api_key")),
  r("api_key", String.raw`\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}`, "", () => full("api_key")),
  r("aws_access_key", String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, "", () => full("aws_access_key")),
  r("aws_access_key", String.raw`(aws_secret_access_key\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}`, "i", (_m, p) => `${p}${full("aws_access_key")}`),
  r("jwt", String.raw`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`, "", () => full("jwt")),
  r("token", String.raw`\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*`, "i", (_m, p) => `${p}${full("token")}`),
  r("connection_string", String.raw`\b([a-z][a-z0-9+.\-]*:\/\/)[^:/\s@<>]+:[^@\s/<>]+@`, "i", (_m, scheme) => `${scheme}${full("connection_string")}@`),
  r(
    "password_assignment",
    String.raw`\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[=:]\s*)(['"]?)[^\s'",;<>]{4,}`,
    "i",
    (_m, key, sep, quote) => `${key}${sep}${quote}${full("secret")}`,
  ),
  r("email", String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`, "", (m) => (m.startsWith("git@") ? null : full("email"))),
  r("ip", String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`, "", (m) => {
    const valid = m.split(".").every((octet) => Number(octet) <= 255);
    const harmless = m === "127.0.0.1" || m === "0.0.0.0" || m === "255.255.255.255";
    return valid && !harmless ? full("ip") : null;
  }),
  r("phone", String.raw`\+\d{1,3}[\s.\-]?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b`, "", () => full("phone")),
  r("home_path", String.raw`(\/home\/|\/Users\/)[^/\s'"<>]+`, "", (_m, prefix) => `${prefix}<user>`),
  r("home_path", String.raw`([a-z]:\\Users\\)[^\\\s'"<>]+`, "i", (_m, prefix) => `${prefix}<user>`),
];

export function redactText(input: string, report: RedactionReport = {}): string {
  let text = input;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    let hits = 0;
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g): g is string => typeof g === "string" || g === undefined).slice(0, -1) as string[];
      const replacement = rule.replace(match, ...groups.map((g) => g ?? ""));
      if (replacement === null) return match;
      hits++;
      return replacement;
    });
    if (hits) report[rule.kind] = (report[rule.kind] ?? 0) + hits;
  }
  return text;
}

/** Deep copy of `value` with every string redacted. */
export function redactValue<T>(value: T, report: RedactionReport = {}): T {
  if (typeof value === "string") return redactText(value, report) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, report)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, report)])) as T;
  }
  return value;
}
