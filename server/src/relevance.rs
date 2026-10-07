//! Is a semantic hit about the same problem, or only shaped like it?
//!
//! The embedding model scores "No module named 'foo'" close to "No module named 'bar'": the sentence
//! is the same and only the name differs, and the name is what matters. So a semantic hit must share
//! at least one distinctive word with the query (a module, a package, a code), unless the match is
//! nearly identical. Exact fingerprint hits are not filtered: they are the same error by construction.

use crate::fingerprint;
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

/// The share of the words of the longer message that two messages must have in common to be one template: three
/// fifths, and half when the messages are so short (`KeyError: 'x'`) that the class is most of what they say.
/// Measured on 3,000 strangers and 295 variants of real trails: 0.5 would call a sentence with a colon a template.
const MIN_TEMPLATE_OVERLAP: f64 = 0.6;
const SHORT_TEMPLATE_OVERLAP: f64 = 0.5;
const SHORT_MESSAGE_WORDS: usize = 3;

/// Words that are not names even when only one message has them: filler of a sentence, and the package segments of a
/// qualified Java class. The generic words of [`GENERIC`] are not names either.
const NOT_NAMES: &[&str] = &[
    "fails", "didn", "because", "lang", "java", "util", "does", "the", "and", "for", "with", "not",
    "was", "are", "has", "can", "did", "but", "its", "any", "all", "out", "off", "use", "run",
    "get", "got", "when", "from", "into", "that", "this", "what", "how", "why", "try", "fix",
    "due", "no", "in", "on", "of", "to", "is", "at", "or", "by", "an", "as", "be", "it", "if",
    "do", "so", "up",
];

/// A message has the structure of an error line (a colon, a quote or a backtick) as opposed to a sentence that a
/// person wrote, whose extra words say nothing about names.
fn looks_like_error_line(text: &str) -> bool {
    text.trim()
        .chars()
        .take(400)
        .any(|c| matches!(c, ':' | '\'' | '"' | '`'))
}

/// The words of a text after the fingerprint's normalisation, placeholders dropped, of `min` characters or more.
fn plain_words(normalised: &str, min: usize) -> HashSet<String> {
    let mut text = String::with_capacity(normalised.len());
    let mut in_placeholder = false;
    for c in normalised.chars() {
        match c {
            '<' => in_placeholder = true,
            '>' if in_placeholder => {
                in_placeholder = false;
                text.push(' ');
            }
            _ if !in_placeholder => text.push(c),
            _ => {}
        }
    }
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.len() >= min)
        .map(str::to_string)
        .collect()
}

/// The words that can be names: those of the message without its labels, not generic, not class names.
fn name_words(message: &str) -> HashSet<String> {
    plain_words(&fingerprint::label_free(message), 2)
        .into_iter()
        .filter(|w| {
            w.chars().any(|c| c.is_ascii_alphabetic())
                && !is_generic(w)
                && !NOT_NAMES.contains(&w.as_str())
                && !["error", "exception", "warning", "failure"]
                    .iter()
                    .any(|s| w.ends_with(s))
        })
        .collect()
}

/// A query read once, to be compared with each candidate of a search: the words of its message and its names are the
/// same for all of them, and normalising a text costs more than comparing two sets.
pub struct Asked<'a> {
    query: &'a str,
    error_type: &'a str,
    /// The words and the names of the query when it looks like an error line; `None` for a sentence.
    template: Option<(HashSet<String>, HashSet<String>)>,
}

impl<'a> Asked<'a> {
    pub fn new(query: &'a str, error_type: &'a str) -> Self {
        let template = looks_like_error_line(query).then(|| {
            (
                plain_words(&fingerprint::volatile_free(query), 3),
                name_words(query),
            )
        });
        Self {
            query,
            error_type,
            template,
        }
    }

    /// Whether the query and a trail's error message are one template that names different things: `No module named
    /// 'kodavuri'` against `No module named 'kodavuro'`. Embeddings score such pairs about as high as the right answer
    /// (median 0.948 for right answers, 0.903 for answers about another name), and among thousands of trails of one
    /// kind there is always one: 94% of the searches about a name nobody published got a trail about another.
    /// True when the query looks like an error line, the two share most of the words of the longer one, and each has a
    /// name the other lacks. A query that only adds words (a wrapper, a stack), only lacks words (cut short), is a
    /// sentence, or shows another machine's paths and versions does not conflict.
    pub fn names_conflict(&self, message: &str) -> bool {
        let Some((q, nq)) = &self.template else {
            return false;
        };
        let m = plain_words(&fingerprint::volatile_free(message), 3);
        if q.is_empty() || m.is_empty() {
            return false;
        }
        let longest = q.len().max(m.len());
        let needed = if longest <= SHORT_MESSAGE_WORDS {
            SHORT_TEMPLATE_OVERLAP
        } else {
            MIN_TEMPLATE_OVERLAP
        };
        if (q.intersection(&m).count() as f64 / longest as f64) < needed {
            return false;
        }
        let nm = name_words(message);
        nq.iter().any(|w| !nm.contains(w)) && nm.iter().any(|w| !nq.contains(w))
    }

    /// Whether a semantic hit may be shown for this query.
    pub fn is_relevant(&self, trail: &Value, similarity: f64) -> bool {
        // Close in the embedding is not the same error: two messages that name different things are not one.
        if self.names_conflict(&fingerprint::message_for_problem(&trail["problem"])) {
            return false;
        }
        if similarity >= HIGH_CONFIDENCE {
            return true;
        }
        let wanted = distinctive(self.query, self.error_type);
        if wanted.is_empty() {
            return true; // nothing specific was asked, so similarity is all there is to go on
        }
        let have = trail_words(trail);
        wanted.iter().any(|w| have.contains(w))
    }
}

/// [`Asked::names_conflict`] for one query and one message.
#[cfg(test)]
pub fn names_conflict(query: &str, message: &str) -> bool {
    Asked::new(query, "").names_conflict(message)
}

/// [`Asked::is_relevant`] for one query and one trail.
#[cfg(test)]
pub fn is_relevant(query: &str, error_type: &str, trail: &Value, similarity: f64) -> bool {
    Asked::new(query, error_type).is_relevant(trail, similarity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_that_differ_make_a_conflict_and_nothing_else_does() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../tests/corpus/names.json")).unwrap();
        assert!(vectors.len() >= 30);
        for v in &vectors {
            let (q, m) = (v["query"].as_str().unwrap(), v["message"].as_str().unwrap());
            assert_eq!(
                names_conflict(q, m),
                v["conflict"].as_bool().unwrap(),
                "{} | {q:?} vs {m:?}",
                v["note"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn a_hit_about_another_name_is_not_relevant_however_close_it_is() {
        let trail = json!({ "problem": { "error_type": "ModuleNotFoundError", "error_message": "ModuleNotFoundError: No module named 'kodavuro'" } });
        let query = "ModuleNotFoundError: No module named 'kodavuri'";
        assert!(!is_relevant(query, "ModuleNotFoundError", &trail, 0.97));
        assert!(is_relevant(
            "ModuleNotFoundError: No module named 'kodavuro'",
            "ModuleNotFoundError",
            &trail,
            0.97
        ));
    }

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
    fn a_near_identical_match_passes_unless_it_names_something_else() {
        // The same error, worded a little differently: similarity is enough.
        assert!(is_relevant(
            "ModuleNotFoundError: No module named 'distutils'",
            "ModuleNotFoundError",
            &distutils(),
            0.95
        ));
        // Another name is another error, however close: with thousands of trails of one kind there is always a
        // sibling at 0.95, and 94% of the searches about a name nobody published got one (bench/scale).
        assert!(!is_relevant(
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
