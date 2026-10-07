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
    /// Let the decision model's prompt-injection score reject trails. Off by default: measured on
    /// real trails it scores a bare command such as `pytest -q` at 0.91 and rejects roughly one
    /// legitimate trail in five, so it is recorded in the log for calibration and the
    /// deterministic rules decide.
    pub model_injection_gate: bool,
    /// Index trails on the rules alone when the decision model cannot be reached. Off by default:
    /// the model is what reads the parts of a trail the rules cannot understand, so without it
    /// trails wait in the queue instead of being published unchecked.
    pub decision_fail_open: bool,
    /// Requests per minute per hashed client. 0 disables rate limiting.
    pub rate_limit_per_minute: u64,
    /// Trails a hashed client may publish per hour. 0 disables the quota.
    pub publish_limit_per_hour: u64,
    /// Trails waiting for enrichment above which publishing is refused with 503. 0 disables it.
    pub queue_max: u64,
    /// Bearer token for operator endpoints (removing a trail). Unset, or shorter than 16
    /// characters, disables them.
    pub admin_token: Option<String>,
    /// Public address of the website, used to build approval links for drafts.
    pub public_url: String,
    /// Minimum cosine similarity for a semantic match.
    pub min_similarity: f64,
    /// Distinct agents that must have missed an error before it is listed as demand, and before its labels are kept.
    pub demand_min_agents: u64,
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
            model_injection_gate: var("MYRMO_MODEL_INJECTION_GATE").is_some_and(|v| v == "1"),
            decision_fail_open: var("MYRMO_DECISION_FAIL_OPEN").is_some_and(|v| v == "1"),
            rate_limit_per_minute: get("MYRMO_RATE_LIMIT", "120").parse().unwrap_or(120),
            publish_limit_per_hour: get("MYRMO_PUBLISH_LIMIT", "30").parse().unwrap_or(30),
            queue_max: get("MYRMO_QUEUE_MAX", "10000").parse().unwrap_or(10_000),
            public_url: get("MYRMO_PUBLIC_URL", "http://localhost:3000")
                .trim_end_matches('/')
                .to_string(),
            admin_token: var("MYRMO_ADMIN_TOKEN").filter(|t| t.len() >= 16),
            min_similarity: get("MYRMO_MIN_SIMILARITY", "0.72").parse().unwrap_or(0.72),
            demand_min_agents: get("MYRMO_DEMAND_MIN_AGENTS", "3").parse().unwrap_or(3),
            salt: var("MYRMO_SALT").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            consumer_name: get("HOSTNAME", "enricher"),
        }
    }
}
