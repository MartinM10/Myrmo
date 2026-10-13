//! What depends on a trail's kind. A fix is a solved error; a procedure (how a task is done here) and a fact (what
//! an agent must know about the organisation's systems) are the knowledge an organisation's private colony keeps
//! besides fixes. They are found by task ("deploy a new tenant") rather than by error line, so every trail also
//! gets a second text, [`task_text`], for the task index.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Fix,
    Procedure,
    Fact,
}

impl Kind {
    pub fn of(trail: &Value) -> Kind {
        match trail.get("kind").and_then(Value::as_str) {
            Some("procedure") => Kind::Procedure,
            Some("fact") => Kind::Fact,
            _ => Kind::Fix,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Fix => "fix",
            Kind::Procedure => "procedure",
            Kind::Fact => "fact",
        }
    }

    /// Procedures and facts: knowledge that does not come from an error.
    pub fn is_knowledge(self) -> bool {
        self != Kind::Fix
    }
}

fn s<'a>(trail: &'a Value, pointer: &str) -> &'a str {
    trail
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// What a procedure or a fact is filed under: its kind and what it is about. A fix is filed under its error line
/// (`fingerprint::of_trail`), which knowledge does not have.
pub fn subject(trail: &Value) -> String {
    format!(
        "{}: {}",
        Kind::of(trail).as_str(),
        s(trail, "/problem/summary")
    )
}

/// The text of the task index: what the agent was doing (or when the knowledge applies) and what it is about, in
/// the words a person uses to ask for a task. Measured on a handover: a multilingual model over this text finds the
/// right trail for task requests that the error index never matches.
pub fn task_text(trail: &Value) -> String {
    let kind = Kind::of(trail);
    let mut text = String::new();
    if kind.is_knowledge() {
        text.push_str(kind.as_str());
        text.push_str(": ");
    }
    for part in [
        s(trail, "/problem/task_context"),
        s(trail, "/problem/summary"),
    ] {
        if !part.trim().is_empty() {
            text.push_str(part.trim());
            text.push('\n');
        }
    }
    // A procedure's first steps say what it does in words a request may use.
    if kind == Kind::Procedure
        && let Some(steps) = trail.pointer("/solution/steps").and_then(Value::as_array)
    {
        for step in steps.iter().filter_map(Value::as_str).take(4) {
            text.extend(step.chars().take(160));
            text.push('\n');
        }
    }
    if let Some(tags) = trail.get("tags").and_then(Value::as_array) {
        let tags: Vec<&str> = tags.iter().filter_map(Value::as_str).collect();
        if !tags.is_empty() {
            text.push_str("Tags: ");
            text.push_str(&tags.join(", "));
        }
    }
    text.chars().take(2000).collect()
}

/// A deterministic quality score for a procedure or a fact, 0 to 1, in the spirit of `decision::heuristic_quality`:
/// what makes it usable by another agent is a clear subject, when it applies, enough steps and where it came from.
pub fn heuristic_quality(trail: &Value) -> f64 {
    let len = |p: &str| s(trail, p).chars().count();
    let count = |p: &str| {
        trail
            .pointer(p)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    let mut q: f64 = 0.4;
    if len("/problem/summary") >= 60 {
        q += 0.1;
    }
    if len("/problem/task_context") >= 40 {
        q += 0.1;
    }
    if count("/solution/steps") >= 2 {
        q += 0.15;
    }
    if count("/problem/failed_approaches") > 0 {
        q += 0.1;
    }
    if trail.get("source").is_some_and(Value::is_object) {
        q += 0.1;
    }
    if count("/solution/shell_commands_executed") > 0 {
        q += 0.05;
    }
    q.min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fact() -> Value {
        json!({
            "kind": "fact",
            "problem": {
                "summary": "User management runs on the ops-01 machine, not in the cluster",
                "task_context": "Adding or removing a person or a service login in LLDAP"
            },
            "solution": { "steps": ["ssh ops@10.40.2.17", "cd /opt/identity/user-management"] },
            "source": { "type": "handover", "ref": "handover-docs/04-user-management.md" },
            "tags": ["lldap", "ops-01"]
        })
    }

    #[test]
    fn kinds() {
        assert_eq!(Kind::of(&fact()), Kind::Fact);
        assert_eq!(Kind::of(&json!({})), Kind::Fix);
        assert_eq!(Kind::of(&json!({"kind": "procedure"})), Kind::Procedure);
        assert!(!Kind::Fix.is_knowledge());
    }

    #[test]
    fn task_text_says_when_and_what() {
        let text = task_text(&fact());
        assert!(
            text.starts_with("fact: Adding or removing a person"),
            "{text}"
        );
        assert!(
            text.contains("ops-01 machine") && text.contains("Tags: lldap, ops-01"),
            "{text}"
        );
    }

    #[test]
    fn quality_rewards_what_makes_knowledge_usable() {
        assert!(heuristic_quality(&fact()) >= 0.7);
        let bare =
            json!({"kind": "fact", "problem": {"summary": "short"}, "solution": {"steps": ["x"]}});
        assert!(heuristic_quality(&bare) < 0.5);
    }

    #[test]
    fn subjects_differ_by_kind_and_summary() {
        let mut other = fact();
        other["problem"]["summary"] = json!("Harbor is the registry of every image");
        assert_ne!(subject(&fact()), subject(&other));
    }
}
