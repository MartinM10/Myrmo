//! The operator's panel: `GET /admin` (one self-contained page) and `/v1/admin/*`, all behind the operator token.
//!
//! What it does is what the command line already could, in one place: who has a key, what each person does with the
//! colony, and the few settings an operator may change while it runs. Nothing here can read a trail's text that the
//! feed does not already serve, and a key is shown once, when it is created, exactly as `myrmo-server keys add` does.
//! Every change is written to an audit list (`admin:audit`, the last 200) that the panel shows.

use super::*;
use crate::net::Cidr;
use axum::extract::{ConnectInfo, Path, Query};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SETTINGS: &str = "admin:settings";
const AUDIT: &str = "admin:audit";
const AUDIT_KEEP: isize = 199;
const PAGE: &str = include_str!("../admin.html");

/// What may be changed while the colony runs. Each falls back to the environment variable it came from.
#[derive(Clone)]
pub(crate) struct Live {
    pub allowed: Vec<Cidr>,
    pub rate_limit: u64,
    pub publish_limit: u64,
    /// Keep the task requests nobody could answer (private colonies only).
    pub record_gaps: bool,
    /// Share of error lookups answered with nothing, to measure the colony against (private colonies only).
    pub holdout_percent: u64,
    /// What the organisation pays per million tokens of each model, for the Value tab.
    pub prices: crate::effort::Prices,
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
        record_gaps: st.cfg.private && st.cfg.record_gaps,
        holdout_percent: st.cfg.holdout_percent,
        prices: crate::effort::Prices::new(),
        overridden: Vec::new(),
    }
}

/// The settings in force: the environment's, with what the operator changed on top. Read from Valkey at most every five
/// seconds; if Valkey cannot be asked the last answer, or the environment's, stands.
pub(crate) async fn live(st: &AppState) -> Live {
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
            if let Some(v) = stored.get("record_gaps") {
                live.record_gaps = st.cfg.private && v == "1";
                live.overridden.push("record_gaps");
            }
            if let Some(n) = stored
                .get("holdout_percent")
                .and_then(|v| v.parse::<u64>().ok())
            {
                live.holdout_percent = if st.cfg.private {
                    n.min(crate::config::HOLDOUT_MAX)
                } else {
                    0
                };
                live.overridden.push("holdout_percent");
            }
            if let Some(p) = stored
                .get("prices")
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .and_then(|v| crate::effort::parse_prices(&v).ok())
            {
                live.prices = p;
                live.overridden.push("prices");
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
    let clients = crate::team::clients(&mut con).await.unwrap_or_default();
    let named = st.cfg.people_detail == crate::config::PeopleDetail::Named;
    let counts = |n: &BTreeMap<String, i64>| {
        let get = |k: &str| n.get(k).copied().unwrap_or(0);
        let sum = |p: &str| {
            ["worked", "partially_worked", "failed", "not_applicable"]
                .iter()
                .map(|o| get(&format!("{p}_{o}")))
                .sum::<i64>()
        };
        json!({
            "searches": get("searches"), "published": get("published"), "reports": get("reports"),
            "used_others": sum("used") + sum("reuse"), "used_others_worked": get("used_worked") + get("reuse_worked"),
            "helped_others": sum("helped"), "helped_others_worked": get("helped_worked"),
        })
    };
    let people: Vec<Value> = holders
        .into_iter()
        .map(|(name, created)| {
            // Who has a key and which client they run is what managing access needs; what they did is only kept
            // when the organisation chose to name people.
            let mut row = json!({ "name": name, "created": created, "clients": clients.get(&name).cloned().unwrap_or_default() });
            if named {
                let c = counts(&tally.get(&name).cloned().unwrap_or_default());
                row.as_object_mut().unwrap().extend(c.as_object().unwrap().clone());
            }
            row
        })
        .collect();
    // The team's totals: the sum over people, or the team's own counts when nobody is named.
    let mut team = BTreeMap::new();
    for n in tally.values() {
        for (k, v) in n {
            *team.entry(k.clone()).or_insert(0) += v;
        }
    }
    Ok(private(Json(json!({
        "days": days, "people_detail": st.cfg.people_detail.as_str(), "people": people, "team": counts(&team),
        "reuse": reuse, "released": crate::versions::describe()["clients"],
    }))))
}

fn internal(err: &anyhow::Error) -> ApiError {
    tracing::warn!(error = %err, "admin request failed");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "The colony could not do that.",
    )
}

/// POST /v1/admin/people: create access keys.
/// Supports:
/// - Single: `{"name": "ana"}`
/// - Batch names: `{"names": ["ana", "bob"]}`
/// - N keys for pilots: `{"count": 10, "prefix": "pilot"}`
pub(super) async fn add_person(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let body = parse_body(body)?;

    // Mode 1: Generate N keys (e.g. {"count": 10, "prefix": "pilot"})
    if let Some(count) = body["count"].as_u64() {
        if count == 0 || count > 500 {
            return Err(ApiError::bad_request("count must be between 1 and 500."));
        }
        let prefix = body["prefix"].as_str().unwrap_or("pilot").trim();
        let created = crate::access::generate_n(&mut st.redis(), count as usize, prefix, keys::now())
            .await
            .map_err(|e| internal(&e))?;
        let keys_json: Vec<Value> = created
            .iter()
            .map(|(p, k)| json!({ "name": p, "key": k }))
            .collect();
        audit(&st, &format!("generated {count} keys with prefix '{prefix}'")).await;
        return Ok(private((
            StatusCode::CREATED,
            Json(json!({ "created": keys_json, "keys": keys_json })),
        )));
    }

    // Mode 2: Batch names (e.g. {"names": ["ana", "bob"]})
    if let Some(names_arr) = body["names"].as_array() {
        if names_arr.is_empty() {
            return Err(ApiError::bad_request("names array must not be empty."));
        }
        let mut names = Vec::new();
        for v in names_arr {
            let s = v.as_str().unwrap_or_default().trim().to_ascii_lowercase();
            if !crate::access::valid_person(&s) {
                return Err(ApiError::bad_request(format!("{s:?} is not a valid name: 2-32 lowercase letters, digits, '.', '-' or '_'")));
            }
            names.push(s);
        }
        let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let created = crate::access::add_batch(&mut st.redis(), &name_refs, keys::now())
            .await
            .map_err(|err| {
                if err.to_string().contains("already has a key") {
                    ApiError::new(StatusCode::CONFLICT, "exists", err.to_string())
                } else {
                    internal(&err)
                }
            })?;
        let keys_json: Vec<Value> = created
            .iter()
            .map(|(p, k)| json!({ "name": p, "key": k }))
            .collect();
        audit(&st, &format!("batch keys created for {} people", created.len())).await;
        return Ok(private((
            StatusCode::CREATED,
            Json(json!({ "created": keys_json, "keys": keys_json })),
        )));
    }

    // Mode 3: Single name {"name": "ana"}
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

#[derive(serde::Deserialize)]
pub(super) struct Revoke {
    #[serde(default)]
    erase: bool,
}

/// DELETE /v1/admin/people/{name}: the key stops working at once. With `?erase=true`, everything kept about the
/// person's activity goes too (their right to erasure): counts, last use, client versions, their name in reuse records
/// and knowledge gaps, and their name as the author of what they published, which stays as the organisation's
/// knowledge. Erasing works for a person whose key was already revoked.
pub(super) async fn revoke_person(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<Revoke>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    if !crate::access::valid_person(&name) {
        return Err(ApiError::bad_request("Not a person's name."));
    }
    let mut con = st.redis();
    let revoked = crate::access::revoke(&mut con, &name)
        .await
        .map_err(|e| internal(&e))?;
    if !revoked && !q.erase {
        return Err(ApiError::not_found(format!("{name} has no key.")));
    }
    if revoked {
        audit(&st, &format!("key revoked for {name}")).await;
    }
    let mut erased = None;
    if q.erase {
        let mut n = crate::team::erase(&mut con, &name, keys::now())
            .await
            .map_err(|e| internal(&e))?;
        n += erase_gaps(&st, &name).await.map_err(|e| internal(&e))?;
        // The audit list names the person in its own entries; the erasure is recorded without the name.
        let mut entries: Vec<String> = con
            .lrange(AUDIT, 0, AUDIT_KEEP)
            .await
            .map_err(|e| internal(&e.into()))?;
        for e in &mut entries {
            if e.contains(&format!(" for {name}\"")) {
                *e = e.replace(&format!(" for {name}\""), " for an erased person\"");
            }
        }
        if !entries.is_empty() {
            let _: () = redis::pipe()
                .cmd("DEL")
                .arg(AUDIT)
                .ignore()
                .cmd("RPUSH")
                .arg(AUDIT)
                .arg(&entries)
                .ignore()
                .query_async(&mut con)
                .await
                .map_err(|e| internal(&e.into()))?;
        }
        audit(&st, &format!("data of a person erased ({n} items)")).await;
        erased = Some(n);
    }
    Ok(private(Json(
        json!({ "name": name, "revoked": revoked, "erased": erased }),
    )))
}

/// A person's name removed from the knowledge gaps they asked.
async fn erase_gaps(st: &AppState, person: &str) -> anyhow::Result<u64> {
    let mut con = st.redis();
    let entries: Vec<String> = con.lrange(GAPS, 0, GAPS_KEEP).await?;
    let mut n = 0;
    let rewritten: Vec<String> = entries
        .into_iter()
        .map(|e| match serde_json::from_str::<Value>(&e) {
            Ok(mut v) if v["who"] == person => {
                v["who"] = Value::Null;
                n += 1;
                v.to_string()
            }
            _ => e,
        })
        .collect();
    if n > 0 {
        let _: () = redis::pipe()
            .cmd("DEL")
            .arg(GAPS)
            .ignore()
            .cmd("RPUSH")
            .arg(GAPS)
            .arg(&rewritten)
            .ignore()
            .query_async(&mut con)
            .await?;
    }
    Ok(n)
}

fn describe(st: &AppState, live: &Live, peer: &str) -> Value {
    let env = from_environment(st);
    let list = |v: &[Cidr]| v.iter().map(|c| c.to_string()).collect::<Vec<_>>();
    json!({
        "allowed_networks": list(&live.allowed),
        "rate_limit_per_minute": live.rate_limit,
        "publish_limit_per_hour": live.publish_limit,
        "record_gaps": live.record_gaps,
        "holdout_percent": live.holdout_percent,
        "prices": live.prices,
        "overridden": live.overridden,
        "from_environment": {
            "allowed_networks": list(&env.allowed),
            "rate_limit_per_minute": env.rate_limit,
            "publish_limit_per_hour": env.publish_limit,
            "record_gaps": env.record_gaps,
            "holdout_percent": env.holdout_percent,
        },
        "your_address": peer,
        "read_only": {
            "require_key": st.cfg.require_key,
            "private": st.cfg.private,
            "profile": st.cfg.profile(),
            "people_detail": st.cfg.people_detail.as_str(),
            "task_index": st.tasks.is_some(),
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

/// PUT /v1/admin/settings: `{ "allowed_networks": "10.20.0.0/24", "rate_limit_per_minute": 120,
/// "publish_limit_per_hour": 30, "record_gaps": true, "holdout_percent": 5, "prices": {...} }`, any of them; `null` goes
/// back to the environment's value. A list of networks that
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
                            "{item:?} is not an address or a range such as 10.20.0.0/24."
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
            ("record_gaps", Value::Null) => unset.push("record_gaps"),
            ("record_gaps", Value::Bool(on)) => {
                if !st.cfg.private {
                    return Err(ApiError::bad_request(
                        "Requests are only ever kept by an organisation's private colony.",
                    ));
                }
                set.push(("record_gaps", if *on { "1" } else { "0" }.to_string()));
            }
            ("record_gaps", _) => {
                return Err(ApiError::bad_request("record_gaps is true or false."));
            }
            ("holdout_percent", Value::Null) => unset.push("holdout_percent"),
            ("holdout_percent", v) => {
                if !st.cfg.private {
                    return Err(ApiError::bad_request(
                        "Only an organisation's private colony holds lookups out to measure itself.",
                    ));
                }
                match v.as_u64() {
                    Some(n) if n <= crate::config::HOLDOUT_MAX => {
                        set.push(("holdout_percent", n.to_string()))
                    }
                    _ => {
                        return Err(ApiError::bad_request(format!(
                            "holdout_percent is a whole number from 0 to {}.",
                            crate::config::HOLDOUT_MAX
                        )));
                    }
                }
            }
            ("prices", Value::Null) => unset.push("prices"),
            ("prices", v) => {
                let prices = crate::effort::parse_prices(v).map_err(ApiError::bad_request)?;
                set.push(("prices", serde_json::to_string(&prices).unwrap_or_default()));
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
            "record_gaps" => if before.record_gaps { "1" } else { "0" }.to_string(),
            "holdout_percent" => before.holdout_percent.to_string(),
            "prices" => serde_json::to_string(&before.prices).unwrap_or_default(),
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
        // What following it cost, when the people who followed it measured it.
        item["effort"] = crate::effort::of_trail(&mut con, &id)
            .await
            .unwrap_or(None)
            .unwrap_or(Value::Null);
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

// ---------------------------------------------------------------------------
// Knowledge gaps and knowledge health: what the colony does not know, and what it knows that may no longer be true.

const GAPS: &str = "admin:gaps";
const GAPS_KEEP: isize = 499;
const GAP_DAYS: i64 = 30;

/// A task request the colony could not answer, kept for the operator when they chose so (private colonies only):
/// redacted already, cut to 300 characters, with the person whose key asked. Listed for 30 days.
pub(super) async fn record_gap(st: &AppState, caller: &Caller, query: &str, now: i64) {
    if !st.cfg.private || !live(st).await.record_gaps {
        return;
    }
    // Who asked is kept only when the organisation chose to name people.
    let who = (st.cfg.people_detail == crate::config::PeopleDetail::Named
        && caller.agent.starts_with("person:"))
    .then(|| crate::team::handle(&caller.agent).to_string());
    let entry =
        json!({ "ts": now, "who": who, "text": query.chars().take(300).collect::<String>() });
    let result: redis::RedisResult<()> = redis::pipe()
        .cmd("LPUSH")
        .arg(GAPS)
        .arg(entry.to_string())
        .ignore()
        .cmd("LTRIM")
        .arg(GAPS)
        .arg(0)
        .arg(GAPS_KEEP)
        .ignore()
        .query_async(&mut st.redis())
        .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "knowledge gap not recorded");
    }
}

/// GET /v1/admin/gaps: the task requests nobody's knowledge answered in the last 30 days, newest first.
pub(super) async fn gaps(State(st): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let enabled = live(&st).await.record_gaps;
    let raw: Vec<String> = st.redis().lrange(GAPS, 0, GAPS_KEEP).await?;
    let since = keys::now() - GAP_DAYS * 86_400;
    let items: Vec<Value> = raw
        .iter()
        .filter_map(|r| serde_json::from_str::<Value>(r).ok())
        .filter(|v| v["ts"].as_i64().unwrap_or(0) >= since)
        .map(|v| json!({ "at": keys::iso(v["ts"].as_i64().unwrap_or(0)), "who": v["who"], "text": v["text"] }))
        .collect();
    Ok(private(Json(json!({
        "enabled": enabled,
        "private": st.cfg.private,
        "days": GAP_DAYS,
        "items": items,
    }))))
}

/// One line about a trail for the health report.
fn health_item(c: &super::Candidate, now: i64) -> Value {
    let p = &c.payload;
    let last = if c.outcomes.last_success_ts > 0 {
        c.outcomes.last_success_ts
    } else {
        p["created_ts"].as_i64().unwrap_or(now)
    };
    json!({
        "trail_id": c.id,
        "kind": p["kind"].as_str().unwrap_or("fix"),
        "label": c.label(),
        "strength": super::round3(c.strength(now)),
        "outcomes": c.outcomes.json(),
        "created_at": p["created_at"],
        "last_success_at": keys::iso(last),
        "source": p["trail"]["source"],
    })
}

/// GET /v1/admin/knowledge: what the colony holds and how much of it can still be trusted. Stale: no success for 90
/// days (its strength has halved). Contested: more failures than successes. Unconfirmed: nobody reported on it after
/// two weeks (an imported handover often is). Most used: the most confirmed. Plus how often a task found an answer.
pub(super) async fn knowledge(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let mut con = st.redis();
    let ids: Vec<String> = con.zrevrange(keys::FEED, 0, 4999).await?;
    let mut all = Vec::new();
    for chunk in ids.chunks(256) {
        all.extend(super::load(&st, chunk).await?);
    }
    let now = keys::now();
    let mut kinds: BTreeMap<String, i64> = BTreeMap::new();
    let mut sources: BTreeMap<String, i64> = BTreeMap::new();
    for c in &all {
        *kinds
            .entry(c.payload["kind"].as_str().unwrap_or("fix").to_string())
            .or_default() += 1;
        let source = c.payload["trail"]["source"]["type"]
            .as_str()
            .unwrap_or("agent");
        *sources.entry(source.to_string()).or_default() += 1;
    }
    let reports =
        |c: &super::Candidate| c.outcomes.worked + c.outcomes.partially_worked + c.outcomes.failed;
    let since_success = |c: &super::Candidate| {
        let last = if c.outcomes.last_success_ts > 0 {
            c.outcomes.last_success_ts
        } else {
            c.payload["created_ts"].as_i64().unwrap_or(now)
        };
        now - last
    };
    let pick = |filter: &dyn Fn(&super::Candidate) -> bool,
                key: &dyn Fn(&super::Candidate) -> i64| {
        let mut rows: Vec<&super::Candidate> = all.iter().filter(|c| filter(c)).collect();
        let count = rows.len();
        rows.sort_by_key(|c| std::cmp::Reverse(key(c)));
        json!({ "count": count, "items": rows.iter().take(15).map(|c| health_item(c, now)).collect::<Vec<_>>() })
    };
    let stale = pick(&|c| since_success(c) > 90 * 86_400, &since_success);
    let contested = pick(
        &|c| {
            c.outcomes.failed >= 2
                && c.outcomes.failed > c.outcomes.worked + c.outcomes.partially_worked
        },
        &|c| c.outcomes.failed as i64,
    );
    let unconfirmed = pick(
        &|c| reports(c) == 0 && now - c.payload["created_ts"].as_i64().unwrap_or(now) > 14 * 86_400,
        &|c| now - c.payload["created_ts"].as_i64().unwrap_or(now),
    );
    let most_used = pick(&|c| c.outcomes.worked > 0, &|c| c.outcomes.worked as i64);
    let rows = crate::analytics::export(&mut con, 30).await?;
    let total = |name: &str| -> i64 {
        rows.iter()
            .map(|r| r["totals"][name].as_i64().unwrap_or(0))
            .sum()
    };
    Ok(private(Json(json!({
        "total": all.len(),
        "kinds": kinds,
        "sources": sources,
        "task_searches_30d": total("task_searches"),
        "task_answered_30d": total("task_answered"),
        "stale": stale,
        "contested": contested,
        "unconfirmed": unconfirmed,
        "most_used": most_used,
    }))))
}

// ---------------------------------------------------------------------------
// The knowledge map: every entry as a node, linked to the entries most like it.

/// How an entry is doing, by the same rules as the health report.
fn health(c: &super::Candidate, now: i64) -> &'static str {
    let o = &c.outcomes;
    let created = c.payload["created_ts"].as_i64().unwrap_or(now);
    let last = if o.last_success_ts > 0 {
        o.last_success_ts
    } else {
        created
    };
    if o.failed >= 2 && o.failed > o.worked + o.partially_worked {
        "contested"
    } else if now - last > 90 * 86_400 {
        "stale"
    } else if o.worked + o.partially_worked + o.failed == 0 && now - created > 14 * 86_400 {
        "unconfirmed"
    } else {
        "ok"
    }
}

/// The links of the map: one per pair of entries, whatever the direction it was found in, with its similarity, when
/// it reaches `min` and is among the `per_entry` closest of at least one of the two. Every weak link drawn makes the
/// map a tangle; the closest few make topics show as islands.
fn map_edges(
    pairs: &[(String, String, f64)],
    min: f64,
    per_entry: usize,
) -> Vec<(String, String, f64)> {
    let mut best: HashMap<(String, String), f64> = HashMap::new();
    for (a, b, score) in pairs {
        if a == b || *score < min {
            continue;
        }
        let key = if a < b {
            (a.clone(), b.clone())
        } else {
            (b.clone(), a.clone())
        };
        let entry = best.entry(key).or_insert(*score);
        *entry = entry.max(*score);
    }
    let mut edges: Vec<(String, String, f64)> =
        best.into_iter().map(|((a, b), s)| (a, b, s)).collect();
    edges.sort_by(|x, y| y.2.total_cmp(&x.2).then_with(|| x.0.cmp(&y.0)));
    let mut degree: HashMap<String, usize> = HashMap::new();
    edges.retain(|(a, b, _)| {
        let keep = degree.get(a).copied().unwrap_or(0) < per_entry
            || degree.get(b).copied().unwrap_or(0) < per_entry;
        if keep {
            *degree.entry(a.clone()).or_default() += 1;
            *degree.entry(b.clone()).or_default() += 1;
        }
        keep
    });
    edges
}

const MAP_MAX: usize = 2000;

/// GET /v1/admin/map: the entries (up to 2,000) with their kind, strength and health, and links to the entries most
/// like each, from the task index when the colony has one (what an entry is about), else from the error index.
pub(super) async fn map(State(st): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let mut con = st.redis();
    let total: usize = con.zcard(keys::FEED).await?;
    let (index, qdrant, min) = match &st.tasks {
        Some(t) => ("task", &t.qdrant, st.cfg.task_min_similarity * 0.8),
        None => ("error", &st.qdrant, st.cfg.min_similarity * 0.85),
    };
    let sample = total.min(MAP_MAX);
    let pairs = if sample >= 2 {
        qdrant
            .neighbour_pairs(sample, 4)
            .await
            .map_err(|e| internal(&e))?
    } else {
        Vec::new()
    };
    let mut ids: Vec<String> = pairs
        .iter()
        .flat_map(|(a, b, _)| [a.clone(), b.clone()])
        .collect();
    if ids.is_empty() {
        ids = con.zrevrange(keys::FEED, 0, MAP_MAX as isize - 1).await?;
    }
    ids.sort();
    ids.dedup();
    let mut nodes = Vec::new();
    let now = keys::now();
    for chunk in ids.chunks(256) {
        for c in super::load(&st, chunk).await? {
            let t = &c.payload["trail"];
            nodes.push(json!({
                "id": c.id,
                "kind": c.payload["kind"].as_str().unwrap_or("fix"),
                "category": c.payload["category"],
                "label": c.label(),
                "summary": t["problem"]["summary"],
                "strength": super::round3(c.strength(now)),
                "worked": c.outcomes.worked,
                "failed": c.outcomes.failed,
                "health": health(&c, now),
                "tags": t["tags"],
                "source": t["source"]["type"],
                "created_at": c.payload["created_at"],
            }));
        }
    }
    let known: std::collections::HashSet<&str> =
        nodes.iter().filter_map(|n| n["id"].as_str()).collect();
    let edges: Vec<Value> = map_edges(&pairs, min, 2)
        .into_iter()
        .filter(|(a, b, _)| known.contains(a.as_str()) && known.contains(b.as_str()))
        .map(|(a, b, s)| json!({ "a": a, "b": b, "s": super::round3(s) }))
        .collect();
    Ok(private(Json(json!({
        "index": index,
        "total": total,
        "nodes": nodes,
        "edges": edges,
    }))))
}

/// GET /v1/admin/value?days=30: what the colony saved, how it was worked out, and the records per day.
pub(super) async fn value(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Days>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let days = q.days.unwrap_or(30).clamp(1, 90);
    let mut con = st.redis();
    let per_fp = crate::effort::load(&mut con)
        .await
        .map_err(|e| internal(&e))?;
    let live = live(&st).await;
    let mut body = crate::effort::value(&per_fp, &live.prices);
    body["days"] = json!(
        crate::effort::daily(&mut con, days, keys::now())
            .await
            .map_err(|e| internal(&e))?
    );
    body["holdout_percent"] = json!(live.holdout_percent);
    body["people"] = crate::effort::contributors(&mut con)
        .await
        .map_err(|e| internal(&e))?;
    body["collecting"] = json!(st.cfg.private);
    body["pilot_roi"] = json!(crate::effort::pilot_roi(&mut con, &st, 14, keys::now()).await.unwrap_or(Value::Null));
    Ok(private(Json(body)))
}

/// GET /v1/admin/pilot-roi?days=14: clean Pilot ROI Summary for B2B enterprise pilots.
pub(super) async fn pilot_roi(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Days>,
) -> ApiResult<Response> {
    authorize_operator(&st, &headers)?;
    let days = q.days.unwrap_or(14).clamp(1, 90);
    let mut con = st.redis();
    let summary = crate::effort::pilot_roi(&mut con, &st, days, keys::now())
        .await
        .map_err(|e| internal(&e))?;
    Ok(private(Json(summary)))
}

#[cfg(test)]
mod map_tests {
    use super::*;

    #[test]
    fn one_link_per_pair_the_strongest_and_none_below_the_bar() {
        let p = |a: &str, b: &str, s: f64| (a.to_string(), b.to_string(), s);
        let pairs = [
            p("a", "b", 0.7),
            p("b", "a", 0.72),
            p("a", "c", 0.3),
            p("c", "c", 1.0),
            p("b", "c", 0.6),
        ];
        assert_eq!(
            map_edges(&pairs, 0.5, 3),
            vec![p("a", "b", 0.72), p("b", "c", 0.6)]
        );
    }

    #[test]
    fn each_entry_keeps_its_closest_links_only() {
        let p = |a: &str, b: &str, s: f64| (a.to_string(), b.to_string(), s);
        // a, b and h are all close; with one link each, h-b goes. d's only link, to h, stays: it is d's closest.
        let pairs = [
            p("h", "a", 0.9),
            p("h", "b", 0.8),
            p("a", "b", 0.85),
            p("h", "d", 0.55),
        ];
        assert_eq!(
            map_edges(&pairs, 0.5, 1),
            vec![p("a", "h", 0.9), p("a", "b", 0.85), p("d", "h", 0.55)]
        );
    }
}
