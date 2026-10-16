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

/// Whether a trail declares the seed framework. Anyone can declare it: it decides how the trail is counted, never
/// whether the colony vouches for it (see [`shown_as_seed`]).
pub fn is_seed(agent_info: &Value) -> bool {
    agent_info["framework"]
        .as_str()
        .is_some_and(|f| f.eq_ignore_ascii_case(SEED_FRAMEWORK))
}

/// Until this moment (2026-10-17T00:00:00Z) the colony believed the declaration, and every trail that made it was laid
/// by the project; since then a seed is published with the operator token.
pub const SEEDS_BY_DECLARATION_UNTIL: i64 = 1_792_195_200;

/// Whether the colony shows a stored trail as a seed laid by the project: it declared the seed framework and was
/// published with the operator token (`seed` in its stored payload, set when it was indexed), or was laid before that
/// was required.
pub fn shown_as_seed(payload: &Value) -> bool {
    payload["seed"].as_bool() == Some(true)
        || (is_seed(&payload["trail"]["agent_info"])
            && payload["created_ts"]
                .as_i64()
                .is_some_and(|ts| ts < SEEDS_BY_DECLARATION_UNTIL))
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

/// Labels of the project's own checks and load tests. They are not agents in the field, so the public figures leave
/// them out; the operator's analytics still show them.
pub const INTERNAL_LABELS: [&str; 2] = ["live-check", "synthetic"];

/// The leaderboard `/v1/stats` shows: models that did something the colony counts, without its own checks.
pub fn public_leaderboard(rows: &[Value], limit: usize) -> Vec<Value> {
    model_leaderboard(rows, usize::MAX)
        .into_iter()
        .filter(|m| !INTERNAL_LABELS.contains(&m["model"].as_str().unwrap_or_default()))
        .filter(|m| {
            [
                "trails_laid",
                "rediscovered",
                "fixes_confirmed",
                "failures_reported",
            ]
            .iter()
            .any(|k| m[*k].as_i64().unwrap_or(0) > 0)
        })
        .take(limit)
        .collect()
}

/// Why a trail was rejected after it was queued: the judgement's verdicts, and the two failures that leave it unjudged. Counted per day, never with any text.
pub const REJECTION_REASONS: [&str; 6] = [
    "prompt_injection",
    "sensitive_content",
    "low_quality",
    "risky_command_in_prose",
    "enrichment_failed",
    "invalid_trail",
];
/// Why a trail was refused before it was queued (the error code the publisher received).
pub const REFUSAL_CODES: [&str; 3] = ["invalid_trail", "publish_limited", "busy"];

/// Count one trail rejected by the judgement, in total and under each reason (the fixed set above).
pub async fn record_rejection(con: &mut ConnectionManager, ts: i64, reasons: &[&str]) {
    let named: Vec<String> = reasons
        .iter()
        .filter(|r| REJECTION_REASONS.contains(r))
        .map(|r| format!("rejected_{r}"))
        .collect();
    let mut increments: Vec<(&str, Option<String>, i64)> = vec![("rejected", None, 1)];
    increments.extend(named.iter().map(|n| (n.as_str(), None, 1)));
    record(con, ts, &increments).await;
}

/// Count one publish refused at the door (an invalid trail, the hourly quota, a full queue).
pub async fn record_refusal(con: &mut ConnectionManager, ts: i64, code: &str) {
    if REFUSAL_CODES.contains(&code) {
        let field = format!("refused_{code}");
        record(con, ts, &[(field.as_str(), None, 1)]).await;
    }
}

/// What became of the trails agents sent over the exported days: how many the colony judged, how many it rejected and
/// why, and how many were refused at the door. Counts only.
pub fn rejections(rows: &[Value]) -> Value {
    let total = |k: &str| -> i64 {
        rows.iter()
            .map(|r| r["totals"][k].as_i64().unwrap_or(0))
            .sum()
    };
    let laid: i64 = rows
        .iter()
        .flat_map(|r| {
            r["models"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values().map(|v| v["laid"].as_i64().unwrap_or(0)))
        })
        .sum();
    let rejected = total("rejected");
    json!({
        "judged": laid + rejected,
        "rejected": rejected,
        "by_reason": REJECTION_REASONS.iter().map(|r| (r.to_string(), json!(total(&format!("rejected_{r}"))))).collect::<Map<String, Value>>(),
        "refused_at_the_door": REFUSAL_CODES.iter().map(|c| (c.to_string(), json!(total(&format!("refused_{c}"))))).collect::<Map<String, Value>>(),
    })
}

const REFUSED: &str = "admin:refused";
const REFUSED_LAST: &str = "admin:refused:last";
const REFUSED_KEEP: isize = 100;
const REFUSED_TTL: i64 = 30 * 86_400;
/// Addresses not on the list yet that may be added in one minute. Every refused connection is noted before any quota
/// applies, so without it a caller rotating addresses would rewrite the list as fast as it can connect.
const REFUSED_NEW_PER_MINUTE: u32 = 20;

/// New addresses noted in one minute (counter).
fn refused_new(minute: i64) -> String {
    format!("admin:refused:new:{minute}")
}

/// One script, so that the counts, the last times and the cut always agree: an address cut from the counts leaves the
/// times too, and the times never outgrow the counts (Valkey runs without eviction, and a key that only grows fills
/// it). A times hash left larger by an earlier version is rebuilt from the counts the first time it is written.
const NOTE_REFUSED: &str = r"
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local fresh = redis.call('INCR', KEYS[3])
  if fresh == 1 then redis.call('EXPIRE', KEYS[3], 120) end
  if fresh > tonumber(ARGV[5]) then return 0 end
end
redis.call('ZINCRBY', KEYS[1], 1, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local keep = tonumber(ARGV[4])
local extra = redis.call('ZCARD', KEYS[1]) - keep
if extra > 0 then
  local gone = redis.call('ZRANGE', KEYS[1], 0, extra - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, extra - 1)
  redis.call('HDEL', KEYS[2], unpack(gone))
end
if redis.call('HLEN', KEYS[2]) > keep then
  local names = redis.call('ZRANGE', KEYS[1], 0, -1)
  local times = redis.call('HMGET', KEYS[2], unpack(names))
  redis.call('UNLINK', KEYS[2])
  for i, name in ipairs(names) do
    if times[i] then redis.call('HSET', KEYS[2], name, times[i]) end
  end
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
";

/// A connection refused because its network is not allowed: the address, a count and the last time. The operator's
/// own network, kept 30 days at most and cut to the 100 addresses seen most. At most 20 addresses not on the list are
/// added a minute; past that, connections from new addresses are refused without being noted.
pub async fn note_refused_network(con: &mut ConnectionManager, address: &str, now: i64) {
    let result: redis::RedisResult<i64> = redis::cmd("EVAL")
        .arg(NOTE_REFUSED)
        .arg(3)
        .arg(REFUSED)
        .arg(REFUSED_LAST)
        .arg(refused_new(now / 60))
        .arg(address)
        .arg(now)
        .arg(REFUSED_TTL)
        .arg(REFUSED_KEEP)
        .arg(REFUSED_NEW_PER_MINUTE)
        .query_async(con)
        .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "refused connection not noted");
    }
}

/// The refused addresses, most recent first: (address, count, last).
pub async fn refused_networks(
    con: &mut ConnectionManager,
) -> redis::RedisResult<Vec<(String, i64, i64)>> {
    let counted: Vec<(String, f64)> = redis::cmd("ZRANGE")
        .arg(REFUSED)
        .arg(0)
        .arg(-1)
        .arg("WITHSCORES")
        .query_async(con)
        .await?;
    let last: std::collections::HashMap<String, i64> = redis::cmd("HGETALL")
        .arg(REFUSED_LAST)
        .query_async(con)
        .await?;
    let mut rows: Vec<(String, i64, i64)> = counted
        .into_iter()
        .map(|(a, n)| {
            let at = last.get(&a).copied().unwrap_or(0);
            (a, n as i64, at)
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.2));
    Ok(rows)
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
    fn rejections_are_counted_by_reason_and_never_with_text() {
        let day = |hash: &[(&str, &str)]| {
            let h = hash
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            row("20261013", 1, &h)
        };
        let rows = [
            day(&[
                ("laid|claude-opus-5-5", "6"),
                ("laid|seed", "4"),
                ("rejected", "3"),
                ("rejected_prompt_injection", "1"),
                ("rejected_sensitive_content", "2"),
                ("refused_invalid_trail", "5"),
            ]),
            day(&[
                ("rejected", "1"),
                ("rejected_low_quality", "1"),
                ("refused_busy", "2"),
            ]),
        ];
        let r = rejections(&rows);
        assert_eq!(r["judged"], 14, "ten laid and four rejected");
        assert_eq!(r["rejected"], 4);
        assert_eq!(r["by_reason"]["sensitive_content"], 2);
        assert_eq!(r["by_reason"]["prompt_injection"], 1);
        assert_eq!(r["by_reason"]["low_quality"], 1);
        assert_eq!(r["refused_at_the_door"]["invalid_trail"], 5);
        assert_eq!(r["refused_at_the_door"]["busy"], 2);
        assert_eq!(r["refused_at_the_door"]["publish_limited"], 0);
        assert_eq!(rejections(&[])["judged"], 0);
    }

    #[test]
    fn the_public_leaderboard_leaves_out_checks_and_models_that_did_nothing() {
        let hash = [
            ("laid|claude-opus-5-5", "2"),
            ("worked|live-check", "1"),
            ("laid|synthetic", "50"),
            ("searches|copilot", "4"),
            ("failed|gpt-5", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let r = row("20261010", 1, &hash);
        let public: Vec<_> = public_leaderboard(std::slice::from_ref(&r), 10)
            .iter()
            .map(|m| m["model"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(public, ["claude-opus-5-5", "gpt-5"]);
        let all = model_leaderboard(&[r], 10);
        assert!(
            all.iter().any(|m| m["model"] == "live-check"),
            "the operator still sees it"
        );
    }

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
    fn only_the_project_lays_a_trail_shown_as_a_seed() {
        let declared = json!({"model": "seed-factory", "framework": "myrmo-seed"});
        let after = SEEDS_BY_DECLARATION_UNTIL + 60;
        // Declaring the framework is not enough any more...
        let spoofed = json!({ "created_ts": after, "trail": { "agent_info": declared } });
        assert!(!shown_as_seed(&spoofed));
        // ...it takes the operator token, which marks the payload when the trail is indexed.
        let marked =
            json!({ "created_ts": after, "seed": true, "trail": { "agent_info": declared } });
        assert!(shown_as_seed(&marked));
        // The seeds laid before stay seeds.
        let laid_before = json!({ "created_ts": SEEDS_BY_DECLARATION_UNTIL - 86_400, "trail": { "agent_info": declared } });
        assert!(shown_as_seed(&laid_before));
        let field = json!({ "created_ts": 1, "trail": { "agent_info": {"model": "gpt-5", "framework": "codex"} } });
        assert!(!shown_as_seed(&field));
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
