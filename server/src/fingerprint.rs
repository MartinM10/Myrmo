//! Error fingerprints. `fp2` (the one the colony indexes) is a port of `protocol/fingerprint_v2.py`: a hash of the
//! message alone, with the labels that wrap an error line dropped. `fp1` (runtime, error type and message) is kept
//! as the reference of the older spec, `protocol/fingerprint_v1.py`, and is only built for its test vectors.
//! The shared vectors, `protocol/fingerprint.v1.vectors.json` and `protocol/fingerprint.v2.vectors.json`, are normative.

use fancy_regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// The fingerprint the colony indexes.
pub const PREFIX: &str = "fp2_";
/// The retired fingerprint: still a valid name, never indexed (see `by_fingerprint`).
pub const PREFIX_V1: &str = "fp1_";
/// Prefix of [`solution_fingerprint`]. Server-side only: it is not part of the wire protocol.
pub const SOLUTION_PREFIX: &str = "sf1_";
const MAX_NORMALIZED_CHARS: usize = 300;
const SEPARATOR: &str = "\u{1f}";

/// Applied in order, exactly as in the reference implementation.
static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r#"\b[a-z][a-z0-9+.\-]*://[^\s'"<>]+"#, "<url>"),
        (
            r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
            "<uuid>",
        ),
        (r"\b0x[0-9a-f]+\b", "<hex>"),
        (r"\b[0-9a-f]{12,}\b", "<hex>"),
        (r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b", "<ip>"),
        (r#"\b[a-z]:\\[^\s'"]+"#, "<path>"),
        (
            r#"(?<![\w.<>])(?:~|\.{1,2})?/(?:[^\s'"/:]+/)*[^\s'"/:]*"#,
            "<path>",
        ),
        (r"(?<![\w<>/])[\w.\-]+(?:/[\w.\-]+)+", "<path>"),
        (r"\b(?=[a-z_]*\d)(?=[0-9_]*[a-z])\w{12,}\b", "<id>"),
        (r"\bline \d+", "line <n>"),
        (r":\d+(?::\d+)?\b", ":<n>"),
        (r"\b\d{4,}\b", "<n>"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| {
        (
            Regex::new(pattern).expect("valid fingerprint rule"),
            replacement,
        )
    })
    .collect()
});

static WHITESPACE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());

#[cfg(test)]
fn nfkc_lower(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

/// The volatile tokens and whitespace of a message, shared by fp1 and fp2.
fn apply_rules(mut text: String) -> String {
    for (pattern, replacement) in RULES.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    let collapsed = WHITESPACE.replace_all(&text, " ");
    collapsed
        .trim()
        .chars()
        .take(MAX_NORMALIZED_CHARS)
        .collect()
}

/// fp1: strip everything that varies between machines but not between errors.
#[cfg(test)]
pub fn normalize_message(error_type: &str, message: &str) -> String {
    let mut text = nfkc_lower(message).trim().to_string();
    let prefix = format!("{}:", nfkc_lower(error_type).trim());
    if let Some(rest) = text.strip_prefix(&prefix) {
        text = rest.to_string();
    }
    apply_rules(text)
}

/// Labels that wrap an error line, matched on the text as written: the capital letter is what tells a class name
/// from a word. Exactly the pattern of `protocol/fingerprint_v2.py`.
const CLASS: &str =
    r"(?:[A-Za-z_][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*(?:Error|Exception|Warning|Failure)";
const SEVERITY: &str = r"(?:Error|ERROR|error|Fatal|FATAL|fatal|Warning|WARNING|warning|Panic|PANIC|panic|Exception|EXCEPTION|exception|Err|ERR|Caused by)(?:\[[A-Za-z0-9_]+\])?";
const TOOL_CODE: &str = r"(?:error|warning)\s+[A-Z]{1,5}[0-9]{2,5}";
/// At most this many labels are dropped from the start of a message.
const MAX_LABELS: usize = 4;

static LABEL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(&format!(
        r"^(?:(?:Uncaught\s+)?(?:{CLASS}|{SEVERITY}|{TOOL_CODE})\s*:\s+|npm\s+(?:ERR!|error)\s+)"
    ))
    .expect("valid label pattern")
});

/// Drop the leading exception classes, severity words and tool codes of an error line.
fn strip_labels(message: &str) -> String {
    let mut text = message.to_string();
    for _ in 0..MAX_LABELS {
        let shorter = LABEL.replace(&text, "").into_owned();
        if shorter == text {
            break;
        }
        text = shorter;
    }
    text
}

/// fp2: strip what varies between machines or between wrappers, but not between errors.
pub fn normalize_message_v2(message: &str) -> String {
    let nfkc: String = message.nfkc().collect();
    apply_rules(strip_labels(nfkc.trim()).to_lowercase())
}

/// The fingerprint the colony indexes: the message alone. A searcher knows the error line it holds and nothing
/// reliable about the error type the trail's author declared, so only the line goes into the key.
pub fn fingerprint2(message: &str) -> String {
    let digest = Sha256::digest(normalize_message_v2(message).as_bytes());
    format!("{PREFIX}{}", &hex::encode(digest)[..16])
}

/// fp1, the retired fingerprint. Kept for its vectors.
#[cfg(test)]
pub fn fingerprint(runtime: &str, error_type: &str, message: &str) -> String {
    let material = [
        runtime.trim().to_lowercase(),
        nfkc_lower(error_type).trim().to_string(),
        normalize_message(error_type, message),
    ]
    .join(SEPARATOR);
    let digest = Sha256::digest(material.as_bytes());
    format!("{PREFIX_V1}{}", &hex::encode(digest)[..16])
}

/// Trailing whitespace and line endings never change what a command or a patch does.
fn normalize_lines(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Identifies *what a trail does*, as opposed to [`fingerprint`], which identifies the error it
/// fixes. Two trails for the same error are the same solution only when they run the same commands
/// and apply the same patches; wording (purpose, steps, root cause) is ignored. Trails with
/// neither commands nor patches fall back to their steps.
pub fn solution_fingerprint(trail: &Value) -> String {
    let items = |key: &str| {
        trail
            .pointer(&format!("/solution/{key}"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let text = |v: &Value, key: &str| {
        normalize_lines(v.get(key).and_then(Value::as_str).unwrap_or_default())
    };
    // Commands are ordered; patches are not.
    let mut parts: Vec<String> = items("shell_commands_executed")
        .iter()
        .map(|c| format!("cmd:{}", text(c, "command")))
        .collect();
    let mut patches: Vec<String> = items("code_patches")
        .iter()
        .map(|p| format!("patch:{}:{}", text(p, "file_path"), text(p, "diff")))
        .collect();
    patches.sort();
    parts.extend(patches);
    if parts.is_empty() {
        parts = items("steps")
            .iter()
            .map(|s| {
                format!(
                    "step:{}",
                    normalize_lines(s.as_str().unwrap_or_default()).to_lowercase()
                )
            })
            .collect();
    }
    let digest = Sha256::digest(parts.join(SEPARATOR).as_bytes());
    format!("{SOLUTION_PREFIX}{}", &hex::encode(digest)[..16])
}

/// The message a trail is fingerprinted by: `error_message`, else the first line of
/// `raw_logs` containing `error_type`, else the first non-empty line.
pub fn message_for_problem(problem: &Value) -> String {
    if let Some(message) = problem
        .get("error_message")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
    {
        return message.to_string();
    }
    let error_type = problem
        .get("error_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let logs = problem
        .get("raw_logs")
        .and_then(Value::as_str)
        .unwrap_or_default();
    logs.lines()
        .find(|line| !error_type.is_empty() && line.contains(error_type))
        .or_else(|| logs.lines().find(|line| !line.trim().is_empty()))
        .unwrap_or_default()
        .to_string()
}

/// Fingerprint of a protocol trail: its error message, as a searcher would hold it.
pub fn of_trail(trail: &Value) -> String {
    fingerprint2(&message_for_problem(&trail["problem"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_vectors() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../protocol/fingerprint.v1.vectors.json"))
                .unwrap();
        assert!(vectors.len() >= 16);
        for v in vectors {
            let (rt, et, msg) = (
                v["runtime"].as_str().unwrap(),
                v["error_type"].as_str().unwrap(),
                v["message"].as_str().unwrap(),
            );
            assert_eq!(
                normalize_message(et, msg),
                v["normalized"].as_str().unwrap(),
                "normalized: {msg}"
            );
            assert_eq!(
                fingerprint(rt, et, msg),
                v["fingerprint"].as_str().unwrap(),
                "fingerprint: {msg}"
            );
        }
    }

    #[test]
    fn matches_the_fp2_reference_vectors() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../protocol/fingerprint.v2.vectors.json"))
                .unwrap();
        assert!(vectors.len() >= 40);
        for v in &vectors {
            let msg = v["message"].as_str().unwrap();
            assert_eq!(
                normalize_message_v2(msg),
                v["normalized"].as_str().unwrap(),
                "normalized: {msg}"
            );
            assert_eq!(
                fingerprint2(msg),
                v["fingerprint"].as_str().unwrap(),
                "fingerprint: {msg}"
            );
        }
    }

    #[test]
    fn a_trail_is_filed_under_the_key_a_searcher_computes_from_its_message() {
        let trail = serde_json::json!({
            "environment": { "runtime": { "name": "java" } },
            "problem": {
                "error_type": "IllegalStateException",
                "error_message": "java.util.concurrent.CompletionException: java.lang.IllegalStateException: Recursive update"
            }
        });
        let key = of_trail(&trail);
        assert!(key.starts_with(PREFIX));
        for line in [
            "java.util.concurrent.CompletionException: java.lang.IllegalStateException: Recursive update",
            "IllegalStateException: Recursive update",
            "Caused by: java.lang.IllegalStateException: Recursive update",
        ] {
            assert_eq!(fingerprint2(line), key, "{line}");
        }
        // Neither the runtime nor the declared type is part of the key.
        let other = serde_json::json!({
            "environment": { "runtime": { "name": "jvm" } },
            "problem": { "error_type": "something else", "error_message": "Recursive update" }
        });
        assert_eq!(of_trail(&other), key);
    }

    fn trail(commands: &[&str], patches: &[(&str, &str)], purpose: &str) -> Value {
        serde_json::json!({ "solution": {
            "root_cause": purpose,
            "steps": [purpose],
            "shell_commands_executed": commands.iter().map(|c| serde_json::json!({"command": c, "purpose": purpose})).collect::<Vec<_>>(),
            "code_patches": patches.iter().map(|(f, d)| serde_json::json!({"file_path": f, "diff": d})).collect::<Vec<_>>(),
        }})
    }

    #[test]
    fn solution_fingerprint_ignores_wording_whitespace_and_patch_order() {
        let a = trail(
            &["pip install 'numpy>=1.26'"],
            &[("a.txt", "+1\n"), ("b.txt", "+2\n")],
            "first wording",
        );
        let b = trail(
            &["pip install 'numpy>=1.26'  "],
            &[("b.txt", "+2\r\n"), ("a.txt", "+1")],
            "another wording",
        );
        assert_eq!(solution_fingerprint(&a), solution_fingerprint(&b));
        assert!(solution_fingerprint(&a).starts_with(SOLUTION_PREFIX));
    }

    #[test]
    fn solution_fingerprint_tells_different_solutions_apart() {
        let base = trail(&["pip install numpy"], &[], "w");
        assert_ne!(
            solution_fingerprint(&base),
            solution_fingerprint(&trail(&["pip install numpy==1.0"], &[], "w"))
        );
        assert_ne!(
            solution_fingerprint(&base),
            solution_fingerprint(&trail(&["pip install numpy"], &[("a.txt", "+1")], "w"))
        );
        // Command order matters.
        assert_ne!(
            solution_fingerprint(&trail(&["a", "b"], &[], "w")),
            solution_fingerprint(&trail(&["b", "a"], &[], "w"))
        );
        // Without commands or patches, the steps decide.
        assert_ne!(
            solution_fingerprint(&trail(&[], &[], "do this")),
            solution_fingerprint(&trail(&[], &[], "do that"))
        );
        assert_eq!(
            solution_fingerprint(&trail(&[], &[], "Do This")),
            solution_fingerprint(&trail(&[], &[], "do this"))
        );
    }

    #[test]
    fn falls_back_to_raw_logs() {
        let problem = serde_json::json!({
            "error_type": "ModuleNotFoundError",
            "raw_logs": "Collecting numpy\nModuleNotFoundError: No module named 'distutils'"
        });
        assert_eq!(
            message_for_problem(&problem),
            "ModuleNotFoundError: No module named 'distutils'"
        );
    }
}
