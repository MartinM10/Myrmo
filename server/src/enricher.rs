//! Background enrichment. Consumes published trails from a Redis Stream consumer
//! group, so any number of enrichers can run side by side, and folds outcome counters
//! into the vector index in batches.

use crate::decision::{self, Judgement};
use crate::keys;
use crate::redact::{self, Report};
use crate::state::AppState;
use crate::{fingerprint, risk, strength};
use anyhow::{Context, Result};
use redis::AsyncCommands;
use redis::streams::{StreamId, StreamReadOptions, StreamReadReply};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const BATCH: usize = 16;
const MAX_ATTEMPTS: i64 = 5;
const RECLAIM_IDLE_MS: u64 = 60_000;

pub async fn run(st: AppState) -> Result<()> {
    let mut con = st.redis();
    let created: redis::RedisResult<()> = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(keys::STREAM)
        .arg(keys::GROUP)
        .arg("0")
        .arg("MKSTREAM")
        .query_async(&mut con)
        .await;
    if let Err(err) = created
        && !err.to_string().contains("BUSYGROUP")
    {
        return Err(err.into());
    }
    tokio::spawn(flush_loop(st.clone()));
    tracing::info!(consumer = %st.cfg.consumer_name, "enricher started");

    let mut last_reclaim = Instant::now();
    loop {
        let mut entries = Vec::new();
        if last_reclaim.elapsed() > Duration::from_secs(30) {
            entries.extend(reclaim(&st).await.unwrap_or_default());
            last_reclaim = Instant::now();
        }
        let opts = StreamReadOptions::default()
            .group(keys::GROUP, &st.cfg.consumer_name)
            .count(BATCH);
        let reply: Option<StreamReadReply> =
            match con.xread_options(&[keys::STREAM], &[">"], &opts).await {
                Ok(reply) => reply,
                Err(err) => {
                    tracing::warn!(error = %err, "cannot read the stream");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
        entries.extend(reply.into_iter().flat_map(|r| r.keys).flat_map(|k| k.ids));
        if entries.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        futures::future::join_all(entries.into_iter().map(|entry| handle(st.clone(), entry))).await;
    }
}

/// Entries another enricher took but never acknowledged (it crashed or timed out).
async fn reclaim(st: &AppState) -> Result<Vec<StreamId>> {
    let value: redis::Value = redis::cmd("XAUTOCLAIM")
        .arg(keys::STREAM)
        .arg(keys::GROUP)
        .arg(&st.cfg.consumer_name)
        .arg(RECLAIM_IDLE_MS)
        .arg("0-0")
        .arg("COUNT")
        .arg(BATCH)
        .query_async(&mut st.redis())
        .await?;
    // Reply: [next_cursor, [[id, [field, value, ...]], ...], [deleted ids]]
    let redis::Value::Array(parts) = value else {
        return Ok(vec![]);
    };
    let Some(redis::Value::Array(items)) = parts.get(1) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for item in items {
        let redis::Value::Array(pair) = item else {
            continue;
        };
        let (Some(id), Some(redis::Value::Array(fields))) = (pair.first(), pair.get(1)) else {
            continue;
        };
        let id: String = redis::from_redis_value_ref(id).unwrap_or_default();
        let mut map = HashMap::new();
        for chunk in fields.chunks(2) {
            if let [k, v] = chunk {
                let key: String = redis::from_redis_value_ref(k).unwrap_or_default();
                map.insert(key, v.clone());
            }
        }
        out.push(StreamId {
            id,
            map,
            ..Default::default()
        });
    }
    Ok(out)
}

async fn handle(st: AppState, entry: StreamId) {
    let id: String = entry.get("id").unwrap_or_default();
    let raw: String = entry.get("trail").unwrap_or_default();
    let mut con = st.redis();
    let attempts: i64 = con
        .hincr(keys::trail(&id), "attempts", 1)
        .await
        .unwrap_or(1);

    let result = if attempts > MAX_ATTEMPTS {
        reject(&st, &id, &["enrichment_failed"]).await
    } else {
        match serde_json::from_str::<Value>(&raw) {
            Ok(trail) => enrich(&st, &id, trail).await,
            Err(_) => reject(&st, &id, &["invalid_trail"]).await,
        }
    };
    match result {
        Ok(()) => {
            let _: redis::RedisResult<()> = redis::pipe()
                .cmd("XACK")
                .arg(keys::STREAM)
                .arg(keys::GROUP)
                .arg(&entry.id)
                .ignore()
                .cmd("XDEL")
                .arg(keys::STREAM)
                .arg(&entry.id)
                .ignore()
                .query_async(&mut con)
                .await;
        }
        // Left pending; another pass (or another enricher) retries after RECLAIM_IDLE_MS.
        Err(err) => {
            tracing::warn!(trail = %id, attempts, error = %err, "enrichment failed, will retry")
        }
    }
}

async fn reject(st: &AppState, id: &str, reasons: &[&str]) -> Result<()> {
    let _: () = redis::pipe()
        .cmd("HSET")
        .arg(keys::trail(id))
        .arg("status")
        .arg("rejected")
        .arg("reasons")
        .arg(json!(reasons).to_string())
        .ignore()
        .cmd("EXPIRE")
        .arg(keys::trail(id))
        .arg(7 * 86_400)
        .ignore()
        .query_async(&mut st.redis())
        .await?;
    tracing::info!(trail = %id, ?reasons, "trail rejected");
    Ok(())
}

fn same_environment(a: &Value, b: &Value) -> bool {
    let s = |v: &Value, p: &str| {
        v.pointer(p)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
    };
    let minor = |v: &Value| {
        s(v, "/runtime/version")
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".")
    };
    s(a, "/os") == s(b, "/os")
        && s(a, "/runtime/name") == s(b, "/runtime/name")
        && minor(a) == minor(b)
}

/// Text embedded for semantic search: what a searching agent will most likely type.
fn embedding_text(trail: &Value) -> String {
    let s = |p: &str| trail.pointer(p).and_then(Value::as_str).unwrap_or_default();
    let message = fingerprint::message_for_problem(&trail["problem"]);
    let error_type = s("/problem/error_type");
    let head = if message.starts_with(error_type) {
        message.clone()
    } else {
        format!("{error_type}: {message}")
    };
    format!(
        "{head}\n{}\n{} {} on {}",
        s("/problem/summary"),
        s("/environment/runtime/name"),
        s("/environment/runtime/version"),
        s("/environment/os")
    )
}

fn label(trail: &Value) -> String {
    let error_type = trail
        .pointer("/problem/error_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = fingerprint::message_for_problem(&trail["problem"]);
    let message = message
        .strip_prefix(&format!("{error_type}:"))
        .unwrap_or(&message)
        .trim();
    let text = if message.is_empty() {
        error_type.to_string()
    } else {
        message.to_string()
    };
    text.chars().take(80).collect()
}

async fn enrich(st: &AppState, id: &str, mut trail: Value) -> Result<()> {
    // Second redaction pass: the gateway already ran it, rules may have been updated since.
    redact::redact_value(&mut trail, &mut Report::new());
    let fp = fingerprint::of_trail(&trail);

    let judgement: Judgement = st.decision.judge(&trail).await;
    let mut reasons = Vec::new();
    if judgement.injection >= decision::INJECTION_THRESHOLD {
        reasons.push("prompt_injection");
    }
    if judgement.sensitive >= decision::SENSITIVE_THRESHOLD {
        reasons.push("sensitive_content");
    }
    if judgement.quality < decision::MIN_QUALITY {
        reasons.push("low_quality");
    }
    if !reasons.is_empty() {
        return reject(st, id, &reasons).await;
    }

    let mut con = st.redis();
    let now = keys::now();
    let agent_info = trail["agent_info"].clone();
    let framework = agent_info["framework"]
        .as_str()
        .unwrap_or("agent")
        .to_string();

    // An equivalent trail for the same environment exists: the independent re-discovery
    // counts as a success for it instead of creating a duplicate.
    let siblings: Vec<String> = con.smembers(keys::fingerprint(&fp)).await?;
    if !siblings.is_empty() {
        let existing = st.qdrant.get(&siblings).await?;
        if let Some((existing_id, _)) = existing
            .iter()
            .find(|(_, p)| same_environment(&p["trail"]["environment"], &trail["environment"]))
        {
            let event = json!({
                "kind": "reinforced", "agent": agent_info, "trail_id": existing_id,
                "text": format!("via {framework} rediscovered and reinforced {}", &existing_id[..8]), "at": keys::iso(now)
            });
            let _: () = redis::pipe()
                .cmd("HINCRBY")
                .arg(keys::outcomes(existing_id))
                .arg("worked")
                .arg(1)
                .ignore()
                .cmd("HSET")
                .arg(keys::outcomes(existing_id))
                .arg("last_success_ts")
                .arg(now)
                .ignore()
                .cmd("SADD")
                .arg(keys::DIRTY)
                .arg(existing_id)
                .ignore()
                .cmd("ZADD")
                .arg(keys::FEED)
                .arg(now)
                .arg(existing_id)
                .ignore()
                .cmd("DEL")
                .arg(keys::fingerprint_cache(&fp))
                .ignore()
                .cmd("HSET")
                .arg(keys::trail(id))
                .arg("status")
                .arg("merged")
                .arg("merged_into")
                .arg(existing_id)
                .ignore()
                .cmd("LPUSH")
                .arg(keys::ACTIVITY)
                .arg(event.to_string())
                .ignore()
                .cmd("LTRIM")
                .arg(keys::ACTIVITY)
                .arg(0)
                .arg(199)
                .ignore()
                .query_async(&mut con)
                .await?;
            tracing::info!(trail = %id, into = %existing_id, "trail merged");
            return Ok(());
        }
    }

    let risk = risk::assess(&trail);
    let vector = st
        .embedder
        .embed(&embedding_text(&trail))
        .await
        .context("embedding")?;
    let tokens = trail
        .pointer("/effort/tokens_spent")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let failed_attempts = trail
        .pointer("/effort/failed_attempts")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let label = label(&trail);
    let runtime = trail
        .pointer("/environment/runtime/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload = json!({
        "trail_id": id,
        "fingerprint": fp,
        "category": judgement.category,
        "quality": (judgement.quality * 1000.0).round() / 1000.0,
        "judged_by": judgement.engine,
        "risk": risk,
        "runtime": runtime,
        "label": label,
        "created_ts": now,
        "created_at": keys::iso(now),
        "environments_confirmed": 0,
        "strength": strength::strength(0, 0, 0, judgement.quality, 0.0),
        "trail": trail,
    });
    st.qdrant
        .upsert(id, vector, payload)
        .await
        .context("indexing")?;

    let event = json!({
        "kind": "laid", "agent": agent_info, "trail_id": id,
        "text": format!("via {framework} laid trail {} after {failed_attempts} failed attempts", &id[..8]), "at": keys::iso(now)
    });
    let _: () = redis::pipe()
        .cmd("SADD")
        .arg(keys::fingerprint(&fp))
        .arg(id)
        .ignore()
        .cmd("DEL")
        .arg(keys::fingerprint_cache(&fp))
        .ignore()
        .cmd("HSET")
        .arg(keys::outcomes(id))
        .arg("worked")
        .arg(0)
        .arg("partially_worked")
        .arg(0)
        .arg("failed")
        .arg(0)
        .arg("not_applicable")
        .arg(0)
        .arg("last_success_ts")
        .arg(now)
        .ignore()
        .cmd("HSET")
        .arg(keys::trail(id))
        .arg("status")
        .arg("indexed")
        .arg("quality")
        .arg(judgement.quality)
        .arg("tokens")
        .arg(tokens)
        .arg("label")
        .arg(&label)
        .arg("category")
        .arg(&judgement.category)
        .ignore()
        .cmd("ZADD")
        .arg(keys::FEED)
        .arg(now)
        .arg(id)
        .ignore()
        .cmd("INCR")
        .arg(keys::STAT_TRAILS)
        .ignore()
        .cmd("LPUSH")
        .arg(keys::ACTIVITY)
        .arg(event.to_string())
        .ignore()
        .cmd("LTRIM")
        .arg(keys::ACTIVITY)
        .arg(0)
        .arg(199)
        .ignore()
        .query_async(&mut con)
        .await?;
    tracing::info!(trail = %id, category = %judgement.category, quality = judgement.quality, engine = judgement.engine, "trail indexed");
    Ok(())
}

/// Every 2 seconds, fold outcome counters of recently reported trails into Qdrant.
/// SPOP makes each id go to exactly one enricher.
async fn flush_loop(st: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Err(err) = flush_once(&st).await {
            tracing::warn!(error = %err, "flush failed");
        }
    }
}

async fn flush_once(st: &AppState) -> Result<()> {
    let mut con = st.redis();
    let ids: Vec<String> = redis::cmd("SPOP")
        .arg(keys::DIRTY)
        .arg(256)
        .query_async(&mut con)
        .await?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut hashes = redis::pipe();
    let mut envs = redis::pipe();
    let mut quality = redis::pipe();
    for id in &ids {
        hashes.cmd("HGETALL").arg(keys::outcomes(id));
        envs.cmd("PFCOUNT").arg(keys::environments(id));
        quality.cmd("HGET").arg(keys::trail(id)).arg("quality");
    }
    let hashes: Vec<HashMap<String, String>> = hashes.query_async(&mut con).await?;
    let envs: Vec<u64> = envs.query_async(&mut con).await?;
    let quality: Vec<Option<f64>> = quality.query_async(&mut con).await?;
    let now = keys::now();
    let updates = ids
        .iter()
        .zip(hashes)
        .zip(envs)
        .zip(quality)
        .map(|(((id, h), envs), q)| {
            let n = |k: &str| h.get(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let last: i64 = h.get("last_success_ts").and_then(|v| v.parse().ok()).unwrap_or(now);
            let s = strength::strength(n("worked"), n("partially_worked"), n("failed"), q.unwrap_or(0.5), (now - last).max(0) as f64 / 86_400.0);
            let payload = json!({
                "outcomes": { "worked": n("worked"), "partially_worked": n("partially_worked"), "failed": n("failed"), "not_applicable": n("not_applicable") },
                "last_success_ts": last,
                "environments_confirmed": envs,
                "strength": s,
            });
            (id.clone(), payload)
        })
        .collect();
    st.qdrant.set_payloads(updates).await
}
