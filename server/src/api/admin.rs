//! The operator's panel: `GET /admin` (one self-contained page) and `/v1/admin/*`, all behind the operator token.
//!
//! What it does is what the command line already could, in one place: who has a key, what each person does with the
//! colony, and the few settings an operator may change while it runs. Nothing here can read a trail's text that the
//! feed does not already serve, and a key is shown once, when it is created, exactly as `myrmo-server keys add` does.
//! Every change is written to an audit list (`admin:audit`, the last 200) that the panel shows.

use super::*;
use crate::net::Cidr;
use axum::extract::{ConnectInfo, Path, Query};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SETTINGS: &str = "admin:settings";
const AUDIT: &str = "admin:audit";
const AUDIT_KEEP: isize = 199;
const PAGE: &str = include_str!("../admin.html");

/// What may be changed while the colony runs. Each falls back to the environment variable it came from.
#[derive(Clone)]
pub(super) struct Live {
    pub allowed: Vec<Cidr>,
    pub rate_limit: u64,
    pub publish_limit: u64,
    /// The settings an operator has changed (the others are as the environment says).
    pub overridden: Vec<&'static str>,
}

static CACHE: Mutex<Option<(Instant, Live)>> = Mutex::new(None);
const CACHE_FOR: Duration = Duration::from_secs(5);

fn from_environment(st: &AppState) -> Live {
    Live {
        allowed: st.cfg.allowed_networks.clone(),
        rate_limit: st.cfg.rate_limit_per_minute,
        publish_limit: st.cfg.publish_limit_per_hour,
        overridden: Vec::new(),
    }
}

/// The settings in force: the environment's, with what the operator changed on top. Read from Valkey at most every five
/// seconds; if Valkey cannot be asked the last answer, or the environment's, stands.
pub(super) async fn live(st: &AppState) -> Live {
    if let Some((at, live)) = CACHE.lock().unwrap().as_ref()
        && at.elapsed() < CACHE_FOR
    {
        return live.clone();
    }
    let mut live = from_environment(st);
    let stored: redis::RedisResult<HashMap<String, String>> = st.redis().hgetall(SETTINGS).await;
    match stored {
        Ok(stored) => {
            if let Some(text) = stored.get("allowed_networks") {
                live.allowed = Cidr::parse_list(text);
                live.overridden.push("allowed_networks");
            }
            if let Some(n) = stored
                .get("rate_limit_per_minute")
                .and_then(|v| v.parse().ok())
            {
                live.rate_limit = n;
                live.overridden.push("rate_limit_per_minute");
            }
            if let Some(n) = stored
                .get("publish_limit_per_hour")
                .and_then(|v| v.parse().ok())
            {
                live.publish_limit = n;
                live.overridden.push("publish_limit_per_hour");
            }
        }
        Err(err) => {
            tracing::warn!(error = %err, "live settings unavailable, using the last known");
            if let Some((_, last)) = CACHE.lock().unwrap().as_ref() {
                return last.clone();
            }
        }
    }
    *CACHE.lock().unwrap() = Some((Instant::now(), live.clone()));
    live
}

fn forget_cache() {
    *CACHE.lock().unwrap() = None;
}

fn private<T: IntoResponse>(body: T) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn audit(st: &AppState, what: &str) {
    let entry = json!({ "ts": keys::now(), "what": what }).to_string();
    let result: redis::RedisResult<()> = redis::pipe()
        .cmd("LPUSH")
        .arg(AUDIT)
        .arg(entry)
        .ignore()
        .cmd("LTRIM")
        .arg(AUDIT)
        .arg(0)
        .arg(AUDIT_KEEP)
        .ignore()
        .query_async(&mut st.redis())
        .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "audit entry not written");
    }
    tracing::info!(what, "operator action");
}

/// A change made through the operator token that is not made in this module (a trail removed) is recorded too.
pub(super) async fn record(st: &AppState, what: &str) {
    audit(st, what).await;
}

/// GET /admin: the page. It holds no data: it asks `/v1/admin/*` with the token its user types.
pub(super) async fn page() -> Response {
    let mut response = Response::new(axum::body::Body::from(PAGE));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[derive(serde::Deserialize)]
pub(super) struct Days {
    days: Option<i64>,
}

/// GET /v1/admin/people: who has a key and what each did in the last `days` days, with the reuse between people.
pub(super) async fn people(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Days>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let days = q.days.unwrap_or(7).clamp(1, 90);
    let mut con = st.redis();
    let holders = crate::access::list(&mut con)
        .await
        .map_err(|e| internal(&e))?;
    let (tally, reuse) = crate::team::summary(&mut con, days, keys::now(), 100)
        .await
        .map_err(|e| internal(&e))?;
    let people: Vec<Value> = holders
        .into_iter()
        .map(|(name, created)| {
            let n = tally.get(&name).cloned().unwrap_or_default();
            let get = |k: &str| n.get(k).copied().unwrap_or(0);
            let sum = |p: &str| {
                ["worked", "partially_worked", "failed", "not_applicable"]
                    .iter()
                    .map(|o| get(&format!("{p}_{o}")))
                    .sum::<i64>()
            };
            json!({
                "name": name, "created": created,
                "searches": get("searches"), "published": get("published"), "reports": get("reports"),
                "used_others": sum("used"), "used_others_worked": get("used_worked"),
                "helped_others": sum("helped"), "helped_others_worked": get("helped_worked"),
            })
        })
        .collect();
    Ok(private(Json(
        json!({ "days": days, "people": people, "reuse": reuse }),
    )))
}

fn internal(err: &anyhow::Error) -> ApiError {
    tracing::warn!(error = %err, "admin request failed");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "The colony could not do that.",
    )
}

/// POST /v1/admin/people {"name": "ana"}: a key for a person, returned once.
pub(super) async fn add_person(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let body = parse_body(body)?;
    let name = body["name"].as_str().unwrap_or_default().to_string();
    if !crate::access::valid_person(&name) {
        return Err(ApiError::bad_request(
            "A name is 2 to 32 lowercase letters, digits, '.', '-' or '_' (a handle, not an e-mail address).",
        ));
    }
    let key = match crate::access::add(&mut st.redis(), &name, keys::now()).await {
        Ok(key) => key,
        Err(err) if err.to_string().contains("already has a key") => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "exists",
                format!("{name} already has a key: revoke it first to issue a new one."),
            ));
        }
        Err(err) => return Err(internal(&err)),
    };
    audit(&st, &format!("key created for {name}")).await;
    Ok(private((
        StatusCode::CREATED,
        Json(json!({ "name": name, "key": key })),
    )))
}

/// DELETE /v1/admin/people/{name}: the key stops working at once.
pub(super) async fn revoke_person(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    match crate::access::revoke(&mut st.redis(), &name).await {
        Ok(true) => {
            audit(&st, &format!("key revoked for {name}")).await;
            Ok(private(Json(json!({ "name": name, "revoked": true }))))
        }
        Ok(false) => Err(ApiError::not_found(format!("{name} has no key."))),
        Err(err) => Err(internal(&err)),
    }
}

fn describe(st: &AppState, live: &Live, peer: &str) -> Value {
    let env = from_environment(st);
    let list = |v: &[Cidr]| v.iter().map(|c| c.to_string()).collect::<Vec<_>>();
    json!({
        "allowed_networks": list(&live.allowed),
        "rate_limit_per_minute": live.rate_limit,
        "publish_limit_per_hour": live.publish_limit,
        "overridden": live.overridden,
        "from_environment": {
            "allowed_networks": list(&env.allowed),
            "rate_limit_per_minute": env.rate_limit,
            "publish_limit_per_hour": env.publish_limit,
        },
        "your_address": peer,
        "read_only": {
            "require_key": st.cfg.require_key,
            "decision_engine": if st.cfg.decision_url.is_some() { "configured" } else { "none (rules only)" },
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

/// GET /v1/admin/settings
pub(super) async fn get_settings(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    forget_cache();
    let live = live(&st).await;
    Ok(private(Json(describe(&st, &live, &peer.ip().to_string()))))
}

/// PUT /v1/admin/settings: `{ "allowed_networks": "192.168.219.0/24", "rate_limit_per_minute": 120,
/// "publish_limit_per_hour": 30 }`, any of them; `null` goes back to the environment's value. A list of networks that
/// would shut out the very address the change comes from is refused, so the panel cannot lock its own user out.
pub(super) async fn put_settings(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let body = parse_body(body)?;
    let Some(object) = body.as_object() else {
        return Err(ApiError::bad_request("Send a JSON object of settings."));
    };
    forget_cache();
    let before = live(&st).await;
    let mut set: Vec<(&str, String)> = Vec::new();
    let mut unset: Vec<&str> = Vec::new();
    let mut allowed_after = before.allowed.clone();
    for (key, value) in object {
        match (key.as_str(), value) {
            ("allowed_networks", Value::Null) => {
                unset.push("allowed_networks");
                allowed_after = st.cfg.allowed_networks.clone();
            }
            ("allowed_networks", Value::String(text)) => {
                let mut parsed = Vec::new();
                for item in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    parsed.push(Cidr::parse(item).ok_or_else(|| {
                        ApiError::bad_request(format!(
                            "{item:?} is not an address or a range such as 192.168.219.0/24."
                        ))
                    })?);
                }
                allowed_after = parsed.clone();
                set.push((
                    "allowed_networks",
                    parsed
                        .iter()
                        .map(|c| c.to_string())
                        .collect::<Vec<_>>()
                        .join(","),
                ));
            }
            ("rate_limit_per_minute", v) | ("publish_limit_per_hour", v) => {
                let name = if key == "rate_limit_per_minute" {
                    "rate_limit_per_minute"
                } else {
                    "publish_limit_per_hour"
                };
                match v {
                    Value::Null => unset.push(name),
                    Value::Number(n) if n.as_u64().is_some_and(|n| n <= 100_000) => {
                        set.push((name, n.to_string()));
                    }
                    _ => {
                        return Err(ApiError::bad_request(format!(
                            "{name} is a whole number from 0 (no limit) to 100000."
                        )));
                    }
                }
            }
            (other, _) => {
                return Err(ApiError::bad_request(format!(
                    "{other:?} cannot be changed here."
                )));
            }
        }
    }
    if !crate::net::allows(peer.ip(), &allowed_after) {
        return Err(ApiError::bad_request(format!(
            "That list would shut out {}, the address you are using: add it, or a range that holds it.",
            peer.ip()
        )));
    }
    let mut pipe = redis::pipe();
    for (name, value) in &set {
        pipe.cmd("HSET").arg(SETTINGS).arg(name).arg(value).ignore();
    }
    for name in &unset {
        pipe.cmd("HDEL").arg(SETTINGS).arg(name).ignore();
    }
    pipe.query_async::<()>(&mut st.redis())
        .await
        .map_err(|e| internal(&e.into()))?;
    forget_cache();
    let after = live(&st).await;
    let list = |v: &[Cidr]| {
        v.iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    for (name, value) in &set {
        let was = match *name {
            "allowed_networks" => list(&before.allowed),
            "rate_limit_per_minute" => before.rate_limit.to_string(),
            _ => before.publish_limit.to_string(),
        };
        audit(&st, &format!("setting {name}: {was} -> {value}")).await;
    }
    for name in &unset {
        audit(
            &st,
            &format!("setting {name}: back to the environment's value"),
        )
        .await;
    }
    Ok(private(Json(describe(&st, &after, &peer.ip().to_string()))))
}

/// GET /v1/admin/audit: what operators changed, newest first.
pub(super) async fn audit_list(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let entries: Vec<String> = st
        .redis()
        .lrange(AUDIT, 0, AUDIT_KEEP)
        .await
        .map_err(|e| internal(&e.into()))?;
    let items: Vec<Value> = entries
        .iter()
        .filter_map(|e| serde_json::from_str(e).ok())
        .collect();
    Ok(private(Json(json!({ "items": items }))))
}

/// GET /v1/admin/activity?days=14: for each day, oldest first, the colony's totals (searches, how many were answered,
/// trails rejected) and what each person did; and when each person's key was last used.
pub(super) async fn activity(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Days>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let days = q.days.unwrap_or(14).clamp(1, 90);
    let mut con = st.redis();
    let now = keys::now();
    let per_person = crate::team::daily(&mut con, days, now)
        .await
        .map_err(|e| internal(&e))?;
    let totals = crate::analytics::export(&mut con, days)
        .await
        .map_err(|e| internal(&e.into()))?;
    let last_seen = crate::team::last_seen(&mut con)
        .await
        .map_err(|e| internal(&e))?;
    let series: Vec<Value> = per_person
        .into_iter()
        .map(|(date, people)| {
            let iso = format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]);
            let row = totals.iter().find(|r| r["date"] == iso);
            let total = |k: &str| row.map_or(0, |r| r["totals"][k].as_i64().unwrap_or(0));
            json!({
                "date": iso,
                "searches": total("searches"), "answered": total("search_hits"),
                "published": total("trails"), "rejected": total("rejected"),
                "people": people,
            })
        })
        .collect();
    Ok(private(Json(
        json!({ "days": series, "last_seen": last_seen }),
    )))
}

#[derive(serde::Deserialize)]
pub(super) struct TrailsQuery {
    limit: Option<usize>,
    cursor: Option<usize>,
}

/// GET /v1/admin/trails?limit=20&cursor=0: the colony's trails as the feed lists them (full content, risk, outcomes,
/// strength), each with who published it, which the public feed never says.
pub(super) async fn trails(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TrailsQuery>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let limit = q.limit.unwrap_or(20).clamp(1, 50);
    let start = q.cursor.unwrap_or(0).min(100_000);
    let mut con = st.redis();
    let ids: Vec<String> = con
        .zrevrange(keys::FEED, start as isize, (start + limit) as isize - 1)
        .await?;
    let mut items = super::feed::feed_items(&st, &ids).await?;
    for item in &mut items {
        let id = item["trail_id"].as_str().unwrap_or_default().to_string();
        let meta: HashMap<String, String> = con.hgetall(keys::trail(&id)).await?;
        let author = match super::trail_author(&mut con, &id, &meta).await? {
            // An address hash kept for a day is not a person.
            Some(a)
                if a.starts_with("person:")
                    || !a.is_empty() && !a.chars().all(|c| c.is_ascii_hexdigit()) =>
            {
                Some(crate::team::handle(&a).to_string())
            }
            _ => None,
        };
        item["author"] = json!(author);
    }
    let next = (ids.len() == limit).then(|| (start + limit).to_string());
    Ok(private(Json(
        json!({ "items": items, "next_cursor": next }),
    )))
}

/// GET /v1/admin/refused: the addresses whose connection was refused because their network is not allowed, most recent
/// first: what an operator needs to answer "why can't Diego connect?".
pub(super) async fn refused(State(st): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let rows = crate::analytics::refused_networks(&mut st.redis())
        .await
        .map_err(|e| internal(&e.into()))?;
    let items: Vec<Value> = rows
        .into_iter()
        .take(30)
        .map(|(address, count, last)| json!({ "address": address, "count": count, "last": last }))
        .collect();
    Ok(private(Json(json!({ "items": items }))))
}

/// `myrmo-server settings [show|reset]`: what the panel changed, and the way back when a change locks everyone out. It
/// needs only Valkey, so it works from the colony's machine while the gateway refuses every network.
pub async fn cli(redis_url: &str, args: &[String]) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let mut con = client.get_multiplexed_async_connection().await?;
    match args.first().map(String::as_str) {
        None | Some("show") => {
            let stored: HashMap<String, String> = redis::cmd("HGETALL")
                .arg(SETTINGS)
                .query_async(&mut con)
                .await?;
            if stored.is_empty() {
                println!("Nothing was changed from the panel: the environment's values apply.");
            }
            for (name, value) in &stored {
                println!("{name} = {value}");
            }
        }
        Some("reset") => {
            let _: () = redis::cmd("DEL")
                .arg(SETTINGS)
                .query_async(&mut con)
                .await?;
            println!("Back to the environment's values (the gateways pick it up within seconds).");
        }
        _ => anyhow::bail!("Usage: myrmo-server settings [show|reset]"),
    }
    Ok(())
}
