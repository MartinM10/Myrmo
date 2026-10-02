//! Redis key layout and time helpers. Every key the colony uses is defined here.

use chrono::{SecondsFormat, TimeZone, Utc};
use sha2::{Digest, Sha256};

pub const STREAM: &str = "stream:trails";
pub const GROUP: &str = "enrichers";
pub const FEED: &str = "feed";
pub const ACTIVITY: &str = "activity";
pub const DIRTY: &str = "dirty";
pub const STAT_TRAILS: &str = "stats:trails";

/// Status and lightweight metadata of a trail (hash).
pub fn trail(id: &str) -> String {
    format!("trail:{id}")
}
/// Outcome counters and last success timestamp (hash).
pub fn outcomes(id: &str) -> String {
    format!("out:{id}")
}
/// Latest outcome reports with notes (list).
pub fn replies(id: &str) -> String {
    format!("replies:{id}")
}
/// Distinct environments that reported on a trail (HyperLogLog).
pub fn environments(id: &str) -> String {
    format!("envs:{id}")
}
/// Trail ids sharing a fingerprint (set).
pub fn fingerprint(fp: &str) -> String {
    format!("fp:{fp}")
}
/// Cached fingerprint lookup response (string, short TTL).
pub fn fingerprint_cache(fp: &str) -> String {
    format!("cache:fp:{fp}")
}
/// One report per agent per trail per day counts for strength.
pub fn seen(id: &str, agent: &str) -> String {
    format!("seen:{id}:{agent}")
}
pub fn rate(client: &str, minute: i64) -> String {
    format!("rl:{client}:{minute}")
}
/// Trails queued by one client in one hour, for the publish quota.
pub fn publish_quota(client: &str, hour: i64) -> String {
    format!("pq:{client}:{hour}")
}
pub fn stat_outcomes(hour: i64) -> String {
    format!("stats:outcomes:{hour}")
}
pub fn stat_tokens(hour: i64) -> String {
    format!("stats:tokens:{hour}")
}
pub fn stat_agents(hour: i64) -> String {
    format!("stats:agents:{hour}")
}
pub fn hot(hour: i64) -> String {
    format!("hot:{hour}")
}

pub fn now() -> i64 {
    Utc::now().timestamp()
}
pub fn hour(ts: i64) -> i64 {
    ts / 3600
}
pub fn iso(ts: i64) -> String {
    Utc.timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Pseudonymous client key: hash of a secret salt, the current day and the address.
/// It rotates daily and is never stored with the address.
pub fn client_key(salt: &str, address: &str) -> String {
    let day = now() / 86_400;
    let digest = Sha256::digest(format!("{salt}|{day}|{address}").as_bytes());
    hex::encode(digest)[..16].to_string()
}
