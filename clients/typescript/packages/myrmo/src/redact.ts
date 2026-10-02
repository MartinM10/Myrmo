// Client-side redaction: the same detectors the colony runs, applied before anything leaves the
// machine. Keep in sync with server/src/redact.rs and clients/python/src/myrmo/redact.py: all
// three must reproduce protocol/redact.v1.vectors.json exactly.
//
// Rules run in order, most specific first. A rule's replacement never matches a later rule (it
// starts with `<`, which no value pattern accepts), so redacting twice changes nothing.

export type RedactionReport = Record<string, number>;

/** `m[0]` is the whole match, `m[1..]` its groups (empty string when a group did not take part). */
type Replacer = (m: string[]) => string | null;

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
const fixed = (kind: string): Replacer => () => full(kind);

// Values that are references or placeholders, not secrets. The test is narrow on purpose: a
// password may contain `(`, `$` or `/`, and leaking one costs far more than keeping a code
// fragment, so only unmistakable references are kept: `$DB_PASSWORD`, `${{ secrets.X }}`,
// `os.getenv(`, `get_secret()`, `None`, `****`, a URL, a path.
const LITERALS = new Set([
  "none", "null", "nil", "true", "false", "undefined", "required", "optional", "string", "str",
  "int", "integer", "bool", "boolean", "empty", "redacted", "password", "secret", "token",
]);
const ENV_REFERENCE = /^(?:\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const CODE_REFERENCE = /^[A-Za-z_][\w.]*(?:\(\)|[(\[])$/;

function isReference(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    ENV_REFERENCE.test(value) ||
    CODE_REFERENCE.test(value) ||
    ["${", "{{", "[", "{"].some((p) => value.startsWith(p)) ||
    ["http://", "https://", "./", "../", "~/"].some((p) => lower.startsWith(p)) ||
    (value.startsWith("/") && value.slice(1).includes("/")) ||
    LITERALS.has(lower) ||
    [...value].every((c) => "*xX.#-_".includes(c))
  );
}

function luhn(digits: string): boolean {
  let total = 0;
  [...digits].reverse().forEach((ch, i) => {
    let n = Number(ch);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  });
  return total % 10 === 0;
}

const ip: Replacer = ([m]) => {
  const valid = m.split(".").every((octet) => Number(octet) <= 255);
  const harmless = m === "127.0.0.1" || m === "0.0.0.0" || m === "255.255.255.255";
  return valid && !harmless ? full("ip") : null;
};

const card: Replacer = ([m]) => {
  const digits = m.replace(/[^0-9]/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? full("card") : null;
};

/** `name = value` becomes `name = <redacted:kind>` unless the value is a reference. */
const keepPrefix = (kind: string, valueGroup: number): Replacer => (m) =>
  isReference(m[valueGroup]) ? null : m.slice(1, valueGroup).join("") + full(kind);

const SCHEMES = ["bearer", "basic", "token", "digest", "negotiate", "ntlm", "hawk"];
const authorization: Replacer = (m) => {
  const [, prefix, scheme, value] = m;
  if (!scheme && SCHEMES.includes(value.toLowerCase())) return null; // `Bearer <redacted:token>`: already gone
  if (isReference(value)) return null;
  return prefix + scheme + full("auth_header");
};

const NAMES_STRONG =
  "password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|" +
  "signing[_-]?key|encryption[_-]?key|access[_-]?token|auth[_-]?token";
const NAMES_WEAK = "token|credentials?|session[_-]?id|sessionid|csrf|xsrf";
const CLI_NAMES =
  "password|passwd|pwd|pass|passphrase|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|" +
  "client[_-]?secret|private[_-]?key";
const assignment: Replacer = (m) => (isReference(m[3]) ? null : m[1] + m[2] + full("secret"));

const RULES: Rule[] = [
  // Private keys, whole or cut off by a truncated log.
  r("private_key", String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`, "", fixed("private_key")),
  r("private_key", String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\\n|\r?\n)[A-Za-z0-9+/=]{16,})*`, "", fixed("private_key")),
  // Password hashes: bcrypt, argon2, crypt(3).
  r("password_hash", String.raw`\$(?:2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}|argon2(?:id|i|d)\$[^\s'\x22<>]{20,}|[156y]\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{20,})`, "", fixed("password_hash")),
  // Provider tokens.
  r("api_key", String.raw`\bsk-ant-[A-Za-z0-9_\-]{20,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bglpat-[A-Za-z0-9_\-]{20,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bxox[abprs]-[A-Za-z0-9\-]{10,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bAIza[0-9A-Za-z_\-]{35}`, "", fixed("api_key")),
  r("api_key", String.raw`\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bnpm_[A-Za-z0-9]{36}\b`, "", fixed("api_key")),
  r("api_key", String.raw`\bhf_[A-Za-z0-9]{30,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{40,}`, "", fixed("api_key")),
  r("api_key", String.raw`\bya29\.[A-Za-z0-9_\-]{20,}`, "", fixed("api_key")),
  r("api_key", String.raw`\b(?:dckr_pat_|dop_v1_|gsk_|xai-|r8_|lin_api_|pplx-|shp(?:at|ca|pa|ss)_|whsec_|sq0(?:atp|csp)-|glptt-|glrt-|GOCSPX-)[A-Za-z0-9_\-]{16,}`, "", fixed("api_key")),
  r("api_key", String.raw`\b(?:dapi|SK)[0-9a-f]{32}\b|\bkey-[0-9a-f]{32}\b`, "", fixed("api_key")),
  r("api_key", String.raw`\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{36,})\b`, "", fixed("api_key")),
  r("api_key", String.raw`\b((?:account|sharedaccess)key\s*=)[A-Za-z0-9+/=]{20,}`, "i", (m) => m[1] + full("api_key")),
  r("aws_access_key", String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, "", fixed("aws_access_key")),
  r("aws_access_key", String.raw`(aws_secret_access_key\s*[=:]\s*['\x22]?)[A-Za-z0-9/+=]{40}`, "i", (m) => m[1] + full("aws_access_key")),
  r("webhook", String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}|https://(?:discord(?:app)?\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+|https://[a-z0-9.\-]*webhook\.office\.com/[^\s'\x22<>]+`, "i", fixed("webhook")),
  r("jwt", String.raw`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`, "", fixed("jwt")),
  r("token", String.raw`\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*`, "i", (m) => m[1] + full("token")),
  // Headers.
  r("auth_header", String.raw`\b((?:proxy-)?authorization['\x22]?[ \t]*[:=][ \t]*['\x22]?)((?:[A-Za-z][A-Za-z0-9_\-]*[ \t]+)?)([^\s'\x22,;<>]{6,})`, "i", authorization),
  r("auth_header", String.raw`\b((?:x-api-key|x-auth-token|x-access-token|x-amz-security-token|x-csrf-token|x-xsrf-token|x-goog-api-key|x-gitlab-token|x-github-token|private-token|api-key|apikey)['\x22]?[ \t]*[:=][ \t]*['\x22]?)([^\s'\x22,;<>]{4,})`, "i", keepPrefix("auth_header", 2)),
  r("cookie", String.raw`\b((?:set-)?cookie['\x22]?[ \t]*:[ \t]*['\x22]?)([^\r\n'\x22<>]{6,})`, "i", (m) => m[1] + full("cookie")),
  // Credentials inside URLs.
  r("connection_string", String.raw`\b([a-z][a-z0-9+.\-]{0,30}:\/\/)[^:/\s@<>]+:[^@\s/<>]+@`, "i", (m) => `${m[1]}${full("connection_string")}@`),
  r("connection_string", String.raw`\b([a-z][a-z0-9+.\-]{0,30}:\/\/)[A-Za-z0-9_\-.~%]{20,}@`, "i", (m) => `${m[1]}${full("connection_string")}@`),
  r("url_secret", String.raw`([?&;](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|secret|client_secret|password|passwd|pwd|sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|private_token|sessionid|jwt)=)([^&\s'\x22<>#]{4,})`, "i", keepPrefix("url_secret", 2)),
  // `name = value`, in code, config, JSON, env files and command lines.
  r("password_assignment", String.raw`\b([\w.\-]{0,64}(?:${NAMES_STRONG})[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{4,})`, "i", assignment),
  r("password_assignment", String.raw`\b([\w.\-]{0,64}(?:${NAMES_WEAK})[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{12,})`, "i", assignment),
  r("password_assignment", String.raw`((?:^|\s)--?(?:${CLI_NAMES})(?:=|[ \t]+))(['\x22]?)([^\s'\x22<>\-][^\s'\x22<>]{2,})`, "i", assignment),
  // Personal data.
  r("email", String.raw`\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}\b`, "", ([m]) => (m.startsWith("git@") ? null : full("email"))),
  r("ip", String.raw`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`, "", ip),
  r("ipv6", String.raw`\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,5}:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4}\b`, "", fixed("ipv6")),
  r("mac", String.raw`\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b`, "", fixed("mac")),
  r("hostname", String.raw`(:\/\/|@)(?:[A-Za-z0-9\-]{1,63}\.){1,10}(?:internal|corp|intranet|lan|localdomain|home\.arpa|local)\b`, "i", (m) => m[1] + full("hostname")),
  r("phone", String.raw`\+[0-9]{1,3}[\s.\-]?\(?[0-9]{2,4}\)?[\s.\-]?[0-9]{3,4}[\s.\-]?[0-9]{3,4}\b`, "", fixed("phone")),
  r("card", String.raw`\b[3-6](?:[ \-]?[0-9]){12,18}\b`, "", card),
  r("home_path", String.raw`(\/home\/|\/Users\/)[^/\s'\x22<>]+`, "", (m) => `${m[1]}<user>`),
  r("home_path", String.raw`([a-z]:\\Users\\)[^\\\s'\x22<>]+`, "i", (m) => `${m[1]}<user>`),
];

export function redactText(input: string, report: RedactionReport = {}): string {
  let text = input;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    let hits = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      // args: match, group 1..n, offset, whole string (the patterns have no named groups).
      const groups = (args.slice(0, -2) as (string | undefined)[]).map((g) => g ?? "");
      const replacement = rule.replace(groups);
      if (replacement === null) return groups[0];
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
