//! What a private colony's team does with it: the numbers that say whether it is worth keeping.
//!
//! Only on a colony that requires access keys (MYRMO_REQUIRE_KEY=1), where a caller is a person. It keeps counts per day
//! (searches, trails published, outcome reports) and one record each time a person reports on a trail another person
//! published: reuse between people, the point of a shared colony. Never the text of a search.
//!
//! By default (`MYRMO_PEOPLE_DETAIL=aggregate`) the counts are the team's, under the field prefix `*`, and a reuse record
//! names nobody: data protection law asks for the least personal data that does the job, and "is the colony used, and
//! do people reuse each other's work?" needs no names. `named` counts per person and keeps those counts for 90 days;
//! an organisation turns it on only after telling its people (docs/security/employees.md). Either way `erase` removes
//! everything kept about one person.
//!
//!   myrmo-server team-report [days]   (default 7)

use anyhow::Result;
use redis::aio::ConnectionLike;
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::config::PeopleDetail;

const REUSE: &str = "team:reuse";
const REUSE_KEEP: isize = 9_999;
/// How long the team's own counts are kept: they name nobody.
const DAY_TTL: i64 = 400 * 86_400;
/// How long counts and reuse records that name a person are kept.
pub const PERSON_DAYS: i64 = 90;
/// The field prefix of the team's counts when people are not named. Not a valid handle, so it never meets a person's.
pub const TEAM: &str = "*";

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

/// Whose count a request adds to: the person's handle, or the team's when people are not named.
fn counted_as(detail: PeopleDetail, agent: &str) -> &str {
    match detail {
        PeopleDetail::Named => handle(agent),
        PeopleDetail::Aggregate => TEAM,
    }
}

fn ttl(detail: PeopleDetail) -> i64 {
    match detail {
        PeopleDetail::Named => PERSON_DAYS * 86_400,
        PeopleDetail::Aggregate => DAY_TTL,
    }
}

/// Adds the count of one request to a pipeline.
pub fn count(pipe: &mut redis::Pipeline, detail: PeopleDetail, agent: &str, kind: &str, now: i64) {
    let key = day_key(now);
    pipe.cmd("HINCRBY")
        .arg(&key)
        .arg(format!("{}|{kind}", counted_as(detail, agent)))
        .arg(1)
        .ignore()
        .cmd("EXPIRE")
        .arg(&key)
        .arg(ttl(detail))
        .ignore();
}

/// One person reported on a trail another person published, and the report counted.
#[allow(clippy::too_many_arguments)]
pub async fn record_reuse<C: ConnectionLike + Send>(
    con: &mut C,
    detail: PeopleDetail,
    now: i64,
    trail: &str,
    author: &str,
    reporter: &str,
    outcome: &str,
) -> Result<()> {
    let key = day_key(now);
    let mut pipe = redis::pipe();
    match detail {
        PeopleDetail::Named => {
            let entry = json!({ "ts": now, "trail": trail, "author": handle(author), "reporter": handle(reporter), "outcome": outcome });
            pipe.cmd("LPUSH").arg(REUSE).arg(entry.to_string()).ignore();
            pipe.cmd("HINCRBY")
                .arg(&key)
                .arg(format!("{}|used_{outcome}", handle(reporter)))
                .arg(1)
                .ignore()
                .cmd("HINCRBY")
                .arg(&key)
                .arg(format!("{}|helped_{outcome}", handle(author)))
                .arg(1)
                .ignore();
        }
        PeopleDetail::Aggregate => {
            let entry = json!({ "ts": now, "trail": trail, "author": null, "reporter": null, "outcome": outcome });
            pipe.cmd("LPUSH").arg(REUSE).arg(entry.to_string()).ignore();
            pipe.cmd("HINCRBY")
                .arg(&key)
                .arg(format!("{TEAM}|reuse_{outcome}"))
                .arg(1)
                .ignore();
        }
    }
    pipe.cmd("LTRIM")
        .arg(REUSE)
        .arg(0)
        .arg(REUSE_KEEP)
        .ignore()
        .cmd("EXPIRE")
        .arg(&key)
        .arg(ttl(detail))
        .ignore()
        .query_async::<()>(con)
        .await?;
    prune_reuse(con, now).await
}

/// Drops reuse records that name a person once they are older than `PERSON_DAYS` (the list is newest first).
async fn prune_reuse<C: ConnectionLike + Send>(con: &mut C, now: i64) -> Result<()> {
    for _ in 0..50 {
        let last: Option<String> = redis::cmd("LINDEX")
            .arg(REUSE)
            .arg(-1)
            .query_async(con)
            .await?;
        let Some(entry) = last.and_then(|e| serde_json::from_str::<Value>(&e).ok()) else {
            break;
        };
        let named = entry["author"].is_string() || entry["reporter"].is_string();
        if !(named && entry["ts"].as_i64().unwrap_or(0) < now - PERSON_DAYS * 86_400) {
            break;
        }
        redis::cmd("RPOP").arg(REUSE).query_async::<()>(con).await?;
    }
    Ok(())
}

/// Everything the colony keeps about one person's activity, removed: their counts on every day still kept, when their
/// key was last used, their client versions, and their name in reuse records. What they published stays, as knowledge
/// of the organisation, but no longer says who wrote it (`erased_author` replaces the author). Returns how many items
/// were removed or rewritten.
pub async fn erase<C: ConnectionLike + Send>(con: &mut C, person: &str, now: i64) -> Result<u64> {
    let mut removed = 0u64;
    let prefix = format!("{person}|");
    for d in 0..(DAY_TTL / 86_400) {
        let key = day_key(now - d * 86_400);
        let fields: Vec<String> = redis::cmd("HKEYS").arg(&key).query_async(con).await?;
        let mine: Vec<&String> = fields.iter().filter(|f| f.starts_with(&prefix)).collect();
        if !mine.is_empty() {
            removed += redis::cmd("HDEL")
                .arg(&key)
                .arg(mine)
                .query_async::<u64>(con)
                .await?;
        }
    }
    removed += redis::cmd("HDEL")
        .arg(LAST_SEEN)
        .arg(person)
        .query_async::<u64>(con)
        .await?;
    let fields: Vec<String> = redis::cmd("HKEYS").arg(CLIENTS).query_async(con).await?;
    let mine: Vec<&String> = fields.iter().filter(|f| f.starts_with(&prefix)).collect();
    if !mine.is_empty() {
        removed += redis::cmd("HDEL")
            .arg(CLIENTS)
            .arg(mine)
            .query_async::<u64>(con)
            .await?;
    }
    let entries: Vec<String> = redis::cmd("LRANGE")
        .arg(REUSE)
        .arg(0)
        .arg(REUSE_KEEP)
        .query_async(con)
        .await?;
    let mut changed = false;
    let rewritten: Vec<String> = entries
        .into_iter()
        .map(|e| match serde_json::from_str::<Value>(&e) {
            Ok(mut v) if v["author"] == person || v["reporter"] == person => {
                for k in ["author", "reporter"] {
                    if v[k] == person {
                        v[k] = Value::Null;
                    }
                }
                changed = true;
                removed += 1;
                v.to_string()
            }
            _ => e,
        })
        .collect();
    if changed {
        let mut pipe = redis::pipe();
        pipe.cmd("DEL").arg(REUSE).ignore();
        if !rewritten.is_empty() {
            pipe.cmd("RPUSH").arg(REUSE).arg(rewritten).ignore();
        }
        pipe.query_async::<()>(con).await?;
    }
    // Their trails: there is no index by author, and a private colony holds thousands of trails at most.
    let agent = crate::access::agent_of(person);
    let mut cursor = 0u64;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("trail:*")
            .arg("COUNT")
            .arg(500)
            .query_async(con)
            .await?;
        for key in keys {
            let author: Option<String> = redis::cmd("HGET")
                .arg(&key)
                .arg("author")
                .query_async(con)
                .await?;
            if author.as_deref() == Some(agent.as_str()) {
                redis::cmd("HSET")
                    .arg(&key)
                    .arg("author")
                    .arg(erased_author(person))
                    .query_async::<()>(con)
                    .await?;
                removed += 1;
            }
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }
    Ok(removed)
}

/// What replaces the author of a person's trails once their data is erased: still not anyone else, so nobody can
/// reinforce those trails as their author, and no longer their name.
pub fn erased_author(person: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "erased:{}",
        &hex::encode(Sha256::digest(person.as_bytes()))[..12]
    )
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

const CLIENTS: &str = "team:clients";

/// The version of a client a person's agent last declared (`myrmo-mcp/0.23.0`), one per kind of client, so the operator
/// sees who runs an old one.
pub fn client(pipe: &mut redis::Pipeline, agent: &str, label: &str) {
    let (name, version) = label.split_once('/').unwrap_or((label, ""));
    pipe.cmd("HSET")
        .arg(CLIENTS)
        .arg(format!("{}|{name}", handle(agent)))
        .arg(version)
        .ignore();
}

/// For each person, the version of each kind of client their agents last declared.
pub async fn clients<C: ConnectionLike + Send>(
    con: &mut C,
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let all: Vec<(String, String)> = redis::cmd("HGETALL").arg(CLIENTS).query_async(con).await?;
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (field, version) in all {
        if let Some((person, name)) = field.split_once('|') {
            out.entry(person.to_string())
                .or_default()
                .insert(name.to_string(), version);
        }
    }
    Ok(out)
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
    if people.keys().all(|p| p == TEAM) {
        println!(
            "Last {days} days, the team as a whole (MYRMO_PEOPLE_DETAIL=aggregate: nobody is counted by name)"
        );
    } else {
        println!("Last {days} days, per person");
    }
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
        let person = if person == TEAM {
            "(team)"
        } else {
            person.as_str()
        };
        let used = used
            + get("reuse_worked")
            + get("reuse_partially_worked")
            + get("reuse_failed")
            + get("reuse_not_applicable");
        println!(
            "{person:<20} {:>8} {:>9} {:>8} {:>22} {:>22}",
            get("searches"),
            get("published"),
            get("reports"),
            format!("{used} ({})", get("used_worked") + get("reuse_worked")),
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
            e["author"].as_str().unwrap_or("a colleague"),
            e["reporter"].as_str().unwrap_or("a colleague"),
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
    fn a_request_counts_for_the_team_unless_people_are_named() {
        assert_eq!(counted_as(PeopleDetail::Aggregate, "person:ana"), TEAM);
        assert_eq!(counted_as(PeopleDetail::Named, "person:ana"), "ana");
        assert!(!crate::access::valid_person(TEAM));
        assert_eq!(ttl(PeopleDetail::Named), 90 * 86_400);
    }

    #[test]
    fn an_erased_author_is_nobody_and_stays_the_same() {
        let a = erased_author("ana");
        assert!(a.starts_with("erased:") && !a.contains("ana"));
        assert_eq!(a, erased_author("ana"));
        assert_ne!(a, erased_author("luis"));
    }

    #[test]
    fn people_are_shown_by_handle() {
        assert_eq!(handle("person:ana"), "ana");
        assert_eq!(handle("someone-else"), "someone-else");
    }
}
