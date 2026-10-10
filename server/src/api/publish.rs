//! Publishing: straight from an agent, or as a draft a person approves in a browser.

use super::*;
use crate::keys;
use crate::redact::{self, Report};
use crate::state::AppState;
use crate::{fingerprint, risk, schema};
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands;
use serde_json::{Value, json};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// POST /v1/trails

/// Publishing is the only expensive write: every trail costs enrichment and a model call. Refuse
/// when the queue is already deep (so the backlog cannot exhaust memory), then charge the
/// client's hourly quota. The quota counts the hashed address, not the self-declared agent id.
async fn enforce_publish_limits(st: &AppState, caller: &Caller) -> ApiResult<()> {
    let mut con = st.redis();
    let queue_max = st.cfg.queue_max;
    if queue_max > 0 {
        let depth: u64 = con.xlen(keys::STREAM).await?;
        if depth >= queue_max {
            tracing::warn!(depth, queue_max, "publish queue is full");
            let mut err = ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "The colony is catching up on new trails. Retry in a minute.",
            );
            err.retry_after = Some(60);
            return Err(err);
        }
    }
    let limit = st.cfg.publish_limit_per_hour;
    if limit > 0 {
        let now = keys::now();
        let key = keys::publish_quota(&caller.client, keys::hour(now));
        let (used,): (u64,) = redis::pipe()
            .cmd("INCR")
            .arg(&key)
            .cmd("EXPIRE")
            .arg(&key)
            .arg(3_700)
            .ignore()
            .query_async(&mut con)
            .await?;
        if used > limit {
            let mut err = ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "publish_limited",
                format!("Publishing quota of {limit} trails per hour reached."),
            );
            err.retry_after = Some(3_600 - now % 3_600);
            return Err(err);
        }
    }
    Ok(())
}

/// Put a validated, redacted trail in the enrichment queue. Returns its id.
async fn queue_trail(st: &AppState, caller: &Caller, trail: &Value, fp: &str) -> ApiResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = keys::now();
    let mut pipe = redis::pipe();
    pipe.cmd("HSET")
        .arg(keys::trail(&id))
        .arg("status")
        .arg("queued")
        .arg("fingerprint")
        .arg(fp)
        .arg("created_ts")
        .arg(now)
        .ignore();
    // The publisher's address hash is kept for a day whether or not an agent id was declared, so that
    // changing the id does not let the publisher confirm their own trail.
    pipe.cmd("SET")
        .arg(keys::pub_addr(&id))
        .arg(&caller.client)
        .arg("EX")
        .arg(86_400)
        .ignore();
    // A declared agent id is pseudonymous by design and stays with the trail. An address hash
    // is kept for a day only: enough to stop the publisher confirming their own trail.
    if caller.declared {
        pipe.cmd("HSET")
            .arg(keys::trail(&id))
            .arg("author")
            .arg(&caller.agent)
            .ignore();
    } else {
        pipe.cmd("SET")
            .arg(keys::anon_author(&id))
            .arg(&caller.agent)
            .arg("EX")
            .arg(86_400)
            .ignore();
    }
    let _: () = pipe
        .cmd("XADD")
        .arg(keys::STREAM)
        .arg("MAXLEN")
        .arg("~")
        .arg(1_000_000)
        .arg("*")
        .arg("id")
        .arg(&id)
        .arg("trail")
        .arg(trail.to_string())
        .ignore()
        .query_async(&mut st.redis())
        .await?;
    Ok(id)
}

/// Validate against protocol v1 and redact: what both publishing paths do first.
fn prepare_trail(body: Result<Bytes, BytesRejection>) -> ApiResult<(Value, Report, String)> {
    let mut trail = parse_body(body)?;
    schema::validate_trail(&trail).map_err(|details| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_trail",
            "The trail does not validate against protocol v1.",
        )
        .details(json!(details))
    })?;
    let mut report = Report::new();
    redact::redact_value(&mut trail, &mut report);
    let fp = fingerprint::of_trail(&trail);
    Ok((trail, report, fp))
}

/// POST /v1/validate: what publishing would check, without publishing. A client shows a person
/// the trail it is about to send, and this tells it whether the colony would accept it, so a
/// payload that looks right in the preview is not refused afterwards. Nothing is stored and no
/// publishing quota is used.
pub(super) async fn validate(body: Result<Bytes, BytesRejection>) -> ApiResult<Json<Value>> {
    let (_trail, report, fp) = prepare_trail(body)?;
    Ok(Json(
        json!({ "valid": true, "fingerprint": fp, "redactions": report }),
    ))
}

pub(super) async fn publish(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    let (trail, report, fp) = prepare_trail(body)?;
    enforce_publish_limits(&st, &caller).await?;
    let id = queue_trail(&st, &caller, &trail, &fp).await?;
    let body = json!({
        "trail_id": id,
        "fingerprint": fp,
        "status": "queued",
        "status_url": format!("/v1/trails/{id}"),
        "redactions": report,
    });
    Ok((StatusCode::ACCEPTED, Json(body)).into_response())
}

// ---------------------------------------------------------------------------
// Drafts: publishing that a person approves in a browser
//
// A client that cannot ask its user (the hosted MCP server is stateless) creates a draft. The
// colony redacts it and holds it for 30 minutes under an unguessable token; the person opens
// the approval page, sees the exact payload and chooses. Nothing is published before that.
//
// The token is the only credential, so whoever holds the link can approve: an agent with web
// access could too. Where that matters, publish through a client that asks (MCP elicitation)
// or keep publishing off.

const DRAFT_TTL_SECONDS: i64 = 30 * 60;
const DRAFTS_PER_CLIENT_PER_HOUR: u64 = 30;
const DRAFTS_PER_HOUR: u64 = 2_000;

fn valid_draft_token(token: &str) -> bool {
    token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit())
}

pub(super) async fn create_draft(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    let (trail, report, fp) = prepare_trail(body)?;
    let mut con = st.redis();
    let hour = keys::hour(keys::now());
    // Per client, and overall: a draft holds up to 64 KB for half an hour.
    for (key, limit) in [
        (
            keys::draft_quota(&caller.client, hour),
            DRAFTS_PER_CLIENT_PER_HOUR,
        ),
        (keys::draft_quota("all", hour), DRAFTS_PER_HOUR),
    ] {
        let (used,): (u64,) = redis::pipe()
            .cmd("INCR")
            .arg(&key)
            .cmd("EXPIRE")
            .arg(&key)
            .arg(3_700)
            .ignore()
            .query_async(&mut con)
            .await?;
        if used > limit {
            let mut err = ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "draft_limited",
                "Too many drafts. Try again later.",
            );
            err.retry_after = Some(3_600 - keys::now() % 3_600);
            return Err(err);
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let _: () = redis::pipe()
        .cmd("HSET")
        .arg(keys::draft(&token))
        .arg("state")
        .arg("pending")
        .arg("trail")
        .arg(trail.to_string())
        .arg("fingerprint")
        .arg(&fp)
        .arg("agent")
        .arg(&caller.agent)
        .arg("declared")
        .arg(i32::from(caller.declared))
        .arg("client")
        .arg(&caller.client)
        .ignore()
        .cmd("EXPIRE")
        .arg(keys::draft(&token))
        .arg(DRAFT_TTL_SECONDS)
        .ignore()
        .query_async(&mut con)
        .await?;
    let body = json!({
        "draft_id": token,
        "approve_url": format!("{}/approve.html#{token}", st.cfg.public_url),
        "expires_in": DRAFT_TTL_SECONDS,
        "fingerprint": fp,
        "redactions": report,
        "risk": risk::assess(&trail),
        "trail": trail,
    });
    Ok((StatusCode::CREATED, Json(body)).into_response())
}

async fn load_draft(st: &AppState, token: &str) -> ApiResult<HashMap<String, String>> {
    if !valid_draft_token(token) {
        return Err(ApiError::not_found("No draft with that id, or it expired."));
    }
    let draft: HashMap<String, String> = st.redis().hgetall(keys::draft(token)).await?;
    if draft.is_empty() {
        return Err(ApiError::not_found("No draft with that id, or it expired."));
    }
    Ok(draft)
}

fn no_store(body: Value) -> Response {
    let mut res = Json(body).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub(super) async fn get_draft(
    State(st): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    let draft = load_draft(&st, &token).await?;
    let state = draft.get("state").map_or("pending", String::as_str);
    let mut body = json!({ "draft_id": token, "state": state });
    match state {
        "pending" => {
            let trail: Value = draft
                .get("trail")
                .and_then(|t| serde_json::from_str(t).ok())
                .unwrap_or(Value::Null);
            let ttl: i64 = st.redis().ttl(keys::draft(&token)).await?;
            body["expires_in"] = json!(ttl.max(0));
            body["fingerprint"] = json!(draft.get("fingerprint"));
            body["risk"] = risk::assess(&trail);
            body["trail"] = trail;
        }
        "published" => {
            if let Some(id) = draft.get("trail_id") {
                let meta: HashMap<String, String> = st.redis().hgetall(keys::trail(id)).await?;
                body["trail_id"] = json!(id);
                body["trail_status"] = json!(meta.get("status"));
                body["reasons"] = meta
                    .get("reasons")
                    .and_then(|r| serde_json::from_str(r).ok())
                    .unwrap_or(json!([]));
            }
        }
        _ => {}
    }
    Ok(no_store(body))
}

pub(super) async fn publish_draft(
    State(st): State<AppState>,
    Path(token): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    let draft = load_draft(&st, &token).await?;
    let state = draft.get("state").map_or("pending", String::as_str);
    let already = |draft: &HashMap<String, String>| {
        let id = draft.get("trail_id").cloned().unwrap_or_default();
        no_store(
            json!({ "trail_id": id, "status": "queued", "status_url": format!("/v1/trails/{id}") }),
        )
    };
    match state {
        "published" => return Ok((StatusCode::ACCEPTED, already(&draft)).into_response()),
        "discarded" => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "discarded",
                "This draft was discarded.",
            ));
        }
        _ => {}
    }
    // Publishing licenses the trail as the terms say, so whoever presses Publish says they accept them.
    let accepted = parse_body(body)
        .ok()
        .is_some_and(|b| b["accepted_terms"] == json!(true));
    if !accepted {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "terms_not_accepted",
            "Publishing needs the terms of service to be accepted: send {\"accepted_terms\": true}.",
        ));
    }
    // Two clicks at once must not publish twice.
    let mut con = st.redis();
    let first: bool = con.hset_nx(keys::draft(&token), "publishing", 1).await?;
    if !first {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "in_progress",
            "This draft is being published.",
        ));
    }
    let caller = Caller {
        agent: draft.get("agent").cloned().unwrap_or_default(),
        declared: draft.get("declared").is_some_and(|d| d == "1"),
        client: draft.get("client").cloned().unwrap_or_default(),
    };
    let result = async {
        // The creator's quota applies, not the approver's: the person approving is not the agent.
        enforce_publish_limits(&st, &caller).await?;
        let trail: Value = draft
            .get("trail")
            .and_then(|t| serde_json::from_str(t).ok())
            .ok_or_else(|| ApiError::bad_request("The draft is damaged."))?;
        let fp = draft.get("fingerprint").cloned().unwrap_or_default();
        queue_trail(&st, &caller, &trail, &fp).await
    }
    .await;
    match result {
        Ok(id) => {
            let _: () = redis::pipe()
                .cmd("HSET")
                .arg(keys::draft(&token))
                .arg("state")
                .arg("published")
                .arg("trail_id")
                .arg(&id)
                .ignore()
                .cmd("HDEL")
                .arg(keys::draft(&token))
                .arg("trail")
                .ignore()
                .cmd("EXPIRE")
                .arg(keys::draft(&token))
                .arg(86_400)
                .ignore()
                .query_async(&mut con)
                .await?;
            Ok((
                StatusCode::ACCEPTED,
                no_store(json!({ "trail_id": id, "status": "queued", "status_url": format!("/v1/trails/{id}") })),
            )
                .into_response())
        }
        Err(err) => {
            // Let the person try again, for example after a quota error.
            let _: redis::RedisResult<i64> = con.hdel(keys::draft(&token), "publishing").await;
            Err(err)
        }
    }
}

pub(super) async fn discard_draft(
    State(st): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    let draft = load_draft(&st, &token).await?;
    if draft.get("state").is_some_and(|s| s == "published") {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "published",
            "This draft was already published.",
        ));
    }
    let _: () = redis::pipe()
        .cmd("HSET")
        .arg(keys::draft(&token))
        .arg("state")
        .arg("discarded")
        .ignore()
        .cmd("HDEL")
        .arg(keys::draft(&token))
        .arg("trail")
        .ignore()
        .cmd("EXPIRE")
        .arg(keys::draft(&token))
        .arg(3_600)
        .ignore()
        .query_async(&mut st.redis())
        .await?;
    Ok(no_store(json!({ "draft_id": token, "state": "discarded" })))
}
