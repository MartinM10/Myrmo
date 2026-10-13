//! Runtime configuration, read once from environment variables.

use crate::net::Cidr;
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
    pub decision_model: Option<String>,
    /// Let the decision model's prompt-injection score reject trails. Off by default: measured on
    /// real trails it scores a bare command such as `pytest -q` at 0.91 and rejects roughly one
    /// legitimate trail in five, so it is recorded in the log for calibration and the
    /// deterministic rules decide.
    pub model_injection_gate: bool,
    /// Index trails on the rules alone when the decision model cannot be reached. Off by default:
    /// the model is what reads the parts of a trail the rules cannot understand, so without it
    /// trails wait in the queue instead of being published unchecked.
    pub decision_fail_open: bool,
    /// Peers whose `X-Forwarded-For` is believed: the reverse proxy and the hosted MCP server. A request from any other
    /// address is counted under that address, whatever header it sends, so a caller that reaches the gateway directly
    /// cannot pick the address its quotas are counted against.
    pub trusted_proxies: Vec<Cidr>,
    /// Networks allowed to connect at all (`MYRMO_ALLOWED_NETWORKS`); empty means everyone. See `net::allows`.
    pub allowed_networks: Vec<Cidr>,
    /// Requests per minute per hashed client. 0 disables rate limiting.
    pub rate_limit_per_minute: u64,
    /// Trails a hashed client may publish per hour. 0 disables the quota.
    pub publish_limit_per_hour: u64,
    /// Distinct declared agent ids per address, trail and day whose reports can count.
    pub votes_per_address: u64,
    /// Reports that can count per address and hour, over all trails.
    pub votes_per_address_hour: u64,
    /// Most tokens one counted `worked` report adds to the public "tokens saved" figures.
    pub tokens_credit_max: i64,
    /// Trails waiting for enrichment above which publishing is refused with 503. 0 disables it.
    pub queue_max: u64,
    /// Bearer token for operator endpoints (removing a trail). Unset, or shorter than 16
    /// characters, disables them.
    pub admin_token: Option<String>,
    /// A private colony: every `/v1` request needs a person's access key (`myrmo-server keys add`), and that person is
    /// the caller's identity. `MYRMO_REQUIRE_KEY=1`.
    pub require_key: bool,
    /// An organisation's own colony (`MYRMO_PRIVATE=1`; by default whenever keys are required). It keeps the addresses
    /// and host names of the organisation's network, accepts procedures and facts besides fixes, and never rejects a
    /// trail for "sensitive content": what is internal to the organisation is what its agents need. Credentials and
    /// personal data are still removed, and prompt injection is still refused.
    pub private: bool,
    /// The second embedding model, for task requests ("deploy a new tenant") rather than error lines: its
    /// `/embed` endpoint (`MYRMO_TASK_EMBED_URL`). Unset disables search by task.
    pub task_embed_url: Option<String>,
    /// The vector collection of that index (`MYRMO_TASK_COLLECTION`, default `<collection>_tasks`).
    pub task_collection: String,
    /// Minimum cosine similarity for a task match (`MYRMO_TASK_MIN_SIMILARITY`). Its own threshold: a multilingual
    /// model scores a right answer lower than the error model does an exact error line.
    pub task_min_similarity: f64,
    /// Keep the task requests the colony could not answer (redacted, 30 days), so the operator sees what knowledge is
    /// missing (`MYRMO_RECORD_GAPS=1`). Private colonies only; the panel can switch it while the colony runs.
    pub record_gaps: bool,
    /// Public address of the website, used to build approval links for drafts.
    pub public_url: String,
    /// Minimum cosine similarity for a semantic match.
    pub min_similarity: f64,
    /// Most trails one exact fingerprint keeps (see `keys::add_to_fingerprint`).
    pub max_per_fingerprint: usize,
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
        let require_key = get("MYRMO_REQUIRE_KEY", "0") == "1";
        let collection = get("MYRMO_COLLECTION", "trails");
        Self {
            bind: get("MYRMO_BIND", "0.0.0.0:8080"),
            redis_url: get("REDIS_URL", "redis://127.0.0.1:6379"),
            qdrant_url: get("QDRANT_URL", "http://127.0.0.1:6333")
                .trim_end_matches('/')
                .to_string(),
            task_collection: get("MYRMO_TASK_COLLECTION", &format!("{collection}_tasks")),
            collection,
            task_embed_url: var("MYRMO_TASK_EMBED_URL")
                .map(|u| u.trim_end_matches('/').to_string()),
            task_min_similarity: get("MYRMO_TASK_MIN_SIMILARITY", "0.55")
                .parse()
                .unwrap_or(0.55),
            record_gaps: var("MYRMO_RECORD_GAPS").is_some_and(|v| v == "1"),
            private: var("MYRMO_PRIVATE").map_or(require_key, |v| v == "1"),
            embed_url: get("MYRMO_EMBED_URL", "http://127.0.0.1:8081")
                .trim_end_matches('/')
                .to_string(),
            decision_url: var("MYRMO_DECISION_URL"),
            decision_api_key: var("MYRMO_DECISION_API_KEY"),
            decision_model: var("MYRMO_DECISION_MODEL"),
            model_injection_gate: var("MYRMO_MODEL_INJECTION_GATE").is_some_and(|v| v == "1"),
            decision_fail_open: var("MYRMO_DECISION_FAIL_OPEN").is_some_and(|v| v == "1"),
            trusted_proxies: Cidr::parse_list(&get(
                "MYRMO_TRUSTED_PROXIES",
                crate::net::PRIVATE_NETWORKS,
            )),
            allowed_networks: Cidr::parse_list(&get("MYRMO_ALLOWED_NETWORKS", "")),
            rate_limit_per_minute: get("MYRMO_RATE_LIMIT", "120").parse().unwrap_or(120),
            publish_limit_per_hour: get("MYRMO_PUBLISH_LIMIT", "30").parse().unwrap_or(30),
            votes_per_address: get("MYRMO_VOTES_PER_ADDRESS", "3").parse().unwrap_or(3),
            votes_per_address_hour: get("MYRMO_VOTES_PER_ADDRESS_HOUR", "20")
                .parse()
                .unwrap_or(20),
            tokens_credit_max: get("MYRMO_TOKENS_CREDIT_MAX", "200000")
                .parse()
                .unwrap_or(200_000),
            queue_max: get("MYRMO_QUEUE_MAX", "10000").parse().unwrap_or(10_000),
            public_url: get("MYRMO_PUBLIC_URL", "http://localhost:3000")
                .trim_end_matches('/')
                .to_string(),
            admin_token: var("MYRMO_ADMIN_TOKEN").filter(|t| t.len() >= 16),
            require_key,
            min_similarity: get("MYRMO_MIN_SIMILARITY", "0.75").parse().unwrap_or(0.75),
            max_per_fingerprint: get("MYRMO_MAX_PER_FINGERPRINT", "64").parse().unwrap_or(64),
            demand_min_agents: get("MYRMO_DEMAND_MIN_AGENTS", "3").parse().unwrap_or(3),
            salt: var("MYRMO_SALT").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            consumer_name: get("HOSTNAME", "enricher"),
        }
    }

    /// What this colony removes from trails, searches and reports.
    pub fn redaction(&self) -> crate::redact::Policy {
        crate::redact::Policy::for_colony(self.private)
    }
}
