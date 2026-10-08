//! Deterministic redaction of secrets and personal data. Runs on every string of a
//! payload; clients run the same detectors before sending.
//!
//! The rules are mirrored in clients/python/src/myrmo/redact.py and
//! clients/typescript/packages/myrmo/src/redact.ts: all three must reproduce
//! protocol/redact.v1.vectors.json exactly. Rules run in order, most specific first. A rule's
//! replacement never matches a later rule (it starts with `<`, which no value pattern accepts),
//! so redacting twice changes nothing.

use regex::{Captures, Regex};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// The replacement for a match, or `None` to keep the match unchanged.
type Replacer = Box<dyn Fn(&Captures) -> Option<String> + Send + Sync>;

struct Rule {
    kind: &'static str,
    pattern: Regex,
    replace: Replacer,
}

fn full(kind: &str) -> String {
    format!("<redacted:{kind}>")
}

fn g<'a>(c: &'a Captures, n: usize) -> &'a str {
    c.get(n).map_or("", |m| m.as_str())
}

// Values that are references or placeholders, not secrets. The test is narrow on purpose: a
// password may contain `(`, `$` or `/`, and leaking one costs far more than keeping a code
// fragment, so only unmistakable references are kept: `$DB_PASSWORD`, `${{ secrets.X }}`,
// `os.getenv(`, `get_secret()`, `None`, `****`, a URL, a path.
const LITERALS: &[&str] = &[
    "none",
    "null",
    "nil",
    "true",
    "false",
    "undefined",
    "required",
    "optional",
    "string",
    "str",
    "int",
    "integer",
    "bool",
    "boolean",
    "empty",
    "redacted",
    "password",
    "secret",
    "token",
];
static ENV_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$").unwrap()
});
static CODE_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][\w.]*(?:\(\)|[(\[])$").unwrap());

fn is_reference(value: &str) -> bool {
    let lower = value.to_lowercase();
    ENV_REFERENCE.is_match(value)
        || CODE_REFERENCE.is_match(value)
        || ["${", "{{", "[", "{"].iter().any(|p| value.starts_with(p))
        || ["http://", "https://", "./", "../", "~/"]
            .iter()
            .any(|p| lower.starts_with(p))
        || (value.starts_with('/') && value[1..].contains('/'))
        || LITERALS.contains(&lower.as_str())
        || value.chars().all(|c| "*xX.#-_".contains(c))
}

fn luhn(digits: &str) -> bool {
    let total: u32 = digits
        .chars()
        .rev()
        .enumerate()
        .map(|(i, ch)| {
            let n = ch.to_digit(10).unwrap_or(0);
            if !i.is_multiple_of(2) {
                let doubled = n * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                n
            }
        })
        .sum();
    total.is_multiple_of(10)
}

fn ip(c: &Captures) -> Option<String> {
    let ip = &c[0];
    let valid = ip
        .split('.')
        .all(|octet| octet.parse::<u16>().is_ok_and(|n| n <= 255));
    let harmless = matches!(ip, "127.0.0.1" | "0.0.0.0" | "255.255.255.255");
    (valid && !harmless).then(|| full("ip"))
}

fn card(c: &Captures) -> Option<String> {
    let digits: String = c[0].chars().filter(char::is_ascii_digit).collect();
    ((13..=19).contains(&digits.len()) && luhn(&digits)).then(|| full("card"))
}

/// `name = value` becomes `name = <redacted:kind>` unless the value is a reference.
fn keep_prefix(kind: &'static str, value_group: usize) -> Replacer {
    Box::new(move |c| {
        if is_reference(g(c, value_group)) {
            return None;
        }
        let prefix: String = (1..value_group).map(|n| g(c, n)).collect();
        Some(prefix + &full(kind))
    })
}

fn authorization(c: &Captures) -> Option<String> {
    let (prefix, scheme, value) = (g(c, 1), g(c, 2), g(c, 3));
    let schemes = [
        "bearer",
        "basic",
        "token",
        "digest",
        "negotiate",
        "ntlm",
        "hawk",
    ];
    if scheme.is_empty() && schemes.contains(&value.to_lowercase().as_str()) {
        return None; // `Bearer <redacted:token>`: the credential is already gone
    }
    if is_reference(value) {
        return None;
    }
    Some(format!("{prefix}{scheme}{}", full("auth_header")))
}

fn assignment(c: &Captures) -> Option<String> {
    if is_reference(g(c, 3)) {
        return None;
    }
    Some(format!("{}{}{}", g(c, 1), g(c, 2), full("secret")))
}

// Configuration values that name an organisation or a person: `edc.ui.organization=Acme`, `"owner": "Ana"`,
// `LABEL maintainer=...`. The key decides, never the value, because a name looks like any other word. A key
// matches only when its last part is one of these words, so `org.eclipse.edc:dcp-core` (a Maven coordinate) and
// `--org-id` are left alone. A product or connector `*.title` is included: it is usually the owner's brand.
const ORG_KEY: &str = r"(?:(?:[A-Za-z0-9_.\-]{0,64}[._\-])?(?:(?:organi[sz]ations?|org|compan(?:y|ies)|tenants?|customers?|owners?|authors?|contacts?|maintainers?|publishers?|vendors?|employers?)(?:[_.\-]?(?:name|title))?|(?:client|display|full|legal|trade|business|brand)[_.\-]?name)|(?:[A-Za-z0-9_.\-]{0,64}[._\-])?(?:connector|product|portal|brand|app|ui|site)[._\-](?:[A-Za-z0-9_.\-]{0,64}[._\-])?title)";
/// Values that are not a name: placeholders, types and generic words.
const ORG_KEEP: &[&str] = &[
    "default",
    "unknown",
    "example",
    "test",
    "testing",
    "user",
    "users",
    "admin",
    "administrator",
    "root",
    "me",
    "self",
    "system",
    "anonymous",
    "n/a",
    "na",
    "tbd",
    "todo",
    "unset",
    "any",
    "object",
    "dict",
    "list",
    "set",
    "array",
    "map",
    "number",
    "float",
    "date",
    "datetime",
    "name",
    "author",
    "owner",
    "org",
    "organization",
    "company",
    "customer",
    "tenant",
];

/// A type annotation such as `Optional[str]`, not a name.
static ORG_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*\[[A-Za-z0-9_., \[\]]*\]$").unwrap());

/// The key of a rule anchored to the start of a line cannot begin with `-`, or the `-Dkey=value` of a command
/// would take the rest of the command with it.
fn org_key_line() -> String {
    ORG_KEY.replace(
        r"[A-Za-z0-9_.\-]{0,64}[._\-]",
        r"[A-Za-z0-9_][A-Za-z0-9_.\-]{0,63}[._\-]",
    )
}

fn org_kept(value: &str, inline: bool) -> bool {
    let lower = value.to_lowercase();
    is_reference(value)
        || value.starts_with('<')
        || !value.chars().any(char::is_alphabetic)
        || ORG_TYPE.is_match(value)
        || ORG_KEEP.contains(&lower.as_str())
        || ["your", "example", "sample", "my-", "my_"]
            .iter()
            .any(|p| lower.starts_with(p))
        || (inline && value.chars().any(|c| "${}[]()*\\".contains(c)))
}

/// Replaces the value group with `<redacted:org>`, keeping every group before and after it.
fn org_value(value_group: usize, inline: bool) -> Replacer {
    Box::new(move |c| {
        if org_kept(g(c, value_group), inline) {
            return None;
        }
        Some(
            (1..c.len())
                .map(|n| {
                    if n == value_group {
                        full("org")
                    } else {
                        g(c, n).to_string()
                    }
                })
                .collect(),
        )
    })
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    fn rule(
        kind: &'static str,
        case_insensitive: bool,
        pattern: &str,
        replace: impl Fn(&Captures) -> Option<String> + Send + Sync + 'static,
    ) -> Rule {
        let source = if case_insensitive {
            format!("(?i){pattern}")
        } else {
            pattern.to_string()
        };
        Rule {
            kind,
            pattern: Regex::new(&source).expect("valid redaction rule"),
            replace: Box::new(replace),
        }
    }
    let line_key = org_key_line();
    vec![
        rule(
            "private_key",
            false,
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----",
            |_| Some(full("private_key")),
        ),
        rule(
            "private_key",
            false,
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\\n|\r?\n)[A-Za-z0-9+/=]{16,})*",
            |_| Some(full("private_key")),
        ),
        rule(
            "password_hash",
            false,
            r"\$(?:2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}|argon2(?:id|i|d)\$[^\s'\x22<>]{20,}|[156y]\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{20,})",
            |_| Some(full("password_hash")),
        ),
        rule("api_key", false, r"\bsk-ant-[A-Za-z0-9_\-]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule(
            "api_key",
            false,
            r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            false,
            r"\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}",
            |_| Some(full("api_key")),
        ),
        rule("api_key", false, r"\bglpat-[A-Za-z0-9_\-]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", false, r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", false, r"\bAIza[0-9A-Za-z_\-]{35}", |_| {
            Some(full("api_key"))
        }),
        rule(
            "api_key",
            false,
            r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}",
            |_| Some(full("api_key")),
        ),
        rule("api_key", false, r"\bnpm_[A-Za-z0-9]{36}\b", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", false, r"\bhf_[A-Za-z0-9]{30,}", |_| {
            Some(full("api_key"))
        }),
        rule(
            "api_key",
            false,
            r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            false,
            r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{40,}",
            |_| Some(full("api_key")),
        ),
        rule("api_key", false, r"\bya29\.[A-Za-z0-9_\-]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule(
            "api_key",
            false,
            r"\b(?:dckr_pat_|dop_v1_|gsk_|xai-|r8_|lin_api_|pplx-|shp(?:at|ca|pa|ss)_|whsec_|sq0(?:atp|csp)-|glptt-|glrt-|GOCSPX-)[A-Za-z0-9_\-]{16,}",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            false,
            r"\b(?:dapi|SK)[0-9a-f]{32}\b|\bkey-[0-9a-f]{32}\b",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            false,
            r"\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{36,})\b",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            true,
            r"\b((?:account|sharedaccess)key\s*=)[A-Za-z0-9+/=]{20,}",
            |c| Some(format!("{}{}", g(c, 1), full("api_key"))),
        ),
        rule(
            "aws_access_key",
            false,
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            |_| Some(full("aws_access_key")),
        ),
        rule(
            "aws_access_key",
            true,
            r"(aws_secret_access_key\s*[=:]\s*['\x22]?)[A-Za-z0-9/+=]{40}",
            |c| Some(format!("{}{}", g(c, 1), full("aws_access_key"))),
        ),
        rule(
            "webhook",
            true,
            r"https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}|https://(?:discord(?:app)?\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+|https://[a-z0-9.\-]*webhook\.office\.com/[^\s'\x22<>]+",
            |_| Some(full("webhook")),
        ),
        rule(
            "jwt",
            false,
            r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
            |_| Some(full("jwt")),
        ),
        rule(
            "token",
            true,
            r"\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*",
            |c| Some(format!("{}{}", g(c, 1), full("token"))),
        ),
        rule(
            "auth_header",
            true,
            r"\b((?:proxy-)?authorization['\x22]?[ \t]*[:=][ \t]*['\x22]?)((?:[A-Za-z][A-Za-z0-9_\-]*[ \t]+)?)([^\s'\x22,;<>]{6,})",
            authorization,
        ),
        rule(
            "auth_header",
            true,
            r"\b((?:x-api-key|x-auth-token|x-access-token|x-amz-security-token|x-csrf-token|x-xsrf-token|x-goog-api-key|x-gitlab-token|x-github-token|private-token|api-key|apikey)['\x22]?[ \t]*[:=][ \t]*['\x22]?)([^\s'\x22,;<>]{4,})",
            keep_prefix("auth_header", 2),
        ),
        rule(
            "cookie",
            true,
            r"\b((?:set-)?cookie['\x22]?[ \t]*:[ \t]*['\x22]?)([^\r\n'\x22<>]{6,})",
            |c| Some(format!("{}{}", g(c, 1), full("cookie"))),
        ),
        rule(
            "connection_string",
            true,
            r"\b([a-z][a-z0-9+.\-]{0,30}://)[^:/\s@<>]+:[^@\s/<>]+@",
            |c| Some(format!("{}{}@", g(c, 1), full("connection_string"))),
        ),
        rule(
            "connection_string",
            true,
            r"\b([a-z][a-z0-9+.\-]{0,30}://)[A-Za-z0-9_\-.~%]{20,}@",
            |c| Some(format!("{}{}@", g(c, 1), full("connection_string"))),
        ),
        rule(
            "url_secret",
            true,
            r"([?&;](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|secret|client_secret|password|passwd|pwd|sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|private_token|sessionid|jwt)=)([^&\s'\x22<>#]{4,})",
            keep_prefix("url_secret", 2),
        ),
        rule(
            "password_assignment",
            true,
            r"\b([\w.\-]{0,64}(?:password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|access[_-]?token|auth[_-]?token)[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{4,})",
            assignment,
        ),
        rule(
            "password_assignment",
            true,
            r"\b([\w.\-]{0,64}(?:token|credentials?|session[_-]?id|sessionid|csrf|xsrf)[\w.\-]{0,64}['\x22]?[ \t]*[=:][ \t]*)(['\x22]?)([^\s'\x22,;<>]{12,})",
            assignment,
        ),
        rule(
            "password_assignment",
            true,
            r"((?:^|\s)--?(?:password|passwd|pwd|pass|passphrase|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key)(?:=|[ \t]+))(['\x22]?)([^\s'\x22<>\-][^\s'\x22<>]{2,})",
            assignment,
        ),
        rule(
            "email",
            false,
            r"\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}\b",
            |c| {
                if c[0].starts_with("git@") {
                    None
                } else {
                    Some(full("email"))
                }
            },
        ),
        rule("ip", false, r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b", ip),
        rule(
            "ipv6",
            false,
            r"\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,5}:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4}\b",
            |_| Some(full("ipv6")),
        ),
        rule(
            "mac",
            false,
            r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b",
            |_| Some(full("mac")),
        ),
        rule(
            "hostname",
            true,
            r"(://|@)(?:[A-Za-z0-9\-]{1,63}\.){1,10}(?:internal|corp|intranet|lan|localdomain|home\.arpa|local)\b",
            |c| Some(format!("{}{}", g(c, 1), full("hostname"))),
        ),
        // An internal host name on its own, for example in a DNS error. It must end the name: `jdk.internal.misc`
        // and `com.acme.corp.Service` are Java packages, not hosts. `.local` is left out: it is also a file
        // suffix (`.env.local`), so it is only redacted inside URLs. The rule is listed twice because a match
        // consumes the character after it, which would hide a second host separated by a single space.
        rule(
            "hostname",
            true,
            r"(^|[^A-Za-z0-9.\-_])(?:[A-Za-z0-9\-]{1,63}\.){1,10}(?:internal|corp|intranet|lan|localdomain|home\.arpa)($|[^A-Za-z0-9.\-_]|\.\s)",
            |c| Some(format!("{}{}{}", g(c, 1), full("hostname"), g(c, 2))),
        ),
        rule(
            "hostname",
            true,
            r"(^|[^A-Za-z0-9.\-_])(?:[A-Za-z0-9\-]{1,63}\.){1,10}(?:internal|corp|intranet|lan|localdomain|home\.arpa)($|[^A-Za-z0-9.\-_]|\.\s)",
            |c| Some(format!("{}{}{}", g(c, 1), full("hostname"), g(c, 2))),
        ),
        rule(
            "phone",
            false,
            r"\+[0-9]{1,3}[\s.\-]?\(?[0-9]{2,4}\)?[\s.\-]?[0-9]{3,4}[\s.\-]?[0-9]{3,4}\b",
            |_| Some(full("phone")),
        ),
        rule("card", false, r"\b[3-6](?:[ \-]?[0-9]){12,18}\b", card),
        rule("home_path", false, r"(/home/|/Users/)[^/\s'\x22<>]+", |c| {
            Some(format!("{}<user>", g(c, 1)))
        }),
        rule(
            "home_path",
            true,
            r"([a-z]:\\Users\\)[^\\\s'\x22<>]+",
            |c| Some(format!("{}<user>", g(c, 1))),
        ),
        // The org rules come last: they match on the key, so every more specific kind has already had its turn.
        rule(
            "org",
            true,
            &format!(
                r"(^|[^A-Za-z0-9_.\-])({ORG_KEY}['\x22]?[ \t]*[=:][ \t]*)(['\x22])([^'\x22\r\n]{{2,120}})(['\x22])"
            ),
            org_value(4, false),
        ),
        rule(
            "org",
            true,
            &format!(
                r"(?m)(^[ \t]*(?:-[ \t]+)?{line_key}['\x22]?[ \t]*[=:][ \t]*)([^\s'\x22<>][^\r\n]*?)([ \t]*\r?$)"
            ),
            org_value(2, false),
        ),
        rule(
            "org",
            true,
            &format!(
                r"(^|[^A-Za-z0-9_.\-])({ORG_KEY}['\x22]?[ \t]*[=:][ \t]*)([^\s'\x22<>,;]{{2,80}})"
            ),
            org_value(3, true),
        ),
    ]
});

/// Kinds of data removed, with counts.
pub type Report = BTreeMap<&'static str, usize>;

pub fn redact_str(input: &str, report: &mut Report) -> String {
    let mut text = input.to_string();
    for rule in RULES.iter() {
        if !rule.pattern.is_match(&text) {
            continue;
        }
        let mut hits = 0usize;
        text = rule
            .pattern
            .replace_all(&text, |c: &Captures| match (rule.replace)(c) {
                Some(replacement) => {
                    hits += 1;
                    replacement
                }
                None => c[0].to_string(),
            })
            .into_owned();
        if hits > 0 {
            *report.entry(rule.kind).or_default() += hits;
        }
    }
    text
}

/// Redact every string inside a JSON value in place.
pub fn redact_value(value: &mut Value, report: &mut Report) {
    match value {
        Value::String(s) => {
            let redacted = redact_str(s, report);
            if redacted != *s {
                *s = redacted;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| redact_value(v, report)),
        Value::Object(map) => map.values_mut().for_each(|v| redact_value(v, report)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> (String, Report) {
        let mut report = Report::new();
        (redact_str(s, &mut report), report)
    }

    #[test]
    fn removes_secrets() {
        let (out, rep) = r("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
        assert!(!out.contains("sk-ant-api03"), "{out}");
        assert!(rep.contains_key("api_key") || rep.contains_key("password_assignment"));

        let (out, _) = r("AKIAIOSFODNN7EXAMPLE used");
        assert_eq!(out, "<redacted:aws_access_key> used");

        let (out, _) = r("postgres://admin:hunter2@db.internal:5432/app");
        assert_eq!(
            out,
            "postgres://<redacted:connection_string>@<redacted:hostname>:5432/app"
        );

        let (out, _) = r("password=SuperSecret123 next");
        assert_eq!(out, "password=<redacted:secret> next");

        let (out, _) = r("Authorization: Bearer abcdefghijklmnop1234567890");
        assert_eq!(out, "Authorization: Bearer <redacted:token>");

        let (out, _) =
            r("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----");
        assert_eq!(out, "<redacted:private_key>");
    }

    #[test]
    fn removes_personal_data() {
        assert_eq!(
            r("mail ana.garcia@acme.com now").0,
            "mail <redacted:email> now"
        );
        assert_eq!(
            r("git@github.com:org/repo.git").0,
            "git@github.com:org/repo.git"
        );
        assert_eq!(r("connect 10.0.3.17:5432").0, "connect <redacted:ip>:5432");
        assert_eq!(r("listen 127.0.0.1:8080").0, "listen 127.0.0.1:8080");
        assert_eq!(r("version 10.0.26100.1").0, "version 10.0.26100.1");
        assert_eq!(
            r("File \"/home/martin/app/x.py\"").0,
            "File \"/home/<user>/app/x.py\""
        );
        assert_eq!(
            r(r"C:\Users\ana\proj\cfg.yaml").0,
            r"C:\Users\<user>\proj\cfg.yaml"
        );
    }

    #[test]
    fn redacts_nested_json_and_is_idempotent() {
        let mut v = serde_json::json!({"a": ["token=abcd1234efgh", {"b": "ok"}]});
        let mut rep = Report::new();
        redact_value(&mut v, &mut rep);
        let once = v.clone();
        redact_value(&mut v, &mut Report::new());
        assert_eq!(v, once);
        assert_eq!(v["a"][1]["b"], "ok");
    }

    #[test]
    fn matches_every_normative_vector() {
        #[derive(serde::Deserialize)]
        struct Vector {
            input: String,
            output: String,
            kinds: BTreeMap<String, usize>,
        }
        let vectors: Vec<Vector> =
            serde_json::from_str(include_str!("../../protocol/redact.v1.vectors.json")).unwrap();
        assert!(vectors.len() >= 100);
        for v in vectors {
            let mut report = Report::new();
            let out = redact_str(&v.input, &mut report);
            assert_eq!(out, v.output, "output for {:?}", v.input);
            let kinds: BTreeMap<String, usize> =
                report.iter().map(|(k, n)| (k.to_string(), *n)).collect();
            assert_eq!(kinds, v.kinds, "kinds for {:?}", v.input);
            assert_eq!(
                redact_str(&out, &mut Report::new()),
                out,
                "idempotent for {:?}",
                v.input
            );
        }
    }
}
