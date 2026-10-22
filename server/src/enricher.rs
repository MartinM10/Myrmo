//! Background enrichment. Consumes published trails from a Redis Stream consumer
//! group, so any number of enrichers can run side by side, and folds outcome counters
//! into the vector index in batches.

use crate::decision::{self, Judgement};
use crate::keys;
use crate::knowledge::{self, Kind};
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
        reject(&st, &id, &["enrichment_failed"], Value::Null).await
    } else {
        match serde_json::from_str::<Value>(&raw) {
            Ok(trail) => enrich(&st, &id, trail).await,
            Err(_) => reject(&st, &id, &["invalid_trail"], Value::Null).await,
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
        Err(err) if err.is::<decision::ModelUnavailable>() => {
            // An outage of the model says nothing about the trail: it must not use up its attempts.
            let _: redis::RedisResult<i64> = con.hincr(keys::trail(&id), "attempts", -1).await;
            tracing::warn!(trail = %id, "decision model unavailable, trail stays queued");
        }
        Err(err) => {
            tracing::warn!(trail = %id, attempts, error = %err, "enrichment failed, will retry")
        }
    }
}

async fn reject(st: &AppState, id: &str, reasons: &[&str], detail: Value) -> Result<()> {
    let mut pipe = redis::pipe();
    pipe.cmd("HSET")
        .arg(keys::trail(id))
        .arg("status")
        .arg("rejected")
        .arg("reasons")
        .arg(json!(reasons).to_string())
        .ignore();
    if !detail.is_null() {
        pipe.cmd("HSET")
            .arg(keys::trail(id))
            .arg("detail")
            .arg(detail.to_string())
            .ignore();
    }
    let _: () = pipe
        .cmd("EXPIRE")
        .arg(keys::trail(id))
        .arg(7 * 86_400)
        .ignore()
        .query_async(&mut st.redis())
        .await?;
    crate::analytics::record_rejection(&mut st.redis(), keys::now(), reasons).await;
    tracing::info!(trail = %id, ?reasons, "trail rejected");
    Ok(())
}

/// Whether a trail merged into an existing one may count as a `worked` report for it: it comes from somebody else.
/// Authors cannot confirm their own trails, and the author is also whoever publishes from the address the existing
/// trail was published from today, because an agent id is the caller's own choice. Trails without a recorded author
/// (published before authors were kept) cannot be told apart by author. Once a day per agent and the places of the
/// address (`crate::api::address_vote`) are checked after this.
fn independent_rediscovery(
    new_author: Option<&str>,
    existing_author: Option<&str>,
    new_address: Option<&str>,
    existing_address: Option<&str>,
) -> bool {
    let same = |a: Option<&str>, b: Option<&str>| matches!((a, b), (Some(a), Some(b)) if a == b);
    !same(new_author, existing_author) && !same(new_address, existing_address)
}

/// Successors one publisher (one address, or one access key) may link to one trail in a day. Linking costs nothing but
/// a publication, and each successor is named with the trail it amends.
const SUCCESSORS_PER_PUBLISHER: u64 = 2;

/// Whether two trails come from one author who declared who they are: the same agent id or access key, kept with each
/// trail. An anonymous publisher is known only by a daily hash of their address, which everyone behind one router
/// shares, so it never makes two trails one author's.
fn same_declared_author(a: &HashMap<String, String>, b: &HashMap<String, String>) -> bool {
    match (a.get("author"), b.get("author")) {
        (Some(a), Some(b)) => a == b && !keys::is_address_id(a),
        _ => false,
    }
}

/// Whether a successor from somebody else is about the error of the trail it amends, by the check search applies to a
/// semantic hit: `message` and `error_type` are the amended trail's, `similarity` how close the successor is to that
/// error line. Only then is it kept under the amended trail's fingerprint, where a lookup serves it as an exact match.
fn about_the_same_error(
    message: &str,
    error_type: &str,
    successor: &Value,
    similarity: f64,
    min_similarity: f64,
) -> bool {
    similarity >= min_similarity
        && crate::relevance::Asked::new(message, error_type).is_relevant(successor, similarity)
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
        && crate::runtime::canonical(&s(a, "/runtime/name"))
            == crate::runtime::canonical(&s(b, "/runtime/name"))
        && minor(a) == minor(b)
}

/// Text embedded for semantic search: what a searching agent will most likely type.
fn embedding_text(trail: &Value) -> String {
    let s = |p: &str| trail.pointer(p).and_then(Value::as_str).unwrap_or_default();
    if Kind::of(trail).is_knowledge() {
        return format!(
            "{}\n{}",
            knowledge::subject(trail),
            s("/problem/task_context")
        );
    }
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
    if Kind::of(trail).is_knowledge() {
        let summary = trail
            .pointer("/problem/summary")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return summary.trim().chars().take(80).collect();
    }
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
    // An operator removed the trail while it waited in the queue: drop it.
    let removed: Option<String> = st.redis().hget(keys::trail(id), "status").await?;
    if removed.as_deref() == Some("removed") {
        tracing::info!(trail = %id, "removed before enrichment, dropped");
        return Ok(());
    }
    // Second redaction pass: the gateway already ran it, rules may have been updated since.
    redact::redact_value_with(&mut trail, &mut Report::new(), st.cfg.redaction());
    let fp = fingerprint::of_trail(&trail);
    let kind = Kind::of(&trail);
    // The gateway refuses these already; a trail queued before a colony stopped being private is dropped here.
    if kind.is_knowledge() && !st.cfg.private {
        return reject(st, id, &["not_accepted_here"], Value::Null).await;
    }

    let mut judgement: Judgement = st.decision.judge(&trail).await;
    if kind.is_knowledge() {
        // The decision model and the rules score error fixes; a procedure or a fact has its own measure.
        judgement.quality = knowledge::heuristic_quality(&trail);
        judgement.category = kind.as_str().to_string();
    }
    if let Some(score) = judgement.model_injection {
        // Not a verdict (see MYRMO_MODEL_INJECTION_GATE): kept so the question can be calibrated.
        tracing::info!(trail = %id, model_injection = score, "decision model injection score");
    }
    // The model is configured but down: only the rules looked at this trail. Wait for the model
    // rather than index on that alone, unless the operator chose otherwise.
    if judgement.degraded && !st.cfg.decision_fail_open {
        return Err(decision::ModelUnavailable.into());
    }
    let mut reasons = Vec::new();
    if judgement.injection >= decision::INJECTION_THRESHOLD {
        reasons.push("prompt_injection");
    }
    // In an organisation's own colony, what is internal is what its agents need: only credentials and personal data
    // are removed (by redaction), nothing is rejected for being "sensitive", and the bar is only that a trail says
    // something. Outcome reports, not a gate at the door, decide what rises.
    if !st.cfg.private && judgement.sensitive >= decision::SENSITIVE_THRESHOLD {
        reasons.push("sensitive_content");
    }
    let min_quality = if st.cfg.private {
        decision::MIN_QUALITY_PRIVATE
    } else {
        decision::MIN_QUALITY
    };
    if judgement.quality < min_quality {
        reasons.push("low_quality");
    }
    // A command the colony would withhold, written where no client can withhold it: in the steps, the root cause, the
    // dead ends, a purpose, the verification or the lines a patch adds.
    let prose_risk = json!({ "flags": risk::assess_prose(&trail) });
    let risky_fields = risk::high_risk_prose_fields(&prose_risk);
    if !risky_fields.is_empty() {
        reasons.push("risky_command_in_prose");
    }
    if !reasons.is_empty() {
        let fields = if reasons.contains(&"sensitive_content") {
            st.decision.locate_sensitive(&trail).await
        } else {
            Vec::new()
        };
        return reject(
            st,
            id,
            &reasons,
            decision::rejection_detail(&reasons, &fields, &risky_fields),
        )
        .await;
    }

    let mut con = st.redis();
    let now = keys::now();
    let agent_info = trail["agent_info"].clone();
    let framework = agent_info["framework"]
        .as_str()
        .unwrap_or("agent")
        .to_string();

    // The same solution for the same error and environment already exists: merge into it instead
    // of creating a duplicate. A different solution is kept as an alternative, not discarded.
    let siblings: Vec<String> = con.smembers(keys::fingerprint(&fp)).await?;
    if !siblings.is_empty() {
        let existing = st.qdrant.get(&siblings).await?;
        let solution = fingerprint::solution_fingerprint(&trail);
        if let Some((existing_id, _)) = existing.iter().find(|(_, p)| {
            same_environment(&p["trail"]["environment"], &trail["environment"])
                && fingerprint::solution_fingerprint(&p["trail"]) == solution
        }) {
            // A re-discovery is an independent confirmation only when it comes from somebody
            // else, once a day, within the places of its address: the same rules as an outcome report.
            let new_meta: std::collections::HashMap<String, String> =
                con.hgetall(keys::trail(id)).await?;
            let existing_meta: std::collections::HashMap<String, String> =
                con.hgetall(keys::trail(existing_id)).await?;
            let new_author = crate::api::trail_author(&mut con, id, &new_meta)
                .await
                .map_err(|_| anyhow::anyhow!("cannot read the trail author"))?;
            let existing_author = crate::api::trail_author(&mut con, existing_id, &existing_meta)
                .await
                .map_err(|_| anyhow::anyhow!("cannot read the trail author"))?;
            let (new_address, existing_address): (Option<String>, Option<String>) =
                redis::cmd("MGET")
                    .arg(keys::pub_addr(id))
                    .arg(keys::pub_addr(existing_id))
                    .query_async(&mut con)
                    .await?;
            // A seed is not an independent confirmation: it only merges. Nor is a trail whose address is no longer
            // known (it waited in the queue for over a day): its places cannot be counted.
            let independent = independent_rediscovery(
                new_author.as_deref(),
                existing_author.as_deref(),
                new_address.as_deref(),
                existing_address.as_deref(),
            ) && !crate::analytics::is_seed(&agent_info);
            let mut counted = false;
            if let (true, Some(address)) = (independent, new_address.as_deref()) {
                let identity = new_author.as_deref().unwrap_or(address);
                let first_today = redis::cmd("SET")
                    .arg(keys::seen(existing_id, identity))
                    .arg(1)
                    .arg("NX")
                    .arg("EX")
                    .arg(86_400)
                    .query_async::<Option<String>>(&mut con)
                    .await?
                    .is_some();
                counted = first_today
                    && crate::api::address_vote(
                        &mut con,
                        &st.cfg,
                        existing_id,
                        address,
                        identity,
                        keys::hour(now),
                    )
                    .await?;
            }

            let mut pipe = redis::pipe();
            pipe.cmd("HSET")
                .arg(keys::trail(id))
                .arg("status")
                .arg("merged")
                .arg("merged_into")
                .arg(existing_id)
                .arg("reinforced")
                .arg(i32::from(counted))
                .ignore();
            if counted {
                let event = json!({
                    "kind": "reinforced", "agent": agent_info, "trail_id": existing_id,
                    "text": format!("via {framework} rediscovered and reinforced {}", &existing_id[..8]), "at": keys::iso(now)
                });
                pipe.cmd("HINCRBY")
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
                    .cmd("LPUSH")
                    .arg(keys::ACTIVITY)
                    .arg(event.to_string())
                    .ignore()
                    .cmd("LTRIM")
                    .arg(keys::ACTIVITY)
                    .arg(0)
                    .arg(199)
                    .ignore();
            }
            let _: () = pipe.query_async(&mut con).await?;
            if counted {
                crate::analytics::record(
                    &mut con,
                    now,
                    &[(
                        "rediscovered",
                        crate::analytics::clean_label(&agent_info["model"]),
                        1,
                    )],
                )
                .await;
            }
            tracing::info!(trail = %id, into = %existing_id, counted, "trail merged");
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
    // The trail this one amends, if it is still in the colony: checked when the link is made, not only when it was asked.
    let link = match amended(&mut con, id).await? {
        Some((target, target_fp)) => {
            plan_successor(st, &mut con, id, &trail, &vector, target, target_fp).await?
        }
        None => None,
    };
    let mut payload = json!({
        "trail_id": id,
        "fingerprint": fp,
        "kind": kind.as_str(),
        "category": judgement.category,
        "quality": (judgement.quality * 1000.0).round() / 1000.0,
        "judged_by": judgement.engine,
        "risk": risk,
        "runtime": runtime,
        "label": label,
        "created_ts": now,
        "created_at": keys::iso(now),
        "environments_confirmed": 0,
        "strength": strength::strength(0, 0, 0, judgement.quality, 0.0, strength::half_life_days(kind.as_str())),
        "trail": trail,
    });
    // Shown as a seed laid by the project only when it came with the operator token (`analytics::shown_as_seed`).
    let by_operator: Option<String> = con.hget(keys::trail(id), "by_operator").await?;
    if by_operator.as_deref() == Some("1")
        && crate::analytics::is_seed(&payload["trail"]["agent_info"])
    {
        payload["seed"] = json!(true);
    }
    if let Some(link) = &link {
        payload["amends"] = json!(link.target);
    }
    st.qdrant
        .upsert(id, vector, payload)
        .await
        .context("indexing")?;
    index_task(st, id, &trail).await?;

    let successor_of = link
        .as_ref()
        .map(|link| format!(", a successor of {}", &link.target[..8]))
        .unwrap_or_default();
    let event = json!({
        "kind": "laid", "agent": agent_info, "trail_id": id,
        "text": format!("via {framework} laid trail {} after {failed_attempts} failed attempts{successor_of}", &id[..8]), "at": keys::iso(now)
    });
    let mut index = redis::pipe();
    keys::add_to_fingerprint(&mut index, &fp, id, st.cfg.max_per_fingerprint);
    let _: () = index
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
        .arg("laid_ts")
        .arg(now)
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
    if let Some(link) = &link {
        link_successor(st, &mut con, id, &fp, link).await?;
    }
    let (laid_model, laid_framework) = crate::analytics::laid_labels(&agent_info);
    // What was counted, kept with the trail so that removing it can take the same count back.
    let _: () = redis::cmd("HSET")
        .arg(keys::trail(id))
        .arg("laid_model")
        .arg(laid_model.as_deref().unwrap_or_default())
        .arg("laid_fw")
        .arg(laid_framework.as_deref().unwrap_or_default())
        .query_async(&mut con)
        .await?;
    crate::analytics::record(
        &mut con,
        now,
        &[
            ("trails", None, 1),
            ("failed_attempts", None, failed_attempts),
            ("laid", laid_model, 1),
            ("fw_laid", laid_framework, 1),
        ],
    )
    .await;
    tracing::info!(trail = %id, category = %judgement.category, quality = judgement.quality, engine = judgement.engine, "trail indexed");
    Ok(())
}

/// The trail a queued trail amends, as `(id, fingerprint)`, while that one is still indexed. A link to a trail that
/// was removed, or merged away, while this one waited is dropped rather than pointing at nothing.
async fn amended(
    con: &mut redis::aio::ConnectionManager,
    id: &str,
) -> Result<Option<(String, String)>> {
    let (target, target_fp): (Option<String>, Option<String>) = redis::cmd("HMGET")
        .arg(keys::trail(id))
        .arg("amends")
        .arg("amends_fp")
        .query_async(con)
        .await?;
    let Some(target) = target else {
        return Ok(None);
    };
    let status: Option<String> = con.hget(keys::trail(&target), "status").await?;
    if target == id || status.as_deref() != Some("indexed") {
        let _: () = redis::cmd("HDEL")
            .arg(keys::trail(id))
            .arg("amends")
            .arg("amends_fp")
            .query_async(con)
            .await?;
        return Ok(None);
    }
    Ok(Some((target, target_fp.unwrap_or_default())))
}

/// How a newly indexed trail is linked to the one it amends, decided before it is indexed.
struct SuccessorLink {
    target: String,
    target_fp: String,
    /// The same declared author: a correction, which replaces the older trail.
    own: bool,
    /// Kept under the older trail's fingerprint too.
    under_target: bool,
}

/// Decide how a trail is linked to the one it amends (`target`). Each publisher (an address, or an access key) may
/// link [`SUCCESSORS_PER_PUBLISHER`] successors to one trail a day; past that the trail is indexed on its own, without
/// the link. A correction from the trail's own declared author is kept under the older trail's fingerprint. A
/// successor from anybody else is kept there only when it is about the same error by the check search applies to a
/// semantic hit (`about_the_same_error`); otherwise it is only named by the older trail. A lookup serves whatever a
/// fingerprint holds as an exact match, so nobody can file a trail under another's error by calling it a successor.
async fn plan_successor(
    st: &AppState,
    con: &mut redis::aio::ConnectionManager,
    id: &str,
    trail: &Value,
    vector: &[f32],
    target: String,
    target_fp: String,
) -> Result<Option<SuccessorLink>> {
    let new_meta: HashMap<String, String> = con.hgetall(keys::trail(id)).await?;
    let old_meta: HashMap<String, String> = con.hgetall(keys::trail(&target)).await?;
    let publisher: Option<String> = con.get(keys::pub_addr(id)).await?;
    let publisher = publisher
        .or_else(|| new_meta.get("author").cloned())
        .unwrap_or_else(|| id.to_string());
    // A set of the successors, not a counter: a trail retried after a failure keeps the place it took.
    let quota = keys::successor_quota(&target, &publisher);
    let (_, used): (u64, u64) = redis::pipe()
        .cmd("SADD")
        .arg(&quota)
        .arg(id)
        .cmd("SCARD")
        .arg(&quota)
        .cmd("EXPIRE")
        .arg(&quota)
        .arg(86_400)
        .ignore()
        .query_async(con)
        .await?;
    if used > SUCCESSORS_PER_PUBLISHER {
        let _: () = redis::pipe()
            .cmd("SREM")
            .arg(&quota)
            .arg(id)
            .ignore()
            .cmd("HDEL")
            .arg(keys::trail(id))
            .arg("amends")
            .arg("amends_fp")
            .ignore()
            .query_async(con)
            .await?;
        tracing::info!(trail = %id, amends = %target, "successor not linked: too many from one publisher");
        return Ok(None);
    }
    let own = same_declared_author(&new_meta, &old_meta);
    let under_target =
        !target_fp.is_empty() && (own || amends_the_same_error(st, trail, vector, &target).await?);
    Ok(Some(SuccessorLink {
        target,
        target_fp,
        own,
        under_target,
    }))
}

/// [`about_the_same_error`] for a successor and the indexed trail it amends: the amended trail's error line is embedded
/// as a search would embed it and compared with the successor's own vector.
async fn amends_the_same_error(
    st: &AppState,
    successor: &Value,
    vector: &[f32],
    target: &str,
) -> Result<bool> {
    let Some((_, payload)) = st
        .qdrant
        .get(&[target.to_string()])
        .await?
        .into_iter()
        .next()
    else {
        return Ok(false);
    };
    let amended = &payload["trail"];
    let error_type = amended
        .pointer("/problem/error_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = if Kind::of(amended).is_knowledge() {
        knowledge::subject(amended)
    } else {
        fingerprint::message_for_problem(&amended["problem"])
    };
    let asked = if error_type.is_empty() || message.starts_with(error_type) {
        message.clone()
    } else {
        format!("{error_type}: {message}")
    };
    let query = st.embedder.embed(&asked).await.context("embedding")?;
    // Both vectors are normalised: their dot product is the cosine similarity search ranks by.
    let similarity: f64 = query
        .iter()
        .zip(vector)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    Ok(about_the_same_error(
        &message,
        error_type,
        successor,
        similarity,
        st.cfg.min_similarity,
    ))
}

/// Link a newly indexed trail to the one it amends. The older trail names its successors, and when the plan says so
/// the new one is also kept under the older one's fingerprint: an agent that hits the original error finds both, and
/// their strength, built from what happened to the agents that followed each, decides which comes first. Someone
/// else's amendment cannot lower a trail, only reports can; but an author who publishes the successor of their own
/// trail is correcting it, so the older one is marked as replaced: kept and linked, no longer an answer.
async fn link_successor(
    st: &AppState,
    con: &mut redis::aio::ConnectionManager,
    id: &str,
    fp: &str,
    link: &SuccessorLink,
) -> Result<()> {
    let target = link.target.as_str();
    let mut pipe = redis::pipe();
    pipe.cmd("SADD")
        .arg(keys::amended_by(target))
        .arg(id)
        .ignore();
    if link.own {
        pipe.cmd("HSET")
            .arg(keys::outcomes(target))
            .arg("superseded_by")
            .arg(id)
            .ignore();
    }
    if link.under_target && link.target_fp != fp {
        keys::add_to_fingerprint(&mut pipe, &link.target_fp, id, st.cfg.max_per_fingerprint);
    }
    pipe.cmd("DEL")
        .arg(keys::fingerprint_cache(&link.target_fp))
        .ignore();
    let _: () = pipe.query_async(con).await?;
    tracing::info!(trail = %id, amends = %target, replaced = link.own, under_the_amended_error = link.under_target, "successor linked");
    Ok(())
}

/// File a trail in the task index too, when the colony has one. Only the vector and the kind live there: results are
/// read back from the main index, which holds the trail and its strength.
pub async fn index_task(st: &AppState, id: &str, trail: &Value) -> Result<()> {
    let Some(tasks) = &st.tasks else {
        return Ok(());
    };
    let vector = tasks
        .embedder
        .embed(&knowledge::task_text(trail))
        .await
        .context("task embedding")?;
    let kind = Kind::of(trail).as_str();
    tasks
        .qdrant
        .upsert(id, vector, json!({ "kind": kind }))
        .await
        .context("task indexing")?;
    // When it applies, on its own: a request phrased like it finds it even when the summary and steps say otherwise.
    if let (Some(text), Some(point)) =
        (knowledge::context_text(trail), knowledge::context_point(id))
    {
        let vector = tasks
            .embedder
            .embed(&text)
            .await
            .context("task context embedding")?;
        tasks
            .qdrant
            .upsert(&point, vector, json!({ "kind": kind, "context_of": id }))
            .await
            .context("task context indexing")?;
    }
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
    let mut categories = redis::pipe();
    for id in &ids {
        hashes.cmd("HGETALL").arg(keys::outcomes(id));
        envs.cmd("PFCOUNT").arg(keys::environments(id));
        quality.cmd("HGET").arg(keys::trail(id)).arg("quality");
        categories.cmd("HGET").arg(keys::trail(id)).arg("category");
    }
    let hashes: Vec<HashMap<String, String>> = hashes.query_async(&mut con).await?;
    let envs: Vec<u64> = envs.query_async(&mut con).await?;
    let quality: Vec<Option<f64>> = quality.query_async(&mut con).await?;
    let categories: Vec<Option<String>> = categories.query_async(&mut con).await?;
    let now = keys::now();
    let updates = ids
        .iter()
        .zip(hashes)
        .zip(envs)
        .zip(quality)
        .zip(categories)
        .map(|((((id, h), envs), q), category)| {
            let n = |k: &str| h.get(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let last: i64 = h.get("last_success_ts").and_then(|v| v.parse().ok()).unwrap_or(now);
            let half_life = strength::half_life_days(category.as_deref().unwrap_or("fix"));
            let s = strength::strength(n("worked") + n("confirmed"), n("partially_worked"), n("failed"), q.unwrap_or(0.5), (now - last).max(0) as f64 / 86_400.0, half_life);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spellings_of_a_runtime_are_one_environment() {
        let a =
            serde_json::json!({"os": "linux", "runtime": {"name": "java", "version": "21.0.2"}});
        let b = serde_json::json!({"os": "Linux", "runtime": {"name": "JVM", "version": "21.0.5"}});
        let c =
            serde_json::json!({"os": "linux", "runtime": {"name": "kotlin", "version": "21.0.5"}});
        assert!(same_environment(&a, &b));
        assert!(!same_environment(&a, &c));
    }

    #[test]
    fn authors_cannot_reinforce_their_own_trails() {
        let (a, b) = (Some("1a2b3c4d5e6f7a8b"), Some("9f8e7d6c5b4a3f2e"));
        assert!(!independent_rediscovery(
            Some("agent_a"),
            Some("agent_a"),
            b,
            a
        ));
        assert!(independent_rediscovery(
            Some("agent_b"),
            Some("agent_a"),
            b,
            a
        ));
    }

    #[test]
    fn a_new_agent_id_from_the_publishing_address_is_still_the_author() {
        let address = Some("1a2b3c4d5e6f7a8b");
        for fresh in ["agent_0001", "agent_0002", "agent_0003"] {
            assert!(
                !independent_rediscovery(Some(fresh), Some("agent_a"), address, address),
                "{fresh}"
            );
        }
    }

    #[test]
    fn unknown_authors_are_not_blocked() {
        let (a, b) = (Some("1a2b3c4d5e6f7a8b"), Some("9f8e7d6c5b4a3f2e"));
        assert!(independent_rediscovery(None, Some("agent_a"), b, a));
        assert!(independent_rediscovery(Some("agent_b"), None, b, a));
        assert!(independent_rediscovery(
            Some("agent_b"),
            Some("agent_a"),
            b,
            None
        ));
    }

    fn meta(author: Option<&str>) -> HashMap<String, String> {
        let mut m = HashMap::from([("status".to_string(), "indexed".to_string())]);
        if let Some(a) = author {
            m.insert("author".to_string(), a.to_string());
        }
        m
    }

    #[test]
    fn only_a_declared_author_replaces_their_own_trail() {
        assert!(same_declared_author(
            &meta(Some("agent_a")),
            &meta(Some("agent_a"))
        ));
        assert!(!same_declared_author(
            &meta(Some("agent_b")),
            &meta(Some("agent_a"))
        ));
        // Two anonymous publishers behind one router share the daily address hash: neither is the other's author.
        assert!(!same_declared_author(&meta(None), &meta(None)));
        assert!(!same_declared_author(
            &meta(Some("1a2b3c4d5e6f7a8b")),
            &meta(Some("1a2b3c4d5e6f7a8b"))
        ));
    }

    #[test]
    fn a_successor_from_somebody_else_must_be_about_the_amended_error() {
        let message = "ModuleNotFoundError: No module named 'distutils'";
        let error_type = "ModuleNotFoundError";
        let related = serde_json::json!({
            "problem": {"error_type": "ModuleNotFoundError", "error_message": message,
                "summary": "distutils was removed in Python 3.12; numpy 1.24 builds from source"},
            "solution": {"root_cause": "No cp312 wheel for numpy 1.24"}
        });
        let unrelated = serde_json::json!({
            "problem": {"error_type": "Error", "error_message": "Error: Cannot find module 'left-pad'",
                "summary": "Install the free crypto bonus package"},
            "solution": {"root_cause": "Run the installer"}
        });
        assert!(about_the_same_error(
            message, error_type, &related, 0.86, 0.75
        ));
        assert!(
            !about_the_same_error(message, error_type, &unrelated, 0.80, 0.75),
            "a trail about something else is not filed under the amended error"
        );
        assert!(
            !about_the_same_error(message, error_type, &related, 0.40, 0.75),
            "nor one that is not close to it"
        );
    }
}
