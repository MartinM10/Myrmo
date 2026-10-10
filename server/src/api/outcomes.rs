//! Outcome reports: what happened to the agents that followed a trail.

use super::*;
use crate::keys;
use crate::redact::{self, Report};
use crate::state::AppState;
use crate::{schema, strength};
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands;
use serde_json::{Value, json};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// POST /v1/trails/{id}/outcomes

fn environment_summary(env: &Value) -> String {
    let s = |p: &str| env.pointer(p).and_then(Value::as_str).unwrap_or_default();
    [
        [s("/os"), s("/os_version")]
            .iter()
            .filter(|x| !x.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" "),
        s("/arch").to_string(),
        [s("/runtime/name"), s("/runtime/version")]
            .iter()
            .filter(|x| !x.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" "),
    ]
    .into_iter()
    .filter(|x| !x.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Whether a report can count at all: anybody's, except an author's that would raise the strength of their own trail.
fn author_may_report(is_author: bool, outcome: &str) -> bool {
    !is_author || outcome == "failed"
}

/// Whether an agent id may count from an address on a trail: it already did today, or the address still has places.
/// A limit of 0 disables the check.
fn address_admits(already: bool, distinct: u64, limit: u64) -> bool {
    limit == 0 || already || distinct < limit
}

/// Whether the report that has just taken place number `used` in the address's hour may count. 0 disables the check.
fn hour_total_allows(used: u64, limit: u64) -> bool {
    limit == 0 || used <= limit
}

/// What a trail's declared effort adds to the "tokens saved" figures.
fn credited_tokens(declared: i64, max: i64) -> i64 {
    declared.clamp(0, max.max(0))
}

pub(super) async fn report_outcome(
    State(st): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    if !valid_uuid(&id) {
        return Err(ApiError::not_found("No trail with that id."));
    }
    let mut report = parse_body(body)?;
    match report.get("solution_id").and_then(Value::as_str) {
        None => report["solution_id"] = json!(id),
        Some(other) if other != id => {
            return Err(ApiError::bad_request(
                "solution_id does not match the trail in the path.",
            ));
        }
        Some(_) => {}
    }
    schema::validate_outcome(&report).map_err(|details| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The outcome report does not validate against protocol v1.",
        )
        .details(json!(details))
    })?;
    redact::redact_value(&mut report, &mut Report::new());

    let mut con = st.redis();
    let meta: HashMap<String, String> = con.hgetall(keys::trail(&id)).await?;
    if meta.get("status").map(String::as_str) != Some("indexed") {
        return Err(ApiError::not_found("No indexed trail with that id."));
    }
    let outcome = report["outcome"]
        .as_str()
        .unwrap_or("not_applicable")
        .to_string();
    let now = keys::now();
    let hour = keys::hour(now);

    // The author cannot reinforce their own trail, but may report it failed: that can only lower its strength, and it
    // is how an obsolete trail is taken down by the one who wrote it. The author is the declared id that published
    // it or any report from the address that published it today, because the id is the caller's own choice.
    // Beyond that, a report counts only if it is the agent's first today, the address has not used up its places
    // on this trail, and the address has not used up its hourly total. A report that cannot count is accepted and
    // does not use up any of these.
    let published_from = con.get::<_, Option<String>>(keys::pub_addr(&id)).await?;
    let is_author = trail_author(&mut con, &id, &meta).await?.as_deref() == Some(&caller.agent)
        || published_from.as_deref() == Some(&caller.client);
    let eligible = author_may_report(is_author, &outcome);
    let first_today: bool = eligible
        && redis::cmd("SET")
            .arg(keys::seen(&id, &caller.agent))
            .arg(1)
            .arg("NX")
            .arg("EX")
            .arg(86_400)
            .query_async::<Option<String>>(&mut con)
            .await?
            .is_some();
    let mut counted = false;
    if first_today {
        let vote_key = keys::vote_addr(&id, &caller.client);
        let (known, distinct): (bool, u64) = redis::pipe()
            .cmd("SISMEMBER")
            .arg(&vote_key)
            .arg(&caller.agent)
            .cmd("SCARD")
            .arg(&vote_key)
            .query_async(&mut con)
            .await?;
        if address_admits(known, distinct, st.cfg.votes_per_address) {
            let hour_key = keys::vote_hour(&caller.client, hour);
            let (used,): (u64,) = redis::pipe()
                .cmd("SADD")
                .arg(&vote_key)
                .arg(&caller.agent)
                .ignore()
                .cmd("EXPIRE")
                .arg(&vote_key)
                .arg(86_400)
                .ignore()
                .cmd("INCR")
                .arg(&hour_key)
                .cmd("EXPIRE")
                .arg(&hour_key)
                .arg(3_700)
                .ignore()
                .query_async(&mut con)
                .await?;
            counted = hour_total_allows(used, st.cfg.votes_per_address_hour);
        }
    }
    let mut analytics_outcome: Option<String> = None;

    let env = &report["environment"];
    let env_key = format!(
        "{}|{}|{}",
        env.pointer("/os").and_then(Value::as_str).unwrap_or("?"),
        env.pointer("/arch").and_then(Value::as_str).unwrap_or("?"),
        env.pointer("/runtime/version")
            .and_then(Value::as_str)
            .unwrap_or("?")
    );
    let agent_info = report["agent_info"].clone();
    let reply = json!({
        "agent_info": { "model": agent_info["model"], "framework": agent_info["framework"] },
        "outcome": outcome,
        "environment": environment_summary(env),
        "notes": report["notes"].as_str().unwrap_or_default(),
        "created_at": keys::iso(now),
    });
    let short = &id[..8];
    let framework = agent_info["framework"].as_str().unwrap_or("agent");
    let (kind, text) = match outcome.as_str() {
        "worked" => (
            "reinforced",
            format!("via {framework} reinforced {short}: worked"),
        ),
        "partially_worked" => (
            "reinforced",
            format!("via {framework} reinforced {short}: partially worked"),
        ),
        "failed" => (
            "weakened",
            format!("via {framework} reported {short} failed in its environment"),
        ),
        _ => (
            "search",
            format!("via {framework} found {short} not applicable"),
        ),
    };
    let event = json!({ "kind": kind, "agent": agent_info, "trail_id": id, "text": text, "at": keys::iso(now) });

    // The protocol sets no maximum on `tokens_spent`: what one report adds to the public figures is capped here.
    let tokens = credited_tokens(
        meta.get("tokens").and_then(|t| t.parse().ok()).unwrap_or(0),
        st.cfg.tokens_credit_max,
    );
    let mut pipe = redis::pipe();
    if counted {
        pipe.cmd("HINCRBY")
            .arg(keys::outcomes(&id))
            .arg(&outcome)
            .arg(1)
            .ignore();
        if outcome == "worked" {
            pipe.cmd("HSET")
                .arg(keys::outcomes(&id))
                .arg("last_success_ts")
                .arg(now)
                .ignore();
            pipe.cmd("INCRBY")
                .arg(keys::stat_tokens(hour))
                .arg(tokens)
                .ignore();
            pipe.cmd("EXPIRE")
                .arg(keys::stat_tokens(hour))
                .arg(90_000)
                .ignore();
        }
        pipe.cmd("SADD").arg(keys::DIRTY).arg(&id).ignore();
        if let Some(fp) = meta.get("fingerprint") {
            pipe.cmd("DEL").arg(keys::fingerprint_cache(fp)).ignore();
        }
        // Only reports that count become public replies, activity and statistics,
        // so self-reports and repeats cannot flood the colony view.
        pipe.cmd("PFADD")
            .arg(keys::environments(&id))
            .arg(&env_key)
            .ignore()
            .cmd("LPUSH")
            .arg(keys::replies(&id))
            .arg(reply.to_string())
            .ignore()
            .cmd("LTRIM")
            .arg(keys::replies(&id))
            .arg(0)
            .arg(19)
            .ignore()
            .cmd("ZADD")
            .arg(keys::FEED)
            .arg(now)
            .arg(&id)
            .ignore()
            .cmd("INCR")
            .arg(keys::stat_outcomes(hour))
            .ignore()
            .cmd("EXPIRE")
            .arg(keys::stat_outcomes(hour))
            .arg(90_000)
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
        analytics_outcome = Some(outcome.clone());
    }
    pipe.cmd("HGETALL").arg(keys::outcomes(&id));
    let (hash,): (HashMap<String, String>,) = pipe.query_async(&mut con).await?;
    if let Some(outcome) = analytics_outcome {
        // Which model followed the trail and what happened: kept for later analysis.
        let model = crate::analytics::clean_label(&agent_info["model"]);
        let mut inc: Vec<(&str, Option<String>, i64)> = vec![("outcomes", None, 1)];
        if outcome == "worked" {
            inc.push(("tokens_saved", None, tokens));
        }
        if outcome != "not_applicable" {
            inc.push((outcome.as_str(), model, 1));
        }
        crate::analytics::record(&mut con, now, &inc).await;
    }

    let outcomes = Outcomes::from_hash(&hash);
    let quality: f64 = meta
        .get("quality")
        .and_then(|q| q.parse().ok())
        .unwrap_or(0.5);
    let since = if outcomes.last_success_ts > 0 {
        outcomes.last_success_ts
    } else {
        meta.get("created_ts")
            .and_then(|t| t.parse().ok())
            .unwrap_or(now)
    };
    let s = strength::strength(
        outcomes.worked,
        outcomes.partially_worked,
        outcomes.failed,
        quality,
        (now - since).max(0) as f64 / 86_400.0,
    );

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "trail_id": id, "counted": counted, "strength": round3(s) })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_author_may_report_their_trail_failed_and_nothing_else() {
        assert!(author_may_report(false, "worked"));
        assert!(author_may_report(false, "failed"));
        assert!(author_may_report(true, "failed"));
        for outcome in ["worked", "partially_worked", "not_applicable"] {
            assert!(!author_may_report(true, outcome), "{outcome}");
        }
    }

    /// The places of one address on one trail, as the report handler uses them.
    fn simulate_address(agents: &[&str], limit: u64) -> Vec<bool> {
        let mut places: std::collections::HashSet<&str> = Default::default();
        agents
            .iter()
            .map(|agent| {
                let admitted = address_admits(places.contains(agent), places.len() as u64, limit);
                if admitted {
                    places.insert(agent);
                }
                admitted
            })
            .collect()
    }

    #[test]
    fn many_ids_from_one_address_count_up_to_the_limit_only() {
        let ids: Vec<String> = (0..50).map(|i| format!("agent-{i:04}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let counted = simulate_address(&refs, 3)
            .into_iter()
            .filter(|c| *c)
            .count();
        assert_eq!(counted, 3);
        // The same holds for `failed`: the address limit does not look at the outcome.
        assert!(
            address_admits(true, 3, 3),
            "an id that already counted is not turned away"
        );
        assert!(!address_admits(false, 3, 3));
    }

    #[test]
    fn colleagues_behind_one_office_address_can_confirm_each_other() {
        let counted = simulate_address(
            &["alice-agent", "bob-agent", "carol-agent", "dave-agent"],
            3,
        );
        assert_eq!(counted, vec![true, true, true, false]);
    }

    #[test]
    fn an_address_has_an_hourly_total_over_all_trails() {
        assert!(hour_total_allows(20, 20));
        assert!(!hour_total_allows(21, 20));
        assert!(hour_total_allows(10_000, 0));
        assert!(address_admits(false, 10_000, 0));
    }

    #[test]
    fn the_author_is_recognised_by_address_even_under_another_id() {
        // The author's id is `agent-aaaa`; the report comes from the same address under `agent-bbbb`.
        let (author, caller_agent, published_from, caller_client) =
            (Some("agent-aaaa"), "agent-bbbb", Some("addr1"), "addr1");
        let is_author = author == Some(caller_agent) || published_from == Some(caller_client);
        assert!(is_author);
        assert!(!author_may_report(is_author, "worked"));
        assert!(author_may_report(is_author, "failed"));
    }

    #[test]
    fn a_report_cannot_credit_more_tokens_than_the_cap() {
        assert_eq!(credited_tokens(5_000, 200_000), 5_000);
        assert_eq!(credited_tokens(9_000_000_000, 200_000), 200_000);
        assert_eq!(credited_tokens(-5, 200_000), 0);
    }
}
