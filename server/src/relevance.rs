//! Is a semantic hit about the same problem, or only shaped like it?
//!
//! The embedding model scores "No module named 'foo'" close to "No module named 'bar'": the sentence
//! is the same and only the name differs, and the name is what matters. So a semantic hit must share
//! at least one distinctive word with the query (a module, a package, a code), unless the match is
//! nearly identical. Exact fingerprint hits are not filtered: they are the same error by construction.

use serde_json::Value;
use std::collections::HashSet;

/// Above this similarity the texts are close enough that a different spelling of a word is not a signal.
pub const HIGH_CONFIDENCE: f64 = 0.92;

/// Words that appear in almost every error and say nothing about which one it is.
const GENERIC: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "was",
    "were",
    "are",
    "has",
    "have",
    "had",
    "been",
    "its",
    "not",
    "but",
    "when",
    "while",
    "after",
    "before",
    "during",
    "into",
    "onto",
    "over",
    "under",
    "than",
    "then",
    "can",
    "could",
    "would",
    "should",
    "does",
    "did",
    "get",
    "got",
    "any",
    "all",
    "out",
    "off",
    "use",
    "using",
    "used",
    "run",
    "running",
    "ran",
    "error",
    "errors",
    "exception",
    "exceptions",
    "fail",
    "fails",
    "failed",
    "failing",
    "failure",
    "cannot",
    "cant",
    "unable",
    "unexpected",
    "invalid",
    "found",
    "such",
    "file",
    "files",
    "directory",
    "module",
    "modules",
    "named",
    "name",
    "import",
    "imports",
    "require",
    "required",
    "missing",
    "undefined",
    "null",
    "none",
    "true",
    "false",
    "line",
    "command",
    "install",
    "installing",
    "installed",
    "build",
    "building",
    "built",
    "problem",
    "issue",
    "help",
    "how",
    "why",
    "what",
    "fix",
    "fixed",
    "fixing",
    "occurred",
    "raised",
    "caused",
    "due",
    "while",
    "trying",
    "try",
    "tried",
    "need",
    "needs",
    "occurs",
    "happens",
    "happening",
    "version",
    "package",
    "packages",
    "python",
    "node",
    "rust",
];

fn is_generic(token: &str) -> bool {
    GENERIC.contains(&token)
}

/// Lowercase alphanumeric words of three characters or more, with a plural "s" removed.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.len() >= 3)
        .map(|w| {
            if w.len() > 4 && w.ends_with('s') {
                w[..w.len() - 1].to_string()
            } else {
                w.to_string()
            }
        })
        .collect()
}

/// The words of a query that tell this error from another one.
pub fn distinctive(query: &str, error_type: &str) -> HashSet<String> {
    let type_words: HashSet<String> = words(error_type).into_iter().collect();
    words(query)
        .into_iter()
        .filter(|w| {
            !is_generic(w)
                && !type_words.contains(w)
                && !w.ends_with("error")
                && !w.ends_with("exception")
        })
        .collect()
}

/// Every word a stored trail is about.
fn trail_words(trail: &Value) -> HashSet<String> {
    let mut text = String::new();
    for path in [
        "/problem/error_message",
        "/problem/summary",
        "/problem/task_context",
        "/problem/error_type",
        "/solution/root_cause",
    ] {
        if let Some(s) = trail.pointer(path).and_then(Value::as_str) {
            text.push_str(s);
            text.push(' ');
        }
    }
    for list in ["/environment/packages", "/tags"] {
        if let Some(items) = trail.pointer(list).and_then(Value::as_array) {
            for item in items {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| item.as_str());
                if let Some(n) = name {
                    text.push_str(n);
                    text.push(' ');
                }
            }
        }
    }
    words(&text).into_iter().collect()
}

/// Whether a semantic hit may be shown for this query.
pub fn is_relevant(query: &str, error_type: &str, trail: &Value, similarity: f64) -> bool {
    if similarity >= HIGH_CONFIDENCE {
        return true;
    }
    let wanted = distinctive(query, error_type);
    if wanted.is_empty() {
        return true; // nothing specific was asked, so similarity is all there is to go on
    }
    let have = trail_words(trail);
    wanted.iter().any(|w| have.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn distutils() -> Value {
        json!({
            "problem": {
                "error_type": "ModuleNotFoundError",
                "error_message": "ModuleNotFoundError: No module named 'distutils'",
                "summary": "Installing numpy 1.24 on Python 3.12 fails while building from source because distutils was removed.",
            },
            "solution": { "root_cause": "numpy < 1.26 has no wheels for Python 3.12." },
            "environment": { "packages": [{ "name": "numpy", "version": "1.24.4" }] },
        })
    }

    #[test]
    fn a_different_module_is_not_the_same_problem() {
        let q = "ModuleNotFoundError: No module named 'modulo_que_no_existe_xyz'";
        assert!(!is_relevant(q, "ModuleNotFoundError", &distutils(), 0.726));
        let q = "ModuleNotFoundError: No module named 'requests'";
        assert!(!is_relevant(q, "ModuleNotFoundError", &distutils(), 0.80));
    }

    #[test]
    fn the_same_module_is_found() {
        let q = "ModuleNotFoundError: No module named 'distutils'";
        assert!(is_relevant(q, "ModuleNotFoundError", &distutils(), 0.75));
    }

    #[test]
    fn a_paraphrase_that_names_the_thing_is_found() {
        let q =
            "pip install numpy fails building wheel on python 3.12 because distutils is missing";
        assert!(is_relevant(q, "", &distutils(), 0.865));
        assert!(
            is_relevant("numpy will not build", "", &distutils(), 0.78),
            "numpy is in the trail"
        );
    }

    #[test]
    fn a_query_with_nothing_specific_relies_on_similarity() {
        assert!(is_relevant(
            "error: failed to run the command",
            "",
            &distutils(),
            0.75
        ));
    }

    #[test]
    fn a_near_identical_match_passes_whatever_the_words() {
        assert!(is_relevant(
            "ModuleNotFoundError: No module named 'distutil'",
            "ModuleNotFoundError",
            &distutils(),
            0.95
        ));
    }

    #[test]
    fn plurals_and_error_class_names_are_not_distinctive() {
        let d = distinctive("RateLimitError: too many requests", "RateLimitError");
        assert!(!d.contains("ratelimiterror"));
        assert!(d.contains("request"));
        assert!(words("wheels").contains(&"wheel".to_string()));
    }

    #[test]
    fn generic_words_never_count() {
        assert!(distinctive("error: failed to import module named x", "").is_empty());
    }
}
