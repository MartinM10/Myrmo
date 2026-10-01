//! Error fingerprint v1. A port of `protocol/fingerprint_v1.py`; the shared test vectors
//! in `protocol/fingerprint.v1.vectors.json` are normative.

use fancy_regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

pub const PREFIX: &str = "fp1_";
const MAX_NORMALIZED_CHARS: usize = 300;
const SEPARATOR: &str = "\u{1f}";

/// Applied in order, exactly as in the reference implementation.
static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r#"\b[a-z][a-z0-9+.\-]*://[^\s'"<>]+"#, "<url>"),
        (r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<uuid>"),
        (r"\b0x[0-9a-f]+\b", "<hex>"),
        (r"\b[0-9a-f]{12,}\b", "<hex>"),
        (r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b", "<ip>"),
        (r#"\b[a-z]:\\[^\s'"]+"#, "<path>"),
        (r#"(?<![\w.<>])(?:~|\.{1,2})?/(?:[^\s'"/:]+/)*[^\s'"/:]*"#, "<path>"),
        (r"(?<![\w<>/])[\w.\-]+(?:/[\w.\-]+)+", "<path>"),
        (r"\b(?=[a-z_]*\d)(?=[0-9_]*[a-z])\w{12,}\b", "<id>"),
        (r"\bline \d+", "line <n>"),
        (r":\d+(?::\d+)?\b", ":<n>"),
        (r"\b\d{4,}\b", "<n>"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid fingerprint rule"), replacement))
    .collect()
});

static WHITESPACE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());

fn nfkc_lower(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

/// Strip everything that varies between machines but not between errors.
pub fn normalize_message(error_type: &str, message: &str) -> String {
    let mut text = nfkc_lower(message).trim().to_string();
    let prefix = format!("{}:", nfkc_lower(error_type).trim());
    if let Some(rest) = text.strip_prefix(&prefix) {
        text = rest.to_string();
    }
    for (pattern, replacement) in RULES.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    let collapsed = WHITESPACE.replace_all(&text, " ");
    collapsed.trim().chars().take(MAX_NORMALIZED_CHARS).collect()
}

pub fn fingerprint(runtime: &str, error_type: &str, message: &str) -> String {
    let material = [
        runtime.trim().to_lowercase(),
        nfkc_lower(error_type).trim().to_string(),
        normalize_message(error_type, message),
    ]
    .join(SEPARATOR);
    let digest = Sha256::digest(material.as_bytes());
    format!("{PREFIX}{}", &hex::encode(digest)[..16])
}

/// The message a trail is fingerprinted by: `error_message`, else the first line of
/// `raw_logs` containing `error_type`, else the first non-empty line.
pub fn message_for_problem(problem: &Value) -> String {
    if let Some(message) = problem.get("error_message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
        return message.to_string();
    }
    let error_type = problem.get("error_type").and_then(Value::as_str).unwrap_or_default();
    let logs = problem.get("raw_logs").and_then(Value::as_str).unwrap_or_default();
    logs.lines()
        .find(|line| !error_type.is_empty() && line.contains(error_type))
        .or_else(|| logs.lines().find(|line| !line.trim().is_empty()))
        .unwrap_or_default()
        .to_string()
}

/// Fingerprint of a protocol trail.
pub fn of_trail(trail: &Value) -> String {
    let runtime = trail.pointer("/environment/runtime/name").and_then(Value::as_str).unwrap_or_default();
    let problem = &trail["problem"];
    let error_type = problem.get("error_type").and_then(Value::as_str).unwrap_or_default();
    fingerprint(runtime, error_type, &message_for_problem(problem))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_vectors() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../protocol/fingerprint.v1.vectors.json")).unwrap();
        assert!(vectors.len() >= 16);
        for v in vectors {
            let (rt, et, msg) = (v["runtime"].as_str().unwrap(), v["error_type"].as_str().unwrap(), v["message"].as_str().unwrap());
            assert_eq!(normalize_message(et, msg), v["normalized"].as_str().unwrap(), "normalized: {msg}");
            assert_eq!(fingerprint(rt, et, msg), v["fingerprint"].as_str().unwrap(), "fingerprint: {msg}");
        }
    }

    #[test]
    fn falls_back_to_raw_logs() {
        let problem = serde_json::json!({
            "error_type": "ModuleNotFoundError",
            "raw_logs": "Collecting numpy\nModuleNotFoundError: No module named 'distutils'"
        });
        assert_eq!(message_for_problem(&problem), "ModuleNotFoundError: No module named 'distutils'");
    }
}
