//! Durable analytics: daily aggregates that never expire, kept for later analysis.
//!
//! One Redis hash per UTC day (`an:d:YYYYMMDD`) holds counters named `<metric>|<label>`,
//! for example `laid|claude-opus-5-5`, `worked|gpt-5` or `fw_laid|langchain`, plus plain
//! totals. A HyperLogLog per day counts distinct agents, and one more counts the agents
//! that declared a stable pseudonymous id. Labels are untrusted strings chosen by clients,
//! so they are validated and each day's hash has a hard cap on distinct fields.

use crate::keys;
use chrono::{TimeZone, Utc};
use redis::aio::ConnectionManager;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Declared pseudonymous agent ids, all time (HyperLogLog).
pub const AGENTS_ALL: &str = "an:agents:all";
/// New distinct fields stop being accepted in a day's hash beyond this many.
const MAX_FIELDS_PER_DAY: usize = 4000;

fn ymd(ts: i64) -> String {
    Utc.timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y%m%d")
        .to_string()
}

pub fn day_key(ts: i64) -> String {
    format!("an:d:{}", ymd(ts))
}

pub fn agents_day_key(ts: i64) -> String {
    format!("an:agents:{}", ymd(ts))
}

/// A model or framework name that is safe to use as a counter label.
pub fn clean_label(value: &Value) -> Option<String> {
    let s = value.as_str()?.trim().to_lowercase();
    let ok = !s.is_empty()
        && s.len() <= 64
        && s != "unknown"
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c));
    ok.then_some(s)
}

/// The framework the project's own seed trails declare. A seed is not an agent that solved something in the field:
/// it is counted under its own label and never under the model name it carries.
pub const SEED_FRAMEWORK: &str = "myrmo-seed";
/// Labels under which seed trails are counted. `seed-factory` is what trails laid before seeds had their own label.
pub const SEED_LABELS: [&str; 2] = ["seed", "seed-factory"];

pub fn is_seed(agent_info: &Value) -> bool {
    agent_info["framework"]
        .as_str()
        .is_some_and(|f| f.eq_ignore_ascii_case(SEED_FRAMEWORK))
}

/// The model and framework labels a laid trail is counted under.
pub fn laid_labels(agent_info: &Value) -> (Option<String>, Option<String>) {
    let model = if is_seed(agent_info) {
        Some("seed".to_string())
    } else {
        clean_label(&agent_info["model"])
    };
    (model, clean_label(&agent_info["framework"]))
}

/// Add `Metric|label` increments to a pipeline, unless the day is already full of labels.
pub async fn record(
    con: &mut ConnectionManager,
    ts: i64,
    increments: &[(&str, Option<String>, i64)],
) {
    let key = day_key(ts);
    let fields: usize = redis::cmd("HLEN")
        .arg(&key)
        .query_async(con)
        .await
        .unwrap_or(0);
    let mut pipe = redis::pipe();
    for (metric, label, by) in increments {
        let field = match label {
            Some(l) => format!("{metric}|{l}"),
            None => (*metric).to_string(),
        };
        // Totals always count; labelled fields stop at the cap so a client cannot grow the hash forever.
        if label.is_some() && fields >= MAX_FIELDS_PER_DAY {
            continue;
        }
        pipe.cmd("HINCRBY").arg(&key).arg(field).arg(*by).ignore();
    }
    if let Err(err) = pipe.query_async::<()>(con).await {
        tracing::warn!(error = %err, "analytics write failed");
    }
}

const MAX_FINGERPRINTS_PER_DAY: isize = 5000;
const MAX_META: usize = 20_000;
const META_KEY: &str = "an:missmeta";

fn queries_key(kind: &str, ts: i64) -> String {
    format!("an:q:{kind}:{}", ymd(ts))
}

/// A short label (runtime, error class) that is safe to keep and show: letters, digits, spaces, `_`, `.` and `-`,
/// at most 64 characters. Anything else (a URL, an address, punctuation that could carry a sentence) gives an
/// empty label. The text comes from a client, so it is checked when it is stored and again when it is read.
fn safe_label(text: &str) -> String {
    let t = text.trim();
    let ok = t.chars().count() <= 64
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '-'));
    if !ok {
        return String::new();
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Distinct agents that missed a fingerprint, as a HyperLogLog that keeps no id.
fn agents_key(fp: &str) -> String {
    format!("an:qa:{fp}")
}

/// How many fingerprints got an agent counter today, so a flood of made-up errors cannot grow Redis.
fn agent_counters_key(ts: i64) -> String {
    format!("an:qn:{}", ymd(ts))
}

const MAX_AGENT_COUNTERS_PER_DAY: i64 = 2000;
const AGENT_COUNTER_TTL: i64 = 60 * 86_400;

/// Count `agent` among those who missed `fp` and say how many distinct agents that is. A caller without a
/// declared id is a search but not an agent: its daily address hash would count the same person again every day.
async fn count_miss_agent(
    con: &mut ConnectionManager,
    ts: i64,
    fp: &str,
    agent: Option<&str>,
) -> u64 {
    let key = agents_key(fp);
    if let Some(agent) = agent {
        let exists: bool = redis::cmd("EXISTS")
            .arg(&key)
            .query_async(con)
            .await
            .unwrap_or(true);
        if !exists {
            let day = agent_counters_key(ts);
            let made: i64 = redis::cmd("INCR")
                .arg(&day)
                .query_async(con)
                .await
                .unwrap_or(i64::MAX);
            let _: redis::RedisResult<()> = redis::cmd("EXPIRE")
                .arg(&day)
                .arg(172_800)
                .query_async(con)
                .await;
            if made > MAX_AGENT_COUNTERS_PER_DAY {
                return 0;
            }
        }
        let mut pipe = redis::pipe();
        pipe.cmd("PFADD").arg(&key).arg(agent).ignore();
        pipe.cmd("EXPIRE").arg(&key).arg(AGENT_COUNTER_TTL).ignore();
        if let Err(err) = pipe.query_async::<()>(con).await {
            tracing::warn!(error = %err, "agent counter write failed");
        }
    }
    redis::cmd("PFCOUNT")
        .arg(&key)
        .query_async(con)
        .await
        .unwrap_or(0)
}

/// What one lookup tells the analytics.
pub struct Lookup<'a> {
    pub fp: &'a str,
    pub runtime: &'a str,
    pub error_type: &'a str,
    pub answered: bool,
    pub model: Option<String>,
    /// The agent id the caller declared, if it did.
    pub agent: Option<&'a str>,
    /// Distinct agents that must have missed a fingerprint before its runtime and error class are kept.
    pub min_agents: u64,
}

/// One lookup by an agent: answered or not, counted per fingerprint and per model.
/// Query text is never stored. For unanswered fingerprints only the runtime and the error
/// class are kept (for example `python` and `ModuleNotFoundError`), so "what do agents want
/// that nobody has solved" can be answered without keeping anything a user typed.
pub async fn record_search(con: &mut ConnectionManager, ts: i64, l: &Lookup<'_>) {
    let answered = l.answered;
    let fp = l.fp;
    let mut totals = vec![
        ("searches", None, 1),
        (
            if answered {
                "search_hits"
            } else {
                "search_misses"
            },
            None,
            1,
        ),
        ("searched", l.model.clone(), 1),
    ];
    if !answered {
        totals.push(("search_miss", l.model.clone(), 1));
    }
    record(con, ts, &totals).await;

    let key = queries_key(if answered { "hit" } else { "miss" }, ts);
    let mut pipe = redis::pipe();
    pipe.cmd("ZINCRBY").arg(&key).arg(1).arg(fp).ignore();
    // Bound the set: keep the most frequent fingerprints of the day.
    pipe.cmd("ZREMRANGEBYRANK")
        .arg(&key)
        .arg(0)
        .arg(-(MAX_FINGERPRINTS_PER_DAY + 1))
        .ignore();
    if !answered {
        // The runtime and the error class are text a client wrote. They are kept only once enough distinct
        // agents have asked for the same fingerprint, so what is kept is generic by construction.
        let agents = count_miss_agent(con, ts, fp, l.agent).await;
        let known: usize = redis::cmd("HLEN")
            .arg(META_KEY)
            .query_async(con)
            .await
            .unwrap_or(0);
        if agents >= l.min_agents && known < MAX_META {
            pipe.cmd("HSETNX")
                .arg(META_KEY)
                .arg(fp)
                .arg(json!([safe_label(l.runtime), safe_label(l.error_type)]).to_string())
                .ignore();
        }
    }
    if let Err(err) = pipe.query_async::<()>(con).await {
        tracing::warn!(error = %err, "search analytics write failed");
    }
}

/// Distinct agents that missed each fingerprint (0 when nobody with an id did), in the order given.
async fn miss_agents(con: &mut ConnectionManager, fps: &[&str]) -> redis::RedisResult<Vec<u64>> {
    let mut pipe = redis::pipe();
    for fp in fps {
        pipe.cmd("PFCOUNT").arg(agents_key(fp));
    }
    pipe.query_async(con).await
}

/// Errors agents asked for and nobody has solved, most requested first, over `days` days. Only fingerprints that
/// `min_agents` distinct agents missed are listed: one agent repeating a search is not demand, and a label seen by
/// a single agent is not safe to show.
pub async fn demand(
    con: &mut ConnectionManager,
    days: i64,
    limit: usize,
    min_agents: u64,
) -> redis::RedisResult<Vec<Value>> {
    let now = keys::now();
    let mut total: BTreeMap<String, f64> = BTreeMap::new();
    for d in 0..days {
        let rows: Vec<(String, f64)> = redis::cmd("ZREVRANGE")
            .arg(queries_key("miss", now - d * 86_400))
            .arg(0)
            .arg(99)
            .arg("WITHSCORES")
            .query_async(con)
            .await?;
        for (fp, n) in rows {
            *total.entry(fp).or_default() += n;
        }
    }
    let mut list: Vec<(String, f64)> = total.into_iter().collect();
    list.sort_by(|a, b| b.1.total_cmp(&a.1));
    let fps: Vec<&str> = list.iter().map(|(fp, _)| fp.as_str()).collect();
    let agents = miss_agents(con, &fps).await?;
    let mut out = Vec::new();
    for ((fp, n), distinct) in list.iter().zip(agents) {
        if distinct < min_agents {
            continue;
        }
        let meta: Option<String> = redis::cmd("HGET")
            .arg(META_KEY)
            .arg(fp)
            .query_async(con)
            .await?;
        let parsed: Vec<String> = meta
            .and_then(|m| serde_json::from_str(&m).ok())
            .unwrap_or_default();
        out.push(json!({
            "fingerprint": fp,
            // Checked again on the way out: older rows were stored before labels were checked.
            "runtime": parsed.first().map(|t| safe_label(t)).unwrap_or_default(),
            "error_type": parsed.get(1).map(|t| safe_label(t)).unwrap_or_default(),
            "searches": *n as u64,
            "agents": distinct,
        }));
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// How much demand there is for each of these fingerprints (searches in the last `days` days, distinct agents), for an
/// operator who knows which errors a seed could cover. Nothing is listed that the operator did not ask about.
pub async fn demand_for(
    con: &mut ConnectionManager,
    fps: &[String],
    days: i64,
) -> redis::RedisResult<Vec<Value>> {
    let now = keys::now();
    let mut pipe = redis::pipe();
    for fp in fps {
        for d in 0..days {
            pipe.cmd("ZSCORE")
                .arg(queries_key("miss", now - d * 86_400))
                .arg(fp);
        }
    }
    let scores: Vec<Option<f64>> = pipe.query_async(con).await?;
    let refs: Vec<&str> = fps.iter().map(String::as_str).collect();
    let agents = miss_agents(con, &refs).await?;
    Ok(fps
        .iter()
        .zip(agents)
        .enumerate()
        .map(|(i, (fp, distinct))| {
            let start = i * days as usize;
            let searches: f64 = scores[start..start + days as usize].iter().flatten().sum();
            json!({ "fingerprint": fp, "searches": searches as u64, "agents": distinct })
        })
        .collect())
}

/// Parsed rows for the last `days` days, newest first.
pub async fn export(con: &mut ConnectionManager, days: i64) -> redis::RedisResult<Vec<Value>> {
    let now = keys::now();
    let stamps: Vec<i64> = (0..days).map(|d| now - d * 86_400).collect();
    let mut pipe = redis::pipe();
    for ts in &stamps {
        pipe.cmd("HGETALL").arg(day_key(*ts));
        pipe.cmd("PFCOUNT").arg(agents_day_key(*ts));
    }
    let raw: Vec<redis::Value> = pipe.query_async(con).await?;
    let mut rows = Vec::new();
    for (i, ts) in stamps.iter().enumerate() {
        let hash: std::collections::HashMap<String, String> =
            redis::from_redis_value(raw[2 * i].clone()).unwrap_or_default();
        let agents: u64 = redis::from_redis_value(raw[2 * i + 1].clone()).unwrap_or(0);
        if hash.is_empty() && agents == 0 {
            continue;
        }
        rows.push(row(&ymd(*ts), agents, &hash));
    }
    Ok(rows)
}

fn row(date: &str, agents: u64, hash: &std::collections::HashMap<String, String>) -> Value {
    let mut totals = Map::new();
    let mut models: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut frameworks: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for (field, n) in hash {
        let n: i64 = n.parse().unwrap_or(0);
        match field.split_once('|') {
            None => {
                totals.insert(field.clone(), json!(n));
            }
            Some((metric, label)) if metric.starts_with("fw_") => {
                frameworks
                    .entry(label.to_string())
                    .or_default()
                    .insert(metric[3..].to_string(), json!(n));
            }
            Some((metric, label)) => {
                models
                    .entry(label.to_string())
                    .or_default()
                    .insert(metric.to_string(), json!(n));
            }
        }
    }
    json!({
        "date": format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]),
        "agents_active": agents,
        "totals": totals,
        "models": models,
        "frameworks": frameworks,
    })
}

/// Per-model totals over the exported days, strongest first: trails laid, trails
/// independently re-discovered, fixes confirmed and failures reported.
pub fn model_leaderboard(rows: &[Value], limit: usize) -> Vec<Value> {
    let mut total: BTreeMap<String, [i64; 5]> = BTreeMap::new();
    for r in rows {
        for (model, m) in r["models"].as_object().into_iter().flatten() {
            let t = total.entry(model.clone()).or_default();
            let n = |k: &str| m[k].as_i64().unwrap_or(0);
            t[0] += n("laid");
            t[1] += n("rediscovered");
            t[2] += n("worked") + n("partially_worked");
            t[3] += n("failed");
            t[4] += n("laid") + n("rediscovered") + n("worked");
        }
    }
    // Seeds are not models: they are reported apart (see `seed_laid`).
    let mut list: Vec<_> = total
        .into_iter()
        .filter(|(model, _)| !SEED_LABELS.contains(&model.as_str()))
        .collect();
    list.sort_by_key(|(_, t)| std::cmp::Reverse(t[4]));
    list.into_iter()
        .take(limit)
        .map(|(model, t)| {
            json!({
                "model": model,
                "trails_laid": t[0],
                "rediscovered": t[1],
                "fixes_confirmed": t[2],
                "failures_reported": t[3],
            })
        })
        .collect()
}

/// Seed trails laid over the exported days.
pub fn seed_laid(rows: &[Value]) -> i64 {
    rows.iter()
        .flat_map(|r| {
            SEED_LABELS
                .iter()
                .map(move |l| r["models"][*l]["laid"].as_i64().unwrap_or(0))
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_is_counted_as_a_seed_whatever_model_it_names() {
        let seed = json!({"model": "claude-opus-5-5", "framework": "myrmo-seed"});
        assert!(is_seed(&seed));
        assert_eq!(laid_labels(&seed).0.as_deref(), Some("seed"));
        let field = json!({"model": "claude-opus-5-5", "framework": "claude-code"});
        assert!(!is_seed(&field));
        assert_eq!(laid_labels(&field).0.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn models_leave_out_seeds_and_the_seed_total_counts_them() {
        let hash = [
            ("laid|seed", "9"),
            ("laid|seed-factory", "10"),
            ("laid|gpt-5", "2"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let r = row("20261002", 1, &hash);
        let board = model_leaderboard(std::slice::from_ref(&r), 10);
        assert_eq!(board.len(), 1);
        assert_eq!(board[0]["model"], "gpt-5");
        assert_eq!(seed_laid(&[r]), 19);
    }

    #[test]
    fn labels_are_validated() {
        assert_eq!(
            clean_label(&json!("Claude-Opus-5-5")).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(
            clean_label(&json!("qwen3-coder:480b")).as_deref(),
            Some("qwen3-coder:480b")
        );
        assert_eq!(clean_label(&json!("unknown")), None);
        assert_eq!(clean_label(&json!("has space")), None);
        assert_eq!(clean_label(&json!("<script>")), None);
        assert_eq!(clean_label(&json!("a".repeat(65))), None);
        assert_eq!(clean_label(&json!(42)), None);
    }

    #[test]
    fn labels_that_could_carry_more_than_an_error_class_are_dropped() {
        assert_eq!(safe_label("ModuleNotFoundError"), "ModuleNotFoundError");
        assert_eq!(
            safe_label("  java.lang.IllegalStateException "),
            "java.lang.IllegalStateException"
        );
        assert_eq!(safe_label("HTTP 403"), "HTTP 403");
        assert_eq!(
            safe_label("checkstyle   MethodName"),
            "checkstyle MethodName"
        );
        for bad in [
            "see https://example.test/fix",
            "ops@example.test",
            "<script>alert(1)</script>",
            "rm -rf /; echo done",
            "key=value",
            "Fehler: ungültig",
            &"a".repeat(65),
        ] {
            assert_eq!(safe_label(bad), "", "{bad}");
        }
    }

    #[test]
    fn rows_group_counters_by_model_and_framework() {
        let hash = [
            ("trails", "3"),
            ("laid|gpt-5", "2"),
            ("worked|gpt-5", "5"),
            ("failed|gpt-5", "1"),
            ("laid|claude-opus-5-5", "1"),
            ("fw_laid|langchain", "3"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let r = row("20261002", 7, &hash);
        assert_eq!(r["date"], "2026-10-02");
        assert_eq!(r["totals"]["trails"], 3);
        assert_eq!(r["models"]["gpt-5"]["worked"], 5);
        assert_eq!(r["frameworks"]["langchain"]["laid"], 3);
        let board = model_leaderboard(&[r], 5);
        assert_eq!(board[0]["model"], "gpt-5");
        assert_eq!(board[0]["fixes_confirmed"], 5);
        assert_eq!(board[1]["model"], "claude-opus-5-5");
    }
}
