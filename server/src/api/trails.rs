//! One trail: its status, and taking it out of the colony.

use super::feed::feed_items;
use super::*;
use crate::keys;
use crate::state::AppState;
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use redis::AsyncCommands;
use serde_json::{Value, json};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// GET /v1/trails/{id}

pub(super) async fn get_trail(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(ApiError::not_found("No trail with that id."));
    }
    let meta: HashMap<String, String> = st.redis().hgetall(keys::trail(&id)).await?;
    let Some(status) = meta.get("status") else {
        return Err(ApiError::not_found("No trail with that id."));
    };
    let mut body =
        json!({ "trail_id": id, "status": status, "fingerprint": meta.get("fingerprint") });
    match status.as_str() {
        "rejected" => {
            body["reasons"] = meta
                .get("reasons")
                .and_then(|r| serde_json::from_str(r).ok())
                .unwrap_or(json!([]));
            if let Some(detail) = meta
                .get("detail")
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
            {
                body["detail"] = detail;
            }
        }
        "merged" => body["merged_into"] = json!(meta.get("merged_into")),
        "indexed" => {
            if let Some(item) = feed_items(&st, std::slice::from_ref(&id)).await?.pop()
                && let (Value::Object(target), Value::Object(source)) = (&mut body, item)
            {
                target.extend(source);
            }
        }
        _ => {}
    }
    Ok(Json(body))
}

// ---------------------------------------------------------------------------
// DELETE /v1/trails/{id}  (operator)

/// Whether the agent id a caller declared is the one a trail was published with. A caller with no id, or whose
/// "id" is only the hash of their address, is never the author here: removal is for the person who holds the id.
fn author_may_remove(declared: bool, caller_agent: &str, author: Option<&str>) -> bool {
    declared && author == Some(caller_agent)
}

/// Who is asking to remove a trail: the operator, by their token; or someone who may be its author, by the access key
/// the colony knows them by or the `X-Myrmo-Agent` they declared. A bearer that is neither the operator token nor a
/// valid access key is refused rather than tried as an author.
fn remover(presents_bearer: bool, operator: bool, keyed: bool) -> Result<bool, ()> {
    match (operator, presents_bearer && !keyed) {
        (true, _) => Ok(true),
        (false, true) => Err(()),
        (false, false) => Ok(false),
    }
}

/// Take a trail out of the colony: search, fingerprint lookups, the feed and its outcome data.
/// An operator (bearer token) may remove any trail; the author may remove their own, by sending the access key or the
/// `X-Myrmo-Agent` they published with. A tombstone stays for 90 days so that a trail still queued is not
/// indexed afterwards and the id answers `removed` instead of `not found`. Removing twice is fine.
pub(super) async fn remove_trail(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Json<Value>> {
    let by_operator = match remover(
        headers.contains_key(header::AUTHORIZATION),
        caller.operator,
        caller.key_hash.is_some(),
    ) {
        Ok(by_operator) => by_operator,
        // Answers why it is refused (no operator endpoints here, or a wrong token).
        Err(()) => {
            authorize_operator(&st, &headers)?;
            true
        }
    };
    if !valid_uuid(&id) {
        return Err(ApiError::not_found("No trail with that id."));
    }
    let reason = parse_body(body)
        .ok()
        .and_then(|b| {
            b["reason"]
                .as_str()
                .map(|r| r.chars().take(200).collect::<String>())
        })
        .unwrap_or_default();
    let mut con = st.redis();
    let meta: HashMap<String, String> = con.hgetall(keys::trail(&id)).await?;
    let Some(status) = meta.get("status") else {
        return Err(ApiError::not_found("No trail with that id."));
    };
    if status == "removed" {
        return Ok(Json(json!({ "trail_id": id, "status": "removed" })));
    }
    if !by_operator {
        let author = trail_author(&mut con, &id, &meta).await?;
        if !author_may_remove(caller.declared, &caller.agent, author.as_deref()) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Only the author of the trail, with the access key or X-Myrmo-Agent id it was published with, or an operator can remove it.",
            ));
        }
    }
    if by_operator {
        super::admin::record(
            &st,
            &format!(
                "trail {id} removed{}",
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(": {reason}")
                }
            ),
        )
        .await;
    }
    let now = keys::now();
    // Read before it is deleted: the model and framework it was counted under.
    let agent_info = if status == "indexed" {
        let payload = st.qdrant.get(std::slice::from_ref(&id)).await?;
        payload
            .first()
            .map(|(_, p)| p["trail"]["agent_info"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if status == "indexed" {
        st.qdrant.delete(&id).await?;
        if let Some(tasks) = &st.tasks {
            tasks.qdrant.delete(&id).await?;
            if let Some(point) = crate::knowledge::context_point(&id) {
                tasks.qdrant.delete(&point).await?;
            }
        }
    }
    let mut pipe = redis::pipe();
    if let Some(fp) = meta.get("fingerprint") {
        pipe.cmd("SREM")
            .arg(keys::fingerprint(fp))
            .arg(&id)
            .ignore();
        pipe.cmd("DEL").arg(keys::fingerprint_cache(fp)).ignore();
    }
    // A successor also lives under the fingerprint of the trail it amends, and is named by it; if it replaced its
    // author's own trail, that one is an answer again.
    if let Some(target) = meta.get("amends") {
        let replaced_by: Option<String> = con.hget(keys::outcomes(target), "superseded_by").await?;
        if replaced_by.as_deref() == Some(id.as_str()) {
            pipe.cmd("HDEL")
                .arg(keys::outcomes(target))
                .arg("superseded_by")
                .ignore();
        }
    }
    if let (Some(target), Some(target_fp)) = (meta.get("amends"), meta.get("amends_fp")) {
        pipe.cmd("SREM")
            .arg(keys::fingerprint(target_fp))
            .arg(&id)
            .ignore();
        pipe.cmd("DEL")
            .arg(keys::fingerprint_cache(target_fp))
            .ignore();
        pipe.cmd("SREM")
            .arg(keys::amended_by(target))
            .arg(&id)
            .ignore();
    }
    pipe.cmd("ZREM").arg(keys::FEED).arg(&id).ignore();
    pipe.cmd("SREM").arg(keys::DIRTY).arg(&id).ignore();
    for key in [
        keys::outcomes(&id),
        keys::replies(&id),
        keys::caveats(&id),
        keys::amended_by(&id),
        keys::environments(&id),
        keys::anon_author(&id),
        keys::pub_addr(&id),
    ] {
        pipe.cmd("DEL").arg(key).ignore();
    }
    if status == "indexed" {
        pipe.cmd("DECR").arg(keys::STAT_TRAILS).ignore();
    }
    // The figures that count trails laid must not keep a trail that is gone. Trails indexed before the labels were
    // kept with them are taken back under the labels they were counted under then.
    let mut taken_back: Vec<(&str, Option<String>, i64)> = Vec::new();
    if status == "indexed" {
        let label = |field: &str, fallback: &Value| match meta.get(field) {
            Some(l) if !l.is_empty() => Some(l.clone()),
            Some(_) => None,
            None => crate::analytics::clean_label(fallback),
        };
        taken_back = vec![
            ("trails", None, -1),
            ("laid", label("laid_model", &agent_info["model"]), -1),
            ("fw_laid", label("laid_fw", &agent_info["framework"]), -1),
        ];
    }
    // The "hot" list names trails by their label: a removed trail must not stay on it.
    if let Some(label) = meta.get("label") {
        let hour = keys::hour(now);
        for h in [hour, hour - 1] {
            pipe.cmd("ZREM").arg(keys::hot(h)).arg(label).ignore();
        }
    }
    pipe.cmd("DEL").arg(keys::trail(&id)).ignore();
    pipe.cmd("HSET")
        .arg(keys::trail(&id))
        .arg("status")
        .arg("removed")
        .arg("removed_at")
        .arg(now)
        .ignore();
    pipe.cmd("EXPIRE")
        .arg(keys::trail(&id))
        .arg(90 * 86_400)
        .ignore();
    let _: () = pipe.query_async(&mut con).await?;
    if !taken_back.is_empty() {
        let laid_at = meta
            .get("laid_ts")
            .or_else(|| meta.get("created_ts"))
            .and_then(|t| t.parse().ok())
            .unwrap_or(now);
        crate::analytics::record(&mut con, laid_at, &taken_back).await;
    }
    tracing::info!(trail = %id, was = %status, reason = %reason, by = if by_operator { "operator" } else { "author" }, "trail removed");
    Ok(Json(json!({ "trail_id": id, "status": "removed" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_author_with_the_id_they_published_with_may_remove() {
        assert!(author_may_remove(true, "agent-aaaa", Some("agent-aaaa")));
        assert!(!author_may_remove(true, "agent-bbbb", Some("agent-aaaa")));
        assert!(!author_may_remove(true, "agent-aaaa", None));
        // A caller with no id is identified by an address hash, and that never lets them remove a trail.
        assert!(!author_may_remove(
            false,
            "0123456789abcdef",
            Some("0123456789abcdef")
        ));
    }

    #[test]
    fn an_access_key_is_its_holder_asking_and_not_a_wrong_operator_token() {
        // The operator token: any trail.
        assert_eq!(remover(true, true, false), Ok(true));
        // A member's key on a colony with keys: tried as the author (the id the key stands for).
        assert_eq!(remover(true, false, true), Ok(false));
        // No bearer: tried as the author by the declared id.
        assert_eq!(remover(false, false, false), Ok(false));
        // A bearer that is neither: refused, and counted as a wrong guess.
        assert_eq!(remover(true, false, false), Err(()));
    }
}
