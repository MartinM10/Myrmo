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
    // Filler of a sentence and structure of a stack trace: they appear in unrelated errors.
    "find",
    "locate",
    "because",
    "support",
    "supported",
    "main",
    "thread",
    "attribute",
    "object",
    "binary",
    "experimental",
    // The parts of a file system path that differ between machines and say nothing about the error.
    "path",
    "tmp",
    "usr",
    "lib",
    "bin",
    "opt",
    "var",
    "etc",
    "home",
    "site",
    "local",
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

/// The query without the file system paths in it (`/usr/local/lib/python3.12/site-packages/flask/json/__init__.py`):
/// where the interpreter or the checkout lives is a fact about a machine, and two unrelated errors printed on machines
/// that share a layout would otherwise share words. A relative name such as `golang.org/x/tools` is kept: it is a name.
fn without_paths(query: &str) -> String {
    let is_path = |token: &str| {
        let t = token.trim_matches(|c: char| {
            matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | ',' | ';')
        });
        t.starts_with('/')
            || t.starts_with("~/")
            || t.starts_with("./")
            || t.starts_with("../")
            || t.contains(":\\")
    };
    query
        .split_whitespace()
        .filter(|token| !is_path(token))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words of a query that tell this error from another one.
pub fn distinctive(query: &str, error_type: &str) -> HashSet<String> {
    let type_words: HashSet<String> = words(error_type).into_iter().collect();
    words(&without_paths(query))
        .into_iter()
        .filter(|w| {
            !is_generic(w)
                && !type_words.contains(w)
                && !w.ends_with("error")
                && !w.ends_with("exception")
        })
        .collect()
}

/// A quoted word that reads as a name in code (`url_quote`, `np.float`, `--legacy-peer-deps`) and not as a value that
/// differs per machine: a URL, an address, a host name, a path or a number.
fn is_identifier_shaped(word: &str) -> bool {
    const DOMAIN_ENDINGS: [&str; 10] = [
        "com", "org", "net", "io", "dev", "example", "local", "internal", "corp", "lan",
    ];
    (3..=64).contains(&word.len())
        && word.starts_with(|c: char| c.is_alphabetic() || c == '-' || c == '_')
        && word.chars().any(|c| c.is_alphabetic())
        && word
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && word
            .rsplit_once('.')
            .is_none_or(|(_, last)| !DOMAIN_ENDINGS.contains(&last))
}

/// The identifiers a query names: whatever is quoted (`'url_quote'`, `` `regex` ``) and codes such as `TS2835`,
/// `E0554`, `ERR_REQUIRE_ESM` or `NETSDK1045`. Two errors that name different identifiers are different errors, even
/// when the rest of the sentence is the same and they sit in the same family.
pub fn identifiers(query: &str) -> HashSet<String> {
    let mut found = HashSet::new();
    let text = without_paths(query);
    for (start, c) in text.char_indices() {
        if !matches!(c, '\'' | '"' | '`') {
            continue;
        }
        // A quote that opens a quoted name is not preceded by a letter (it is not an apostrophe: `didn't`).
        if text[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphabetic)
        {
            continue;
        }
        if let Some(end) = text[start + 1..].find(c) {
            let inner = &text[start + 1..start + 1 + end];
            let word = inner.trim().to_lowercase();
            let single = !word.contains(char::is_whitespace);
            if single && is_identifier_shaped(&word) && !is_generic(&word) {
                found.insert(word);
            }
        }
    }
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        let code = token.len() >= 5
            && ((token.starts_with("ERR_")
                && token[4..]
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
                || (token.len() <= 10
                    && token.chars().take_while(char::is_ascii_uppercase).count() >= 1
                    && token.chars().skip_while(char::is_ascii_uppercase).count() >= 3
                    && token
                        .chars()
                        .skip_while(char::is_ascii_uppercase)
                        .all(|c| c.is_ascii_digit())));
        if code {
            found.insert(token.to_lowercase());
        }
    }
    found
}

/// File extensions that make a slash-separated token a file, not the name of a module or an image.
const FILE_EXTENSIONS: &[&str] = &[
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "java", "kt", "c", "h", "cc", "cpp",
    "hpp", "cs", "rb", "php", "json", "yaml", "yml", "toml", "lock", "xml", "csv", "txt", "md",
    "ini", "cfg", "conf", "sh", "log", "html", "css", "sql", "whl", "gz", "zip", "tar", "so",
    "dll", "exe", "pem", "crt", "key",
];

/// The names a message spells inside what the fingerprint turns into a placeholder: the module path of a Go package
/// (`github.com/stretchr/testify`), the repository in a git URL, a registry package (`registry.npmjs.org/left-pad`),
/// an image (`library/nginx`). They are what tells two errors of one family apart, and the fingerprint erases them.
/// Absolute paths, files and numbers, which differ from one machine to the next, are not names.
/// `protocol/placeholder_names.v1.vectors.json` is normative; the SDKs port this function.
pub fn placeholder_names(text: &str) -> HashSet<String> {
    text.split(|c: char| c.is_whitespace() || "'\"`()[]<>,;=".contains(c))
        .filter_map(placeholder_name)
        .collect()
}

fn placeholder_name(raw: &str) -> Option<String> {
    let mut token = raw.to_lowercase();
    if let Some(i) = token.find("://") {
        token = token[i + 3..].to_string();
    }
    if let Some(i) = token.find(['?', '#']) {
        token.truncate(i);
    }
    // user:password@host/path: the credentials are not part of the name.
    if let Some(at) = token.find('@') {
        let (head, tail) = (&token[..at], &token[at + 1..]);
        if !head.is_empty() && !head.contains('/') && tail.contains('/') {
            token = tail.to_string();
        }
    }
    // name@1.2.3: the version is not part of the name.
    if let Some(at) = token.rfind('@') {
        let (head, tail) = (&token[..at], &token[at + 1..]);
        if head.contains('/') && !tail.contains('/') {
            token = head.to_string();
        }
    }
    let punctuation = [':', '.', '/'];
    let mut token = token.trim_end_matches(punctuation).to_string();
    if let Some(stripped) = token.strip_suffix(".git") {
        token = stripped.trim_end_matches(punctuation).to_string();
    }
    // An image tag, or a line and column (`main.rs:5:3`): a colon after the last slash ends the name.
    if let Some(end) = token
        .rfind('/')
        .and_then(|slash| token[slash..].find(':').map(|colon| slash + colon))
    {
        token.truncate(end);
    }
    if !token.contains('/') || !token.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return None;
    }
    let segments: Vec<&str> = token.split('/').collect();
    if segments.len() > 8 || segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    let last = segments[segments.len() - 1];
    if last
        .rsplit_once('.')
        .is_some_and(|(_, extension)| FILE_EXTENSIONS.contains(&extension))
    {
        return None;
    }
    let host = segments[0].split(':').next().unwrap_or_default();
    let host_like = host == "localhost"
        || (host.contains('.')
            && host
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())));
    let pair = segments.len() == 2 && !segments[0].contains('.');
    ((host_like || pair) && token.chars().any(|c| c.is_ascii_alphabetic())).then_some(token)
}

/// Whether two sets of names share one: the same name, one inside the other (`github.com/a/b` and
/// `github.com/a/b/assert`), or the same final segment (`github.com/a/foo` and `gitlab.com/b/foo`).
fn share_a_name(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    a.iter().any(|x| {
        b.iter().any(|y| {
            x == y
                || x.strip_prefix(y.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
                || y.strip_prefix(x.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
                || x.rsplit('/').next() == y.rsplit('/').next()
        })
    })
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

/// All the text a trail says about its problem and its fix, for looking up a name in it.
fn trail_text(trail: &Value) -> String {
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
    for step in trail
        .pointer("/solution/steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        text.push_str(step);
        text.push(' ');
    }
    text
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

    /// An exact fingerprint hit is the same error by construction, except where the fingerprint erased the name: a Go
    /// module path, an image, a registry URL all become one placeholder. True when the query and the trail's message
    /// both spell such names and share none: another package, so another error.
    pub fn path_names_conflict(&self, trail: &Value) -> bool {
        let asked = placeholder_names(self.query);
        if asked.is_empty() {
            return false;
        }
        let have = placeholder_names(&fingerprint::message_for_problem(&trail["problem"]));
        !have.is_empty() && !share_a_name(&asked, &have)
    }

    /// Whether a semantic hit may be shown for this query.
    pub fn is_relevant(&self, trail: &Value, similarity: f64) -> bool {
        // Close in the embedding is not the same error: two messages that name different things are not one.
        if self.names_conflict(&fingerprint::message_for_problem(&trail["problem"])) {
            return false;
        }
        // Nor are two that name another module, image or repository, the names the check above cannot see.
        if self.path_names_conflict(trail) {
            return false;
        }
        if similarity >= HIGH_CONFIDENCE {
            return true;
        }
        // The query names identifiers (quoted names, error codes) and the trail mentions none of them: another error.
        let named = identifiers(self.query);
        if !named.is_empty() {
            let text = trail_text(trail).to_lowercase();
            if !named.iter().any(|id| text.contains(id.as_str())) {
                return false;
            }
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
    fn the_layout_of_a_machine_is_not_what_an_error_is_about() {
        let flask = "ImportError: cannot import name 'JSONEncoder' from 'flask.json' (/usr/local/lib/python3.12/site-packages/flask/json/__init__.py)";
        let werkzeug = json!({"problem": {"error_message": "ImportError: cannot import name 'url_quote' from 'werkzeug.urls' (/usr/local/lib/python3.12/site-packages/werkzeug/urls.py)", "summary": "Flask imports url_quote from werkzeug"}, "solution": {"root_cause": "Werkzeug 3 removed it"}});
        let wanted = distinctive(flask, "ImportError");
        assert!(
            wanted.contains("jsonencoder") && wanted.contains("flask"),
            "{wanted:?}"
        );
        for word in ["usr", "local", "lib", "site", "python3"] {
            assert!(!wanted.contains(word), "{word}");
        }
        // Same layout, other names: the only words in common are the machine's.
        let unrelated = json!({"problem": {"error_message": "ImportError: cannot import name 'url_quote' from 'werkzeug.urls'", "summary": "A module moved", "task_context": "Running python from /usr/local/lib/python3.12/site-packages"}, "solution": {"root_cause": "Removed in 3.0"}});
        assert!(!Asked::new(flask, "ImportError").is_relevant(&unrelated, 0.77));
        let _ = werkzeug;
    }

    #[test]
    fn quoted_names_and_error_codes_are_identifiers() {
        let ids = identifiers(
            "ImportError: cannot import name 'JSONEncoder' from 'flask.json' (/usr/lib/x.py)",
        );
        assert!(
            ids.contains("jsonencoder") && ids.contains("flask.json"),
            "{ids:?}"
        );
        let codes = identifiers(
            "b.ts(1,19): error TS2835: Relative import; Error [ERR_REQUIRE_ESM]; error[E0554]; NETSDK1045",
        );
        for code in ["ts2835", "err_require_esm", "e0554", "netsdk1045"] {
            assert!(codes.contains(code), "{code} in {codes:?}");
        }
        assert!(
            identifiers("it didn't work and the file isn't there").is_empty(),
            "an apostrophe is not a quote"
        );
        assert!(
            identifiers("something went wrong with 'a b c'").is_empty(),
            "a quoted phrase is not a name"
        );
        for value in [
            "Get \"http://localhost:49633/version\": connection refused",
            "no alternative certificate subject name matches target host name '5.15.2.1'",
            "unable to access 'https://intranet.example:61381/repo.git/'",
            "could not resolve 'registry.internal'",
            "cannot open '/etc/app.conf'",
        ] {
            assert!(
                identifiers(value).is_empty(),
                "a value that changes per machine is not a name: {value}"
            );
        }
    }

    #[test]
    fn a_trail_that_names_none_of_the_identifiers_asked_about_is_another_error() {
        let asked = "Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await";
        let other = json!({"problem": {"error_message": "TypeError [ERR_IMPORT_ATTRIBUTE_MISSING]: Module needs an import attribute", "summary": "A JSON import in an ES module needs an attribute"}, "solution": {"root_cause": "Node follows the import attributes proposal"}});
        let same = json!({"problem": {"error_message": "Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph", "summary": "require of an ES module with top-level await"}, "solution": {"root_cause": "Use import()"}});
        assert!(!Asked::new(asked, "").is_relevant(&other, 0.80));
        assert!(Asked::new(asked, "").is_relevant(&same, 0.80));
        assert!(
            Asked::new(asked, "").is_relevant(&other, 0.95),
            "a near-identical match is not second-guessed"
        );
    }

    #[test]
    fn names_the_fingerprint_erases_tell_two_errors_apart() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../protocol/placeholder_names.v1.vectors.json"
        ))
        .unwrap();
        for case in vectors["names"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let expected: HashSet<String> = case["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect();
            assert_eq!(placeholder_names(text), expected, "{text:?}");
        }
        for case in vectors["conflicts"].as_array().unwrap() {
            let (query, message) = (
                case["query"].as_str().unwrap(),
                case["message"].as_str().unwrap(),
            );
            let trail = json!({"problem": {"error_message": message}});
            assert_eq!(
                Asked::new(query, "").path_names_conflict(&trail),
                case["conflict"].as_bool().unwrap(),
                "{}: {query:?} against {message:?}",
                case["note"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn a_name_that_looks_like_a_path_is_still_a_name() {
        let wanted = distinctive(
            "go: golang.org/x/tools/cmd/goimports@latest: requires go >= 1.26.0",
            "",
        );
        assert!(wanted.iter().any(|w| w == "goimport"), "{wanted:?}");
    }

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
