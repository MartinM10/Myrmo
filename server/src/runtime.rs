//! The names agents give to a runtime. They write what they know: `java` or `jvm`, `node` or `nodejs`, `python3`.
//! The colony compares runtimes to rank results by environment and to decide whether two trails come from the same
//! environment, so spellings of one runtime must meet. The trail keeps the name its author wrote; only the
//! comparison uses the canonical one.

/// (canonical name, the other names it goes by), all lowercase. A language that merely runs on a runtime
/// (Kotlin, Scala on the JVM) keeps its own name: it is another toolchain, not another spelling.
const ALIASES: &[(&str, &[&str])] = &[
    ("java", &["jvm", "openjdk", "jdk", "jre", "temurin"]),
    ("node", &["nodejs", "node.js"]),
    ("python", &["python3", "cpython", "py3"]),
    ("go", &["golang"]),
    ("dotnet", &[".net", "dotnet-core", "dotnetcore"]),
    ("postgresql", &["postgres", "psql"]),
];

/// The canonical spelling of a runtime name, lowercase and trimmed. A name that is not an alias is returned as it is.
pub fn canonical(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    ALIASES
        .iter()
        .find(|(main, others)| *main == lower || others.contains(&lower.as_str()))
        .map(|(main, _)| (*main).to_string())
        .unwrap_or(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spellings_of_one_runtime_meet() {
        assert_eq!(canonical("jvm"), "java");
        assert_eq!(canonical("Java"), "java");
        assert_eq!(canonical(" OpenJDK "), "java");
        assert_eq!(canonical("nodejs"), "node");
        assert_eq!(canonical("Node.js"), "node");
        assert_eq!(canonical("python3"), "python");
        assert_eq!(canonical("CPython"), "python");
        assert_eq!(canonical("golang"), "go");
        assert_eq!(canonical(".NET"), "dotnet");
        assert_eq!(canonical("postgres"), "postgresql");
    }

    #[test]
    fn other_names_stay_apart() {
        assert_eq!(canonical("kotlin"), "kotlin");
        assert_eq!(canonical("python2"), "python2", "Python 2 is not Python 3");
        assert_eq!(canonical("rust"), "rust");
        assert_eq!(canonical(""), "");
        assert_ne!(canonical("java"), canonical("kotlin"));
    }
}
