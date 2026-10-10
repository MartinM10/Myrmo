//! What the colony shows: the feed, the activity, the demand list, statistics and operator analytics.

use super::search::valid_fingerprint;
use super::*;
use crate::keys;
use crate::state::AppState;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{Value, json};

/// Furthest position `/v1/feed` can be paged to.
const MAX_FEED_CURSOR: usize = 100_000;

// ---------------------------------------------------------------------------
// GET /v1/feed, /v1/activity, /v1/stats

pub(super) async fn feed_items(st: &AppState, ids: &[String]) -> ApiResult<Vec<Value>> {
    let candidates = load(st, ids).await?;
    let mut pipe = redis::pipe();
    for c in &candidates {
        pipe.cmd("LRANGE").arg(keys::replies(&c.id)).arg(0).arg(4);
    }
    let replies: Vec<Vec<String>> = if candidates.is_empty() {
        vec![]
    } else {
        pipe.query_async(&mut st.redis()).await?
    };
    let now = keys::now();
    Ok(candidates
        .iter()
        .zip(replies)
        .map(|(c, replies)| {
            let p = &c.payload;
            let last = if c.outcomes.last_success_ts > 0 { c.outcomes.last_success_ts } else { p["created_ts"].as_i64().unwrap_or(now) };
            json!({
                "trail_id": c.id,
                "fingerprint": p["fingerprint"],
                "created_at": p["created_at"],
                "last_success_at": keys::iso(last),
                "category": p["category"],
                "quality": p["quality"],
                "outcomes": c.outcomes.json(),
                "environments_confirmed": p["environments_confirmed"].as_u64().unwrap_or(0),
                "risk": current_risk(p),
                "strength": round3(c.strength(now)),
                "seed": crate::analytics::is_seed(&p["trail"]["agent_info"]),
                "trail": p["trail"],
                "replies": replies.iter().filter_map(|r| serde_json::from_str::<Value>(r).ok()).collect::<Vec<_>>(),
            })
        })
        .collect())
}

#[derive(Deserialize)]
pub(super) struct FeedQuery {
    limit: Option<usize>,
    cursor: Option<usize>,
    category: Option<String>,
    runtime: Option<String>,
}

pub(super) async fn feed(
    State(st): State<AppState>,
    Query(q): Query<FeedQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 50);
    let start = q.cursor.unwrap_or(0);
    if start > MAX_FEED_CURSOR {
        return Err(ApiError::bad_request("cursor is out of range."));
    }
    let filtered = q.category.is_some() || q.runtime.is_some();
    // With filters, read a wider window so a page is usually full.
    let window = if filtered { limit * 4 } else { limit };
    let ids: Vec<String> = st
        .redis()
        .zrevrange(keys::FEED, start as isize, (start + window) as isize - 1)
        .await?;
    let fetched = ids.len();
    let items: Vec<Value> = feed_items(&st, &ids)
        .await?
        .into_iter()
        .filter(|item| q.category.as_deref().is_none_or(|c| item["category"] == c))
        .filter(|item| {
            q.runtime.as_deref().is_none_or(|r| {
                item["trail"]["environment"]["runtime"]["name"]
                    .as_str()
                    .is_some_and(|name| {
                        crate::runtime::canonical(name) == crate::runtime::canonical(r)
                    })
            })
        })
        .take(limit)
        .collect();
    let next = (fetched == window).then(|| (start + window).to_string());
    Ok(Json(json!({ "items": items, "next_cursor": next })))
}

#[derive(Deserialize)]
pub(super) struct ActivityQuery {
    limit: Option<isize>,
}

pub(super) async fn activity(
    State(st): State<AppState>,
    Query(q): Query<ActivityQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 50);
    let raw: Vec<String> = st.redis().lrange(keys::ACTIVITY, 0, limit - 1).await?;
    let events: Vec<Value> = raw
        .iter()
        .filter_map(|e| serde_json::from_str(e).ok())
        .collect();
    Ok(Json(json!({ "events": events })))
}

/// Errors agents asked for that nobody has solved yet: where the colony should grow next.
/// Everyone gets the top few of the last week; an operator can ask for more and for longer.
pub(super) async fn demand(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DemandQuery>,
) -> ApiResult<Response> {
    if authorize_operator(&st, &headers).is_ok() {
        let days = q.days.unwrap_or(7).clamp(1, 90);
        let body = match q.fingerprints.as_deref() {
            // The operator names the errors a seed could cover and learns how much each is wanted.
            Some(list) => json!({
                "fingerprints": crate::analytics::demand_for(&mut st.redis(), &parse_fingerprints(list)?, days).await?,
                "days": days,
            }),
            None => json!({
                "unanswered": crate::analytics::demand(&mut st.redis(), days, 50, q.min_agents.unwrap_or(1)).await?,
                "days": days,
            }),
        };
        let mut res = Json(body).into_response();
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
        return Ok(res);
    }
    let list = crate::analytics::demand(&mut st.redis(), 7, 8, st.cfg.demand_min_agents).await?;
    let mut res = cacheable(
        json!({ "unanswered": list, "days": 7 }),
        StatusCode::OK,
        120,
    );
    // The same URL answers an operator with more, so a shared cache must not mix the two.
    res.headers_mut()
        .insert(header::VARY, HeaderValue::from_static("authorization"));
    Ok(res)
}

#[derive(Deserialize)]
pub(super) struct DemandQuery {
    days: Option<i64>,
    min_agents: Option<u64>,
    /// Comma-separated fingerprints, operator only.
    fingerprints: Option<String>,
}

/// Up to 50 fingerprints from a comma-separated list; anything that is not one is a bad request.
fn parse_fingerprints(list: &str) -> ApiResult<Vec<String>> {
    let fps: Vec<String> = list
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if fps.is_empty() || fps.len() > 50 {
        return Err(ApiError::bad_request(
            "fingerprints takes 1 to 50 comma-separated fingerprints.",
        ));
    }
    if let Some(bad) = fps.iter().find(|fp| !valid_fingerprint(fp)) {
        return Err(ApiError::bad_request(format!(
            "'{bad}' is not a fingerprint like fp2_0123456789abcdef."
        )));
    }
    Ok(fps)
}

#[derive(Deserialize)]
pub(super) struct AnalyticsQuery {
    days: Option<i64>,
}

/// Daily aggregates for analysis: distinct agents, trails laid, outcomes, tokens saved, and
/// per-model and per-framework counters. Operator only: it is the colony's own history, it is
/// the most expensive read, and it is part of what the colony sells. Aggregated; nothing here
/// identifies an agent.
pub(super) async fn analytics(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AnalyticsQuery>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let rows = crate::analytics::export(&mut st.redis(), days).await?;
    let mut res = Json(json!({
        "days": rows,
        "models_total": crate::analytics::model_leaderboard(&rows, 50),
    }))
    .into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(res)
}

pub(super) async fn stats(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let now = keys::now();
    let hour = keys::hour(now);
    let hours: Vec<i64> = (0..24).map(|h| hour - h).collect();
    let mut con = st.redis();
    let trails: Option<u64> = con.get(keys::STAT_TRAILS).await?;
    let outcomes: Vec<Option<u64>> = con
        .mget(
            hours
                .iter()
                .map(|h| keys::stat_outcomes(*h))
                .collect::<Vec<_>>(),
        )
        .await?;
    let tokens: Vec<Option<u64>> = con
        .mget(
            hours
                .iter()
                .map(|h| keys::stat_tokens(*h))
                .collect::<Vec<_>>(),
        )
        .await?;
    let agents: u64 = redis::cmd("PFCOUNT")
        .arg(
            hours
                .iter()
                .map(|h| keys::stat_agents(*h))
                .collect::<Vec<_>>(),
        )
        .query_async(&mut con)
        .await?;
    let hot: Vec<(String, f64)> = con.zrevrange_withscores(keys::hot(hour), 0, 4).await?;
    let declared_total: u64 = redis::cmd("PFCOUNT")
        .arg(crate::analytics::AGENTS_ALL)
        .query_async(&mut con)
        .await?;
    // Models and answer rate over the last 30 days. Cached briefly: this endpoint is public.
    let summary: Value = match con
        .get::<_, Option<String>>(keys::STATS_SUMMARY_CACHE)
        .await?
    {
        Some(cached) => serde_json::from_str(&cached).unwrap_or(Value::Null),
        None => {
            let rows = crate::analytics::export(&mut con, 30).await?;
            let total = |k: &str| -> i64 {
                rows.iter()
                    .map(|r| r["totals"][k].as_i64().unwrap_or(0))
                    .sum()
            };
            let summary = json!({
                "models": crate::analytics::public_leaderboard(&rows, 10),
                "seed_trails_30d": crate::analytics::seed_laid(&rows),
                "searches_30d": total("searches"),
                "answered_30d": total("search_hits"),
            });
            let _: () = redis::cmd("SET")
                .arg(keys::STATS_SUMMARY_CACHE)
                .arg(summary.to_string())
                .arg("EX")
                .arg(60)
                .query_async(&mut con)
                .await?;
            summary
        }
    };
    let models = summary["models"].clone();
    Ok(Json(json!({
        "trails": trails.unwrap_or(0),
        "outcomes_24h": outcomes.into_iter().flatten().sum::<u64>(),
        "tokens_saved_24h": tokens.into_iter().flatten().sum::<u64>(),
        "agents_24h": agents,
        "agents_declared_total": declared_total,
        "models": models,
        "models_self_reported": true,
        "seed_trails_30d": summary["seed_trails_30d"],
        "searches_30d": summary["searches_30d"],
        "answered_30d": summary["answered_30d"],
        "hot": hot.into_iter().map(|(label, n)| json!({ "label": label, "searches": n as u64 })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_operator_can_ask_about_up_to_fifty_fingerprints() {
        let one = "fp2_0123456789abcdef";
        assert_eq!(parse_fingerprints(one).ok(), Some(vec![one.to_string()]));
        let two = parse_fingerprints(" fp2_0123456789abcdef , fp2_fedcba9876543210 ").ok();
        assert_eq!(two.map(|v| v.len()), Some(2));
        assert!(parse_fingerprints("").is_err());
        assert!(parse_fingerprints(",").is_err());
        assert!(parse_fingerprints("fp2_0123456789abcdef,nope").is_err());
        assert!(parse_fingerprints("fp2_0123456789abcdeg").is_err());
        let many = vec![one; 51].join(",");
        assert!(parse_fingerprints(&many).is_err());
        assert!(parse_fingerprints(&vec![one; 50].join(",")).is_ok());
    }
}
