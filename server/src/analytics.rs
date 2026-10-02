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

/// A coarse, bounded label (runtime, error class) that is safe to store and show.
fn coarse(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_string()
}

/// One lookup by an agent: answered or not, counted per fingerprint and per model.
/// Query text is never stored. For unanswered fingerprints only the runtime and the error
/// class are kept (for example `python` and `ModuleNotFoundError`), so "what do agents want
/// that nobody has solved" can be answered without keeping anything a user typed.
pub async fn record_search(
    con: &mut ConnectionManager,
    ts: i64,
    fp: &str,
    runtime: &str,
    error_type: &str,
    answered: bool,
    model: Option<String>,
) {
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
        ("searched", model.clone(), 1),
    ];
    if !answered {
        totals.push(("search_miss", model, 1));
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
        let known: usize = redis::cmd("HLEN")
            .arg(META_KEY)
            .query_async(con)
            .await
            .unwrap_or(0);
        if known < MAX_META {
            pipe.cmd("HSETNX")
                .arg(META_KEY)
                .arg(fp)
                .arg(json!([coarse(runtime), coarse(error_type)]).to_string())
                .ignore();
        }
    }
    if let Err(err) = pipe.query_async::<()>(con).await {
        tracing::warn!(error = %err, "search analytics write failed");
    }
}

/// Errors agents asked for and nobody has solved, most requested first, over `days` days.
pub async fn demand(
    con: &mut ConnectionManager,
    days: i64,
    limit: usize,
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
    list.truncate(limit);
    let mut out = Vec::new();
    for (fp, n) in list {
        let meta: Option<String> = redis::cmd("HGET")
            .arg(META_KEY)
            .arg(&fp)
            .query_async(con)
            .await?;
        let parsed: Vec<String> = meta
            .and_then(|m| serde_json::from_str(&m).ok())
            .unwrap_or_default();
        out.push(json!({
            "fingerprint": fp,
            "runtime": parsed.first().cloned().unwrap_or_default(),
            "error_type": parsed.get(1).cloned().unwrap_or_default(),
            "searches": n as u64,
        }));
    }
    Ok(out)
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
    let mut list: Vec<_> = total.into_iter().collect();
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

#[cfg(test)]
mod tests {
    use super::*;

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
