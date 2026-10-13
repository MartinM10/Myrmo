//! The client versions released together with this server, read from release-please's manifest at build time, so a
//! colony can tell a client that a newer one exists without asking any registry (a private colony may have no internet
//! access). The public colony is deployed from the commit that released them, so it names the latest versions.

use serde_json::{Value, json};
use std::sync::LazyLock;

static MANIFEST: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../.release-please-manifest.json")).unwrap_or(Value::Null)
});

fn released(path: &str) -> Value {
    MANIFEST.get(path).cloned().unwrap_or(Value::Null)
}

/// `GET /v1/version`: this server, the clients released with it, and how to update each.
pub fn describe() -> Value {
    json!({
        "server": env!("CARGO_PKG_VERSION"),
        "protocol": released("protocol"),
        "clients": {
            "plugin": released("."),
            "mcp": released("clients/typescript/packages/myrmo-mcp"),
            "sdk_js": released("clients/typescript/packages/myrmo"),
            "sdk_python": released("clients/python"),
        },
        "update": {
            "claude_code": "claude plugin update myrmo@myrmo (or turn on auto-update: /plugin > Marketplaces > myrmo > Enable auto-update)",
            "other_clients": "npx myrmo-mcp@latest init (with the same --url, --key and --private as the first time)",
        },
    })
}

/// A client's own declaration, `X-Myrmo-Client: myrmo-mcp/0.23.0`, when it has that shape.
pub fn client_label(value: &str) -> Option<String> {
    let value = value.trim();
    let (name, version) = value.split_once('/')?;
    let name_ok = !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let version_ok = !version.is_empty()
        && version.len() <= 24
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    (name_ok && version_ok).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_released_clients() {
        let v = describe();
        assert_eq!(v["server"], env!("CARGO_PKG_VERSION"));
        for c in ["plugin", "mcp", "sdk_js", "sdk_python"] {
            assert!(
                v["clients"][c].as_str().is_some_and(|s| s.contains('.')),
                "{c}"
            );
        }
    }

    #[test]
    fn only_a_name_and_a_version_are_kept() {
        assert_eq!(
            client_label("myrmo-mcp/0.23.0").as_deref(),
            Some("myrmo-mcp/0.23.0")
        );
        assert_eq!(
            client_label("myrmo-plugin/0.32.0-rc.1").as_deref(),
            Some("myrmo-plugin/0.32.0-rc.1")
        );
        assert_eq!(client_label("Mozilla/5.0 (X11)"), None);
        assert_eq!(client_label("evil/1.0;rm -rf"), None);
        assert_eq!(client_label("noversion"), None);
    }
}
