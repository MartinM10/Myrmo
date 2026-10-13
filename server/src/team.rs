//! What a private colony's team does with it, per person: the numbers that say whether it is worth keeping.
//!
//! Only on a colony that requires access keys (MYRMO_REQUIRE_KEY=1), where a caller is a person. It keeps counts per
//! person and day (searches, trails published, outcome reports) and one record each time a person reports on a trail
//! another person published: reuse between people, the point of a shared colony. Never the text of a search.
//!
//!   myrmo-server team-report [days]   (default 7)

use anyhow::Result;
use redis::aio::ConnectionLike;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const REUSE: &str = "team:reuse";
const REUSE_KEEP: isize = 9_999;
const DAY_TTL: i64 = 400 * 86_400;

fn day(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .format("%Y%m%d")
        .to_string()
}

fn day_key(ts: i64) -> String {
    format!("team:{}", day(ts))
}

/// What a request is, for the per-person counts. Reads of the colony view and status checks are not counted.
pub fn activity(method: &str, path: &str) -> Option<&'static str> {
    match (method, path) {
        ("POST", "/v1/search") => Some("searches"),
        ("GET", p) if p.starts_with("/v1/trails/by-fingerprint/") => Some("searches"),
        ("POST", "/v1/trails") => Some("published"),
        ("POST", p) if p.starts_with("/v1/trails/") && p.ends_with("/outcomes") => Some("reports"),
        _ => None,
    }
}

/// The handle of a person's agent id (`person:ana` -> `ana`).
pub fn handle(agent: &str) -> &str {
    agent.strip_prefix("person:").unwrap_or(agent)
}

/// Adds the per-person count of one request to a pipeline.
pub fn count(pipe: &mut redis::Pipeline, agent: &str, kind: &str, now: i64) {
    let key = day_key(now);
    pipe.cmd("HINCRBY")
        .arg(&key)
        .arg(format!("{}|{kind}", handle(agent)))
        .arg(1)
        .ignore()
        .cmd("EXPIRE")
        .arg(&key)
        .arg(DAY_TTL)
        .ignore();
}

/// One person reported on a trail another person published, and the report counted.
pub async fn record_reuse<C: ConnectionLike + Send>(
    con: &mut C,
    now: i64,
    trail: &str,
    author: &str,
    reporter: &str,
    outcome: &str,
) -> Result<()> {
    let key = day_key(now);
    let entry = json!({ "ts": now, "trail": trail, "author": handle(author), "reporter": handle(reporter), "outcome": outcome });
    redis::pipe()
        .cmd("LPUSH")
        .arg(REUSE)
        .arg(entry.to_string())
        .ignore()
        .cmd("LTRIM")
        .arg(REUSE)
        .arg(0)
        .arg(REUSE_KEEP)
        .ignore()
        .cmd("HINCRBY")
        .arg(&key)
        .arg(format!("{}|used_{outcome}", handle(reporter)))
        .arg(1)
        .ignore()
        .cmd("HINCRBY")
        .arg(&key)
        .arg(format!("{}|helped_{outcome}", handle(author)))
        .arg(1)
        .ignore()
        .cmd("EXPIRE")
        .arg(&key)
        .arg(DAY_TTL)
        .ignore()
        .query_async::<()>(con)
        .await?;
    Ok(())
}

/// Per person: each count summed over the days.
pub fn tally(days: &[Vec<(String, i64)>]) -> BTreeMap<String, BTreeMap<String, i64>> {
    let mut people: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for fields in days {
        for (field, n) in fields {
            if let Some((person, kind)) = field.split_once('|') {
                *people
                    .entry(person.to_string())
                    .or_default()
                    .entry(kind.to_string())
                    .or_default() += n;
            }
        }
    }
    people
}

const LAST_SEEN: &str = "team:last";

/// Note that a person's key was used just now, by any authenticated request (a `doctor` run counts: it proves the
/// machine reaches the colony). Only the time is kept.
pub fn seen(pipe: &mut redis::Pipeline, agent: &str, now: i64) {
    pipe.cmd("HSET")
        .arg(LAST_SEEN)
        .arg(handle(agent))
        .arg(now)
        .ignore();
}

/// When each person's key was last used.
pub async fn last_seen<C: ConnectionLike + Send>(con: &mut C) -> Result<BTreeMap<String, i64>> {
    let all: Vec<(String, i64)> = redis::cmd("HGETALL")
        .arg(LAST_SEEN)
        .query_async(con)
        .await?;
    Ok(all.into_iter().collect())
}

/// The last `days` days, oldest first: for each, the date and what each person did that day.
pub async fn daily<C: ConnectionLike + Send>(
    con: &mut C,
    days: i64,
    now: i64,
) -> Result<Vec<(String, BTreeMap<String, BTreeMap<String, i64>>)>> {
    let mut out = Vec::new();
    for d in (0..days.clamp(1, 90)).rev() {
        let ts = now - d * 86_400;
        let fields: Vec<(String, i64)> = redis::cmd("HGETALL")
            .arg(day_key(ts))
            .query_async(con)
            .await?;
        out.push((day(ts), tally(&[fields])));
    }
    Ok(out)
}

/// What the panel shows: per person, the counts of the last `days` days, and the reuse records of the period (newest
/// first, up to `limit`), each with the label of the trail it was about.
pub async fn summary<C: ConnectionLike + Send>(
    con: &mut C,
    days: i64,
    now: i64,
    limit: usize,
) -> Result<(BTreeMap<String, BTreeMap<String, i64>>, Vec<Value>)> {
    let mut per_day = Vec::new();
    for d in 0..days.clamp(1, 365) {
        let fields: Vec<(String, i64)> = redis::cmd("HGETALL")
            .arg(day_key(now - d * 86_400))
            .query_async(con)
            .await?;
        per_day.push(fields);
    }
    let since = now - days.clamp(1, 365) * 86_400;
    let entries: Vec<String> = redis::cmd("LRANGE")
        .arg(REUSE)
        .arg(0)
        .arg(REUSE_KEEP)
        .query_async(con)
        .await?;
    let mut reuse = Vec::new();
    for entry in entries
        .iter()
        .filter_map(|e| serde_json::from_str::<Value>(e).ok())
        .filter(|e| e["ts"].as_i64().unwrap_or(0) >= since)
        .take(limit)
    {
        let trail = entry["trail"].as_str().unwrap_or_default();
        let label: Option<String> = redis::cmd("HGET")
            .arg(crate::keys::trail(trail))
            .arg("label")
            .query_async(con)
            .await
            .unwrap_or(None);
        reuse.push(json!({
            "ts": entry["ts"], "author": entry["author"], "reporter": entry["reporter"],
            "outcome": entry["outcome"], "trail": trail, "label": label,
        }));
    }
    Ok((tally(&per_day), reuse))
}

/// `myrmo-server team-report [days]`: needs only Valkey.
pub async fn cli(redis_url: &str, args: &[String]) -> Result<()> {
    let days: i64 = args
        .first()
        .map(|d| d.parse())
        .transpose()?
        .unwrap_or(7)
        .clamp(1, 365);
    let client = redis::Client::open(redis_url)?;
    let mut con = client.get_multiplexed_async_connection().await?;
    let now = chrono::Utc::now().timestamp();
    let mut per_day = Vec::new();
    for d in 0..days {
        let fields: Vec<(String, i64)> = redis::cmd("HGETALL")
            .arg(day_key(now - d * 86_400))
            .query_async(&mut con)
            .await?;
        per_day.push(fields);
    }
    let people = tally(&per_day);
    println!("Last {days} days, per person");
    println!(
        "{:<20} {:>8} {:>9} {:>8} {:>22} {:>22}",
        "person",
        "searches",
        "published",
        "reports",
        "used others' (worked)",
        "helped others (worked)"
    );
    for (person, n) in &people {
        let get = |k: &str| n.get(k).copied().unwrap_or(0);
        let used = get("used_worked")
            + get("used_partially_worked")
            + get("used_failed")
            + get("used_not_applicable");
        let helped = get("helped_worked")
            + get("helped_partially_worked")
            + get("helped_failed")
            + get("helped_not_applicable");
        println!(
            "{person:<20} {:>8} {:>9} {:>8} {:>22} {:>22}",
            get("searches"),
            get("published"),
            get("reports"),
            format!("{used} ({})", get("used_worked")),
            format!("{helped} ({})", get("helped_worked"))
        );
    }

    let since = now - days * 86_400;
    let entries: Vec<String> = redis::cmd("LRANGE")
        .arg(REUSE)
        .arg(0)
        .arg(REUSE_KEEP)
        .query_async(&mut con)
        .await?;
    let recent: Vec<Value> = entries
        .iter()
        .filter_map(|e| serde_json::from_str::<Value>(e).ok())
        .filter(|e| e["ts"].as_i64().unwrap_or(0) >= since)
        .collect();
    println!(
        "\nReuse between people: {} report(s) on a colleague's trail",
        recent.len()
    );
    for e in recent.iter().take(50) {
        let trail = e["trail"].as_str().unwrap_or_default();
        let label: Option<String> = redis::cmd("HGET")
            .arg(crate::keys::trail(trail))
            .arg("label")
            .query_async(&mut con)
            .await
            .unwrap_or(None);
        let when = chrono::DateTime::from_timestamp(e["ts"].as_i64().unwrap_or(0), 0)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        println!(
            "  {when}  {} -> {}  {}  {}",
            e["author"].as_str().unwrap_or("?"),
            e["reporter"].as_str().unwrap_or("?"),
            e["outcome"].as_str().unwrap_or("?"),
            label.unwrap_or_else(|| trail.to_string())
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_counted_by_what_they_do() {
        assert_eq!(activity("POST", "/v1/search"), Some("searches"));
        assert_eq!(
            activity("GET", "/v1/trails/by-fingerprint/fp2_0123456789abcdef"),
            Some("searches")
        );
        assert_eq!(activity("POST", "/v1/trails"), Some("published"));
        assert_eq!(
            activity(
                "POST",
                "/v1/trails/3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b/outcomes"
            ),
            Some("reports")
        );
        assert_eq!(
            activity("GET", "/v1/trails/3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b"),
            None
        );
        assert_eq!(activity("GET", "/v1/feed"), None);
        assert_eq!(activity("POST", "/v1/validate"), None);
    }

    #[test]
    fn counts_add_up_per_person_over_days() {
        let days = vec![
            vec![("ana|searches".into(), 3), ("luis|used_worked".into(), 1)],
            vec![
                ("ana|searches".into(), 2),
                ("ana|helped_worked".into(), 1),
                ("broken".into(), 9),
            ],
        ];
        let t = tally(&days);
        assert_eq!(t["ana"]["searches"], 5);
        assert_eq!(t["ana"]["helped_worked"], 1);
        assert_eq!(t["luis"]["used_worked"], 1);
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn people_are_shown_by_handle() {
        assert_eq!(handle("person:ana"), "ana");
        assert_eq!(handle("someone-else"), "someone-else");
    }
}
