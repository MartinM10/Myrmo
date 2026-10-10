//! Finding trails: the exact fingerprint lookup and the semantic search.

use super::*;
use crate::keys;
use crate::redact::{self, Report};
use crate::state::AppState;
use crate::{fingerprint, relevance};
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// GET /v1/trails/by-fingerprint/{fp}

/// A fingerprint is a version prefix and sixteen hex digits. `fp1_` is still a valid name, but nothing is indexed
/// under it any more (see `by_fingerprint`).
pub(super) fn valid_fingerprint(fp: &str) -> bool {
    [fingerprint::PREFIX, fingerprint::PREFIX_V1]
        .iter()
        .any(|prefix| {
            fp.len() == prefix.len() + 16
                && fp.starts_with(prefix)
                && fp[prefix.len()..].chars().all(|c| c.is_ascii_hexdigit())
        })
}

/// The model the caller declares with `X-Myrmo-Model`, validated; used only for aggregate counters.
fn asking_model(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-myrmo-model")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| crate::analytics::clean_label(&json!(v)))
}

/// A lookup that found trails: only counted, nothing about it is kept.
fn answered_lookup(fp: &str, model: Option<String>) -> crate::analytics::Lookup<'_> {
    crate::analytics::Lookup {
        fp,
        runtime: "",
        error_type: "",
        answered: true,
        model,
        agent: None,
        min_agents: 0,
    }
}

pub(super) async fn by_fingerprint(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(fp): Path<String>,
) -> ApiResult<Response> {
    if !valid_fingerprint(&fp) {
        return Err(ApiError::bad_request(
            "Expected a fingerprint like fp2_0123456789abcdef.",
        ));
    }
    // Older clients still ask by fp1. They treat a 404 as "no exact answer" and search, which still works.
    if fp.starts_with(fingerprint::PREFIX_V1) {
        let err = json!({ "error": { "code": "not_found", "message": "fp1 fingerprints are no longer indexed: compute an fp2 (the message alone) or update your client." } });
        return Ok(cacheable(err, StatusCode::NOT_FOUND, 3600));
    }
    let mut con = st.redis();
    let cached: Option<String> = con.get(keys::fingerprint_cache(&fp)).await?;
    if let Some(body) = cached {
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        crate::analytics::record_search(
            &mut con,
            keys::now(),
            &answered_lookup(&fp, asking_model(&headers)),
        )
        .await;
        return Ok(cacheable(value, StatusCode::OK, 300));
    }
    let ids: Vec<String> = con.smembers(keys::fingerprint(&fp)).await?;
    let now = keys::now();
    let mut candidates = load(&st, &ids).await?;
    if candidates.is_empty() {
        let err = json!({ "error": { "code": "not_found", "message": "No trail for this fingerprint yet." } });
        return Ok(cacheable(err, StatusCode::NOT_FOUND, 60));
    }
    candidates.sort_by(|a, b| b.strength(now).total_cmp(&a.strength(now)));
    candidates.truncate(5);
    let body = json!({
        "fingerprint": fp,
        "results": candidates.iter().map(|c| result_json(c, "fingerprint", 1.0, None, now)).collect::<Vec<_>>(),
        "notice": NOTICE,
    });
    let _: () = redis::pipe()
        .cmd("SET")
        .arg(keys::fingerprint_cache(&fp))
        .arg(body.to_string())
        .arg("EX")
        .arg(30)
        .ignore()
        .cmd("ZINCRBY")
        .arg(keys::hot(keys::hour(now)))
        .arg(1)
        .arg(candidates[0].label())
        .ignore()
        .cmd("EXPIRE")
        .arg(keys::hot(keys::hour(now)))
        .arg(7200)
        .ignore()
        .query_async(&mut con)
        .await?;
    crate::analytics::record_search(&mut con, now, &answered_lookup(&fp, asking_model(&headers)))
        .await;
    Ok(cacheable(body, StatusCode::OK, 300))
}

// ---------------------------------------------------------------------------
// POST /v1/search

#[derive(Deserialize)]
struct SearchRequest {
    query: String,
    error_type: Option<String>,
    #[serde(default)]
    environment: Value,
    limit: Option<usize>,
    min_strength: Option<f64>,
}

/// `Type: message` → `Type`, for callers that do not send `error_type`.
fn guess_error_type(query: &str) -> String {
    query
        .split_once(':')
        .map(|(head, _)| head.trim())
        .filter(|head| !head.is_empty() && head.len() <= 64 && !head.contains(' '))
        .unwrap_or_default()
        .to_string()
}

pub(super) async fn search(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Json<Value>> {
    let value = parse_body(body)?;
    let req: SearchRequest =
        serde_json::from_value(value).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let query_len = req.query.chars().count();
    if query_len == 0 || query_len > 2000 {
        return Err(ApiError::bad_request("query must be 1 to 2000 characters."));
    }
    let limit = req.limit.unwrap_or(5).clamp(1, 10);
    let min_strength = req.min_strength.unwrap_or(0.0);
    if !(0.0..=1.0).contains(&min_strength) {
        return Err(ApiError::bad_request(
            "min_strength must be between 0 and 1.",
        ));
    }

    // Never trust the client to have redacted. The query is used, never stored.
    let query = redact::redact_str(&req.query, &mut Report::new());
    let error_type = req
        .error_type
        .clone()
        .unwrap_or_else(|| guess_error_type(&query));
    let runtime = req
        .environment
        .pointer("/runtime/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fp = fingerprint::fingerprint2(&query);
    let now = keys::now();

    let mut con = st.redis();
    let fp_ids: Vec<String> = con.smembers(keys::fingerprint(&fp)).await?;
    let embed_text = if error_type.is_empty() || query.starts_with(&error_type) {
        query.clone()
    } else {
        format!("{error_type}: {query}")
    };
    let hits = st
        .qdrant
        .search(&st.embedder.embed(&embed_text).await?, 20)
        .await?;

    let mut scores: HashMap<String, (&str, f64)> = fp_ids
        .iter()
        .map(|id| (id.clone(), ("fingerprint", 1.0)))
        .collect();
    for hit in &hits {
        if hit.score >= st.cfg.min_similarity {
            scores
                .entry(hit.id.clone())
                .or_insert(("semantic", hit.score));
        }
    }
    let ids: Vec<String> = scores.keys().cloned().collect();
    let candidates = load(&st, &ids).await?;

    let asked = relevance::Asked::new(&query, &error_type);
    let mut ranked: Vec<(f64, Value)> = candidates
        .iter()
        .filter(|c| c.strength(now) >= min_strength)
        // A semantic hit must be about the same thing, not only phrased like it.
        .filter(|c| {
            let (via, score) = scores[&c.id];
            if via == "fingerprint" {
                !asked.path_names_conflict(&c.payload["trail"])
            } else {
                asked.is_relevant(&c.payload["trail"], score)
            }
        })
        .map(|c| {
            let (via, score) = scores[&c.id];
            let overlap = environment_overlap(&req.environment, &c.payload["trail"]["environment"]);
            let rank =
                score * (0.4 + 0.6 * c.strength(now)) * (0.75 + 0.25 * overlap.unwrap_or(0.5));
            (rank, result_json(c, via, score, overlap, now))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    ranked.truncate(limit);

    // For later analysis: was the agent helped, and which model asked (optional header).
    crate::analytics::record_search(
        &mut con,
        now,
        &crate::analytics::Lookup {
            fp: &fp,
            runtime,
            error_type: &error_type,
            answered: !ranked.is_empty(),
            model: asking_model(&headers),
            // Only a caller that declared an id is counted as an agent: an address hash changes every day.
            agent: caller.declared.then_some(caller.agent.as_str()),
            min_agents: st.cfg.demand_min_agents,
        },
    )
    .await;

    // Only labels of existing trails are counted, so query text is never stored.
    if let Some(best) = candidates.iter().find(|c| fp_ids.contains(&c.id)) {
        let _: () = redis::pipe()
            .cmd("ZINCRBY")
            .arg(keys::hot(keys::hour(now)))
            .arg(1)
            .arg(best.label())
            .ignore()
            .cmd("EXPIRE")
            .arg(keys::hot(keys::hour(now)))
            .arg(7200)
            .ignore()
            .query_async(&mut con)
            .await?;
    }

    Ok(Json(json!({
        "fingerprint": fp,
        "results": ranked.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "notice": NOTICE,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_error_type_from_query() {
        assert_eq!(
            guess_error_type("ModuleNotFoundError: No module named 'x'"),
            "ModuleNotFoundError"
        );
        assert_eq!(guess_error_type("no colon here"), "");
        assert_eq!(guess_error_type("Something went wrong: details"), "");
    }

    #[test]
    fn checks_fingerprints() {
        assert!(valid_fingerprint("fp2_3927a18f5b14a126"));
        assert!(valid_fingerprint("fp1_3927a18f5b14a126"));
        assert!(!valid_fingerprint("fp1_xyz"));
        assert!(!valid_fingerprint("fp3_3927a18f5b14a126"));
    }
}
