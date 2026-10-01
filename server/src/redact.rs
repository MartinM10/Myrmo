//! Deterministic redaction of secrets and personal data. Runs on every string of a
//! payload; clients run the same detectors before sending.

use regex::{Captures, Regex};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

type Replacer = fn(&Captures) -> Option<String>;

struct Rule {
    kind: &'static str,
    pattern: Regex,
    /// Returns the replacement, or `None` to keep the match unchanged.
    replace: Replacer,
}

fn full(kind: &'static str) -> String {
    format!("<redacted:{kind}>")
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rule = |kind, pattern: &str, replace: Replacer| Rule {
        kind,
        pattern: Regex::new(pattern).expect("valid redaction rule"),
        replace,
    };
    vec![
        rule(
            "private_key",
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            |_| Some(full("private_key")),
        ),
        rule("api_key", r"\bsk-ant-[A-Za-z0-9_\-]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule(
            "api_key",
            r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}",
            |_| Some(full("api_key")),
        ),
        rule(
            "api_key",
            r"\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{22,}",
            |_| Some(full("api_key")),
        ),
        rule("api_key", r"\bglpat-[A-Za-z0-9_\-]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", r"\bAIza[0-9A-Za-z_\-]{35}", |_| {
            Some(full("api_key"))
        }),
        rule("api_key", r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}", |_| {
            Some(full("api_key"))
        }),
        rule("aws_access_key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", |_| {
            Some(full("aws_access_key"))
        }),
        rule(
            "aws_access_key",
            r#"(?i)(aws_secret_access_key\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}"#,
            |c| Some(format!("{}{}", &c[1], full("aws_access_key"))),
        ),
        rule(
            "jwt",
            r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
            |_| Some(full("jwt")),
        ),
        rule(
            "token",
            r"(?i)\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*",
            |c| Some(format!("{}{}", &c[1], full("token"))),
        ),
        rule(
            "connection_string",
            r"(?i)\b([a-z][a-z0-9+.\-]*://)[^:/\s@<>]+:[^@\s/<>]+@",
            |c| Some(format!("{}{}@", &c[1], full("connection_string"))),
        ),
        rule(
            "password_assignment",
            r#"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[=:]\s*)(['"]?)[^\s'",;<>]{4,}"#,
            |c| Some(format!("{}{}{}{}", &c[1], &c[2], &c[3], full("secret"))),
        ),
        rule(
            "email",
            r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
            |c| {
                // `git@github.com:org/repo` is an address form, not personal data.
                if c[0].starts_with("git@") {
                    None
                } else {
                    Some(full("email"))
                }
            },
        ),
        rule("ip", r"\b(?:\d{1,3}\.){3}\d{1,3}\b", |c| {
            let ip = &c[0];
            let valid = ip
                .split('.')
                .all(|octet| octet.parse::<u16>().is_ok_and(|n| n <= 255));
            let harmless = matches!(ip, "127.0.0.1" | "0.0.0.0" | "255.255.255.255");
            if valid && !harmless {
                Some(full("ip"))
            } else {
                None
            }
        }),
        rule(
            "phone",
            r"\+\d{1,3}[\s.\-]?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b",
            |_| Some(full("phone")),
        ),
        rule("home_path", r#"(/home/|/Users/)[^/\s'"<>]+"#, |c| {
            Some(format!("{}<user>", &c[1]))
        }),
        rule("home_path", r#"(?i)([a-z]:\\Users\\)[^\\\s'"<>]+"#, |c| {
            Some(format!("{}<user>", &c[1]))
        }),
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
            "postgres://<redacted:connection_string>@db.internal:5432/app"
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
}
