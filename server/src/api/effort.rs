//! `POST /v1/effort`: what solving a problem cost, measured by the client. See `crate::effort`.

use super::*;
use axum::extract::Extension;

pub(super) async fn report_effort(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    if !st.cfg.private {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_collected",
            "This colony does not collect measured effort: only an organisation's private colony does.",
        ));
    }
    if !caller.declared {
        return Err(ApiError::bad_request(
            "Send your agent id (X-Myrmo-Agent) or access key: records are counted once per person and error.",
        ));
    }
    let body = parse_body(body)?;
    if let Err(details) = crate::schema::validate_effort(&body) {
        return Err(ApiError::bad_request(
            "The record does not follow the protocol (effort_record).",
        )
        .details(json!(details)));
    }
    let record = crate::effort::parse(&body).map_err(ApiError::bad_request)?;
    let (stored, role) = crate::effort::store(&mut st.redis(), &caller.agent, &record, keys::now())
        .await
        .map_err(|err| {
            tracing::warn!(error = %err, "effort not stored");
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "A dependency is unavailable. Retry with backoff.",
            )
        })?;
    let status = if stored {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(json!({ "stored": stored, "role": role }))).into_response())
}
