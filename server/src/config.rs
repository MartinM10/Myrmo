//! Runtime configuration, read once from environment variables.

use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    /// Address the gateway listens on.
    pub bind: String,
    pub redis_url: String,
    /// Qdrant REST endpoint (port 6333).
    pub qdrant_url: String,
    pub collection: String,
    /// Text Embeddings Inference endpoint.
    pub embed_url: String,
    /// System One endpoint (`/v1/systemone`). `None` means deterministic heuristics only.
    pub decision_url: Option<String>,
    pub decision_api_key: Option<String>,
    /// Requests per minute per hashed client. 0 disables rate limiting.
    pub rate_limit_per_minute: u64,
    /// Minimum cosine similarity for a semantic match.
    pub min_similarity: f64,
    /// Secret mixed into the daily client hash. Random per process when unset.
    pub salt: String,
    /// Consumer name inside the Redis consumer group.
    pub consumer_name: String,
}

fn var(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let get = |key: &str, default: &str| var(key).unwrap_or_else(|| default.to_string());
        Self {
            bind: get("MYRMO_BIND", "0.0.0.0:8080"),
            redis_url: get("REDIS_URL", "redis://127.0.0.1:6379"),
            qdrant_url: get("QDRANT_URL", "http://127.0.0.1:6333")
                .trim_end_matches('/')
                .to_string(),
            collection: get("MYRMO_COLLECTION", "trails"),
            embed_url: get("MYRMO_EMBED_URL", "http://127.0.0.1:8081")
                .trim_end_matches('/')
                .to_string(),
            decision_url: var("MYRMO_DECISION_URL"),
            decision_api_key: var("MYRMO_DECISION_API_KEY"),
            rate_limit_per_minute: get("MYRMO_RATE_LIMIT", "120").parse().unwrap_or(120),
            min_similarity: get("MYRMO_MIN_SIMILARITY", "0.72").parse().unwrap_or(0.72),
            salt: var("MYRMO_SALT").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            consumer_name: get("HOSTNAME", "enricher"),
        }
    }
}
