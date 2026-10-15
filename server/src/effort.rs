//! Measured effort: what solving an error cost an agent, with and without the colony's help, so an organisation can see
//! what its colony saves in tokens, time and money, and how it was worked out.
//!
//! A client that can read its own usage (the Claude Code plugin reads it from the session's transcript) sends one record
//! when a problem is solved: `unaided` when no trail was used, `aided` when a trail was followed and worked. The record
//! carries the error line, so that both sides of a comparison are grouped by the same fingerprint, and the colony keeps
//! only sums: per fingerprint, per trail and per day, by role and model. Never the error line, never who sent it.
//!
//! Three baselines, from cheapest to most rigorous:
//! - before and after: unaided records of an error against aided ones of the same error (what the colony saw before
//!   its trail existed, or from people whose lookup found nothing);
//! - hold-out: an organisation may answer a small share of error lookups with nothing (`MYRMO_HOLDOUT_PERCENT`), and
//!   the unaided records of those lookups are a randomised control group;
//! - MyrmoBench on the organisation's own tasks, outside the colony.
//!
//! Only an organisation's own colony accepts these records.

use crate::fingerprint;
use redis::aio::ConnectionLike;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

const METRICS: [&str; 6] = [
    "input",
    "output",
    "cache_read",
    "cache_write",
    "turns",
    "seconds",
];
const KEEP: i64 = 400 * 86_400;
const FPS: &str = "effort:fps";

fn fp_key(fp: &str) -> String {
    format!("effort:fp:{fp}")
}
fn trail_key(id: &str) -> String {
    format!("effort:trail:{id}")
}
fn day_key(ts: i64) -> String {
    let day = chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .format("%Y%m%d");
    format!("effort:day:{day}")
}
/// A lookup this person was answered with nothing for, on purpose, today and tomorrow.
pub fn holdout_key(agent: &str, fp: &str) -> String {
    format!("holdout:{agent}:{fp}")
}
fn people_key(role: &str) -> String {
    format!("effort:people:{role}")
}

/// How many different people sent records of each role, approximately.
pub async fn contributors<C: ConnectionLike + Send>(con: &mut C) -> anyhow::Result<Value> {
    let mut out = serde_json::Map::new();
    for role in ["unaided", "holdout", "aided"] {
        let n: u64 = redis::cmd("PFCOUNT")
            .arg(people_key(role))
            .query_async(con)
            .await?;
        out.insert(role.to_string(), json!(n));
    }
    Ok(Value::Object(out))
}

/// The person reported in the last two days that this trail worked for them (set by the outcome report).
pub fn helped_key(trail: &str, agent: &str) -> String {
    format!("effort:helped:{trail}:{agent}")
}
fn quota_key(agent: &str, day: i64) -> String {
    format!("effort:quota:{agent}:{day}")
}
/// Records one person may send in a day: a team's real problems fit many times over, and a person cannot swamp the
/// sums by themselves.
pub const DAILY_QUOTA: u64 = 60;

fn once_key(agent: &str, fp: &str, role: &str) -> String {
    format!("effort:once:{agent}:{fp}:{role}")
}

/// What one solved problem cost.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cost {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub turns: u64,
    pub seconds: u64,
}

impl Cost {
    fn get(&self, metric: &str) -> u64 {
        match metric {
            "input" => self.input,
            "output" => self.output,
            "cache_read" => self.cache_read,
            "cache_write" => self.cache_write,
            "turns" => self.turns,
            _ => self.seconds,
        }
    }
    pub fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// A record as a client sends it, checked.
#[derive(Debug, PartialEq)]
pub struct Record {
    pub role: &'static str,
    pub error: String,
    pub trail_id: Option<String>,
    pub cost: Cost,
    pub model: String,
}

fn uuid_like(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Checks a `POST /v1/effort` body. Limits keep one record from swamping the sums: a day of work, ten million tokens of
/// each kind (a long session re-reads its cache many times), ten thousand turns.
pub fn parse(body: &Value) -> Result<Record, String> {
    let role = match body["role"].as_str() {
        Some("unaided") => "unaided",
        Some("aided") => "aided",
        _ => return Err("role is \"unaided\" or \"aided\".".into()),
    };
    let error = body["error"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !(8..=2000).contains(&error.chars().count()) {
        return Err(
            "error is the error line the problem started with, 8 to 2000 characters.".into(),
        );
    }
    let trail_id = match body["trail_id"].as_str() {
        Some(id) if uuid_like(id) => Some(id.to_ascii_lowercase()),
        Some(_) => return Err("trail_id is a trail's id.".into()),
        None if role == "aided" => {
            return Err("an aided record names the trail it followed (trail_id).".into());
        }
        None => None,
    };
    let e = &body["effort"];
    let n = |k: &str, max: u64| -> Result<u64, String> {
        match &e[k] {
            Value::Null => Ok(0),
            v => v
                .as_u64()
                .filter(|n| *n <= max)
                .ok_or_else(|| format!("effort.{k} is a whole number from 0 to {max}.")),
        }
    };
    const TOKENS: u64 = 10_000_000;
    let cost = Cost {
        input: n("input_tokens", TOKENS)?,
        output: n("output_tokens", TOKENS)?,
        cache_read: n("cache_read_tokens", TOKENS)?,
        cache_write: n("cache_write_tokens", TOKENS)?,
        turns: n("turns", 10_000)?,
        seconds: n("wall_time_seconds", 86_400)?,
    };
    if cost.tokens() == 0 && cost.seconds == 0 {
        return Err("effort holds the tokens and time the problem took.".into());
    }
    let model = crate::analytics::clean_label(&body["agent_info"]["model"])
        .unwrap_or_else(|| "unknown".into());
    Ok(Record {
        role,
        error,
        trail_id,
        cost,
        model,
    })
}

/// The fingerprint both sides of a comparison are grouped by.
pub fn fingerprint_of(error: &str) -> String {
    fingerprint::fingerprint2(error)
}

/// Whether this person's lookup of this error falls in the hold-out today: the same answer all day, so asking again
/// does not change it, and about `percent` of lookups over many people and errors.
/// The colony's secret salt is part of the draw, so nobody can work out from the source which of their lookups will be
/// held out and step around it.
pub fn held_out(salt: &str, agent: &str, fp: &str, day: i64, percent: u64) -> bool {
    if percent == 0 {
        return false;
    }
    let digest = Sha256::digest(format!("holdout|{salt}|{agent}|{fp}|{day}").as_bytes());
    let n = u64::from_be_bytes(digest[..8].try_into().unwrap_or([0; 8]));
    n % 100 < percent
}

fn add(pipe: &mut redis::Pipeline, key: &str, role: &str, model: &str, cost: &Cost) {
    pipe.cmd("HINCRBY")
        .arg(key)
        .arg(format!("{role}|{model}|n"))
        .arg(1)
        .ignore();
    for m in METRICS {
        let v = cost.get(m);
        if v > 0 {
            pipe.cmd("HINCRBY")
                .arg(key)
                .arg(format!("{role}|{model}|{m}"))
                .arg(v)
                .ignore();
        }
    }
    pipe.cmd("EXPIRE").arg(key).arg(KEEP).ignore();
}

/// Why a record is refused before it is stored.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// An aided record for a trail the person did not report as working.
    NotHelped,
    /// More records today than `DAILY_QUOTA`.
    Quota,
}

/// Stores a record. `role` is the one the colony decided: an unaided record becomes `holdout` when the colony itself
/// held that lookup out. Returns false when the same person already sent this role for this error in the last hour.
/// An aided record counts only for a trail the same person reported as working (or partly) in the last two days, so
/// nobody can claim savings for a trail they never used.
pub async fn store<C: ConnectionLike + Send>(
    con: &mut C,
    agent: &str,
    rec: &Record,
    now: i64,
) -> anyhow::Result<Result<(bool, &'static str), Refusal>> {
    if let (Some(id), "aided") = (&rec.trail_id, rec.role)
        && !redis::cmd("EXISTS")
            .arg(helped_key(id, agent))
            .query_async::<bool>(con)
            .await?
    {
        return Ok(Err(Refusal::NotHelped));
    }
    let quota = quota_key(agent, now / 86_400);
    let (used,): (u64,) = redis::pipe()
        .cmd("INCR")
        .arg(&quota)
        .cmd("EXPIRE")
        .arg(&quota)
        .arg(90_000)
        .ignore()
        .query_async(con)
        .await?;
    if used > DAILY_QUOTA {
        return Ok(Err(Refusal::Quota));
    }
    let fp = fingerprint_of(&rec.error);
    let first: Option<String> = redis::cmd("SET")
        .arg(once_key(agent, &fp, rec.role))
        .arg(1)
        .arg("NX")
        .arg("EX")
        .arg(3600)
        .query_async(con)
        .await?;
    let role = if rec.role == "unaided"
        && redis::cmd("EXISTS")
            .arg(holdout_key(agent, &fp))
            .query_async::<bool>(con)
            .await?
    {
        "holdout"
    } else {
        rec.role
    };
    if first.is_none() {
        return Ok(Ok((false, role)));
    }
    let mut pipe = redis::pipe();
    add(&mut pipe, &fp_key(&fp), role, &rec.model, &rec.cost);
    add(&mut pipe, &day_key(now), role, &rec.model, &rec.cost);
    if let (Some(id), "aided") = (&rec.trail_id, role) {
        add(&mut pipe, &trail_key(id), role, &rec.model, &rec.cost);
    }
    pipe.cmd("SADD").arg(FPS).arg(&fp).ignore();
    // How many different people the records come from, without a list of them (a HyperLogLog cannot be read back):
    // a buyer should see whether the figures rest on a team or on one person.
    pipe.cmd("PFADD").arg(people_key(role)).arg(agent).ignore();
    pipe.query_async::<()>(con).await?;
    Ok(Ok((true, role)))
}

/// Sums for one role and model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sums {
    pub n: u64,
    pub cost: Cost,
}

/// A hash of `role|model|metric` fields, as sums per role and model.
pub fn sums_of(hash: &HashMap<String, String>) -> BTreeMap<(String, String), Sums> {
    let mut out: BTreeMap<(String, String), Sums> = BTreeMap::new();
    for (field, value) in hash {
        let mut parts = field.rsplitn(3, '|');
        let (Some(metric), Some(model), Some(role)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let v: u64 = value.parse().unwrap_or(0);
        let s = out
            .entry((role.to_string(), model.to_string()))
            .or_default();
        match metric {
            "n" => s.n += v,
            "input" => s.cost.input += v,
            "output" => s.cost.output += v,
            "cache_read" => s.cost.cache_read += v,
            "cache_write" => s.cost.cache_write += v,
            "turns" => s.cost.turns += v,
            "seconds" => s.cost.seconds += v,
            _ => {}
        }
    }
    out
}

/// What an organisation pays per million tokens of one model.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

pub type Prices = BTreeMap<String, Price>;

/// Checks a price list: model names as clients report them, four prices in dollars per million tokens each.
pub fn parse_prices(value: &Value) -> Result<Prices, String> {
    let prices: Prices = serde_json::from_value(value.clone()).map_err(|_| {
        "prices is an object of models, each with input, output, cache_read and cache_write in dollars per million tokens."
            .to_string()
    })?;
    if prices.len() > 50 {
        return Err("prices holds at most 50 models.".into());
    }
    for (model, p) in &prices {
        if model.is_empty() || model.len() > 64 {
            return Err(format!("{model:?} is not a model name."));
        }
        for v in [p.input, p.output, p.cache_read, p.cache_write] {
            if !(0.0..=10_000.0).contains(&v) {
                return Err(format!(
                    "the prices of {model} are dollars per million tokens, 0 to 10000."
                ));
            }
        }
    }
    Ok(prices)
}

/// The price of a model: its own entry, or the longest entry it starts with (`claude-opus-5-5` covers a dated id).
pub fn price_of<'a>(prices: &'a Prices, model: &str) -> Option<&'a Price> {
    prices.get(model).or_else(|| {
        prices
            .iter()
            .filter(|(k, _)| model.starts_with(k.as_str()))
            .max_by_key(|(k, _)| k.len())
            .map(|(_, p)| p)
    })
}

fn dollars(cost: &Cost, p: &Price) -> f64 {
    (cost.input as f64 * p.input
        + cost.output as f64 * p.output
        + cost.cache_read as f64 * p.cache_read
        + cost.cache_write as f64 * p.cache_write)
        / 1_000_000.0
}

/// Totals over some role and model sums: how many records, tokens, seconds, turns and (when every model has a price)
/// dollars.
#[derive(Clone, Debug, Default)]
struct Total {
    n: u64,
    tokens: f64,
    seconds: f64,
    turns: f64,
    dollars: Option<f64>,
}

fn total<'a>(
    rows: impl Iterator<Item = (&'a String, &'a Sums)>,
    prices: &Prices,
    missing: &mut Vec<String>,
) -> Total {
    let mut t = Total {
        dollars: Some(0.0),
        ..Default::default()
    };
    for (model, s) in rows {
        t.n += s.n;
        t.tokens += s.cost.tokens() as f64;
        t.seconds += s.cost.seconds as f64;
        t.turns += s.cost.turns as f64;
        match price_of(prices, model) {
            Some(p) => t.dollars = t.dollars.map(|d| d + dollars(&s.cost, p)),
            None => {
                t.dollars = None;
                if !missing.contains(model) {
                    missing.push(model.clone());
                }
            }
        }
    }
    t
}

fn mean(t: &Total) -> Value {
    let per = |v: f64| {
        if t.n > 0 {
            (v / t.n as f64).round()
        } else {
            0.0
        }
    };
    json!({
        "records": t.n,
        "tokens": per(t.tokens),
        "seconds": per(t.seconds),
        "turns": per(t.turns),
        "dollars": t.dollars.map(|d| if t.n > 0 { round2(d / t.n as f64) } else { 0.0 }),
    })
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// One estimate: for every error with both baseline and aided records, (baseline mean - aided mean) times the aided
/// records, summed. Errors with only one side say nothing and are counted apart.
fn estimate(
    per_fp: &[BTreeMap<(String, String), Sums>],
    baseline_roles: &[&str],
    prices: &Prices,
    missing: &mut Vec<String>,
) -> Value {
    let (mut errors, mut aided_n, mut baseline_n, mut unmatched) = (0u64, 0u64, 0u64, 0u64);
    let (mut tokens, mut seconds, mut turns) = (0.0, 0.0, 0.0);
    let mut dollars_saved = Some(0.0);
    let mut b_all = Total {
        dollars: Some(0.0),
        ..Default::default()
    };
    let mut a_all = Total {
        dollars: Some(0.0),
        ..Default::default()
    };
    for sums in per_fp {
        let rows = |roles: &[&str]| {
            sums.iter()
                .filter(|((r, _), _)| roles.contains(&r.as_str()))
                .map(|((_, m), s)| (m, s))
                .collect::<Vec<_>>()
        };
        let b = total(rows(baseline_roles).into_iter(), prices, missing);
        let a = total(rows(&["aided"]).into_iter(), prices, missing);
        if a.n == 0 {
            continue;
        }
        if b.n == 0 {
            unmatched += a.n;
            continue;
        }
        errors += 1;
        aided_n += a.n;
        baseline_n += b.n;
        let k = a.n as f64;
        tokens += (b.tokens / b.n as f64 - a.tokens / k) * k;
        seconds += (b.seconds / b.n as f64 - a.seconds / k) * k;
        turns += (b.turns / b.n as f64 - a.turns / k) * k;
        dollars_saved = match (dollars_saved, b.dollars, a.dollars) {
            (Some(s), Some(bd), Some(ad)) => Some(s + (bd / b.n as f64 - ad / k) * k),
            _ => None,
        };
        for (acc, t) in [(&mut b_all, &b), (&mut a_all, &a)] {
            acc.n += t.n;
            acc.tokens += t.tokens;
            acc.seconds += t.seconds;
            acc.turns += t.turns;
            acc.dollars = acc.dollars.zip(t.dollars).map(|(x, y)| x + y);
        }
    }
    json!({
        "errors": errors,
        "aided_records": aided_n,
        "baseline_records": baseline_n,
        "aided_without_baseline": unmatched,
        "saved": {
            "tokens": tokens.round(),
            "seconds": seconds.round(),
            "turns": turns.round(),
            "dollars": dollars_saved.map(round2),
        },
        "per_problem": { "without": mean(&b_all), "with": mean(&a_all) },
    })
}

/// Which models solved problems with the colony's help, and which without: whether cheaper models are doing work that
/// once took a more expensive one.
fn models(per_fp: &[BTreeMap<(String, String), Sums>], prices: &Prices) -> Vec<Value> {
    let mut by: BTreeMap<String, (u64, u64, u64, u64)> = BTreeMap::new();
    for sums in per_fp {
        for ((role, model), s) in sums {
            let e = by.entry(model.clone()).or_default();
            if role == "aided" {
                e.0 += s.n;
                e.1 += s.cost.tokens();
            } else {
                e.2 += s.n;
                e.3 += s.cost.tokens();
            }
        }
    }
    by.into_iter()
        .map(|(model, (an, at, bn, bt))| {
            json!({
                "model": model,
                "with_records": an,
                "with_tokens_per_problem": at.checked_div(an).unwrap_or(0),
                "without_records": bn,
                "without_tokens_per_problem": bt.checked_div(bn).unwrap_or(0),
                "priced": price_of(prices, &model).is_some(),
            })
        })
        .collect()
}

pub const METHOD: &str = "Each record is one problem an agent solved, measured by its client (tokens and time from the first failed command to the fix). For every error with records both without and with the colony's help, the saving is the difference of the means times the problems solved with help; errors with only one side are left out. 'Before and after' compares with every unaided record, so it is an estimate: errors solved without help may differ from those the colony knew. 'Hold-out' compares only with lookups the colony answered with nothing on purpose, chosen at random, so the difference is caused by the colony; it needs MYRMO_HOLDOUT_PERCENT above 0 and time to gather records.";

/// What the colony saved, from every error's sums.
pub fn value(per_fp: &[BTreeMap<(String, String), Sums>], prices: &Prices) -> Value {
    let mut missing = Vec::new();
    let before_after = estimate(per_fp, &["unaided", "holdout"], prices, &mut missing);
    let holdout = estimate(per_fp, &["holdout"], prices, &mut missing);
    missing.sort();
    json!({
        "method": METHOD,
        "before_after": before_after,
        "holdout": holdout,
        "models": models(per_fp, prices),
        "prices_missing": missing,
    })
}

/// Every error's sums, read from Valkey.
pub async fn load<C: ConnectionLike + Send>(
    con: &mut C,
) -> anyhow::Result<Vec<BTreeMap<(String, String), Sums>>> {
    let fps: Vec<String> = redis::cmd("SMEMBERS").arg(FPS).query_async(con).await?;
    let mut out = Vec::new();
    let mut gone = Vec::new();
    for chunk in fps.chunks(200) {
        let mut pipe = redis::pipe();
        for fp in chunk {
            pipe.cmd("HGETALL").arg(fp_key(fp));
        }
        let hashes: Vec<HashMap<String, String>> = pipe.query_async(con).await?;
        for (fp, h) in chunk.iter().zip(hashes) {
            if h.is_empty() {
                gone.push(fp.clone());
            } else {
                out.push(sums_of(&h));
            }
        }
    }
    if !gone.is_empty() {
        redis::cmd("SREM")
            .arg(FPS)
            .arg(gone)
            .query_async::<()>(con)
            .await?;
    }
    Ok(out)
}

/// Per day, oldest first: records by role.
pub async fn daily<C: ConnectionLike + Send>(
    con: &mut C,
    days: i64,
    now: i64,
) -> anyhow::Result<Vec<Value>> {
    let mut out = Vec::new();
    for d in (0..days.clamp(1, 90)).rev() {
        let ts = now - d * 86_400;
        let h: HashMap<String, String> = redis::cmd("HGETALL")
            .arg(day_key(ts))
            .query_async(con)
            .await?;
        let sums = sums_of(&h);
        let count = |role: &str| {
            sums.iter()
                .filter(|((r, _), _)| r == role)
                .map(|(_, s)| s.n)
                .sum::<u64>()
        };
        out.push(json!({
            "date": chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().format("%Y-%m-%d").to_string(),
            "unaided": count("unaided"), "holdout": count("holdout"), "aided": count("aided"),
        }));
    }
    Ok(out)
}

/// What following one trail cost, when measured: records, and mean tokens and seconds.
pub async fn of_trail<C: ConnectionLike + Send>(
    con: &mut C,
    id: &str,
) -> anyhow::Result<Option<Value>> {
    let h: HashMap<String, String> = redis::cmd("HGETALL")
        .arg(trail_key(id))
        .query_async(con)
        .await?;
    let sums = sums_of(&h);
    let (n, tokens, seconds) = sums.values().fold((0, 0, 0), |(n, t, s), x| {
        (n + x.n, t + x.cost.tokens(), s + x.cost.seconds)
    });
    Ok((n > 0).then(|| json!({ "records": n, "tokens": tokens / n, "seconds": seconds / n })))
}

/// Detailed summary of a Pilot's ROI (searches, followed hits, success rate with vs without colony, tokens/time saved).
pub async fn pilot_roi<C: ConnectionLike + Send>(
    con: &mut C,
    st: &crate::state::AppState,
    days: i64,
    now: i64,
) -> anyhow::Result<Value> {
    let days = days.clamp(1, 90);
    let start_ts = now - (days - 1) * 86_400;
    let from_date = chrono::DateTime::from_timestamp(start_ts, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string();
    let to_date = chrono::DateTime::from_timestamp(now, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string();

    // 1. Team search & report activity over the pilot period
    let (tally, _) = crate::team::summary(con, days, now, 1000).await?;
    let mut total_searches = 0u64;
    let mut used_worked = 0u64;
    let mut used_partially = 0u64;
    let mut used_failed = 0u64;
    let mut used_na = 0u64;
    let mut reports_count = 0u64;

    for counts in tally.values() {
        let get = |k: &str| counts.get(k).copied().unwrap_or(0) as u64;
        total_searches += get("searches");
        reports_count += get("reports");
        used_worked += get("used_worked") + get("reuse_worked");
        used_partially += get("used_partially_worked") + get("reuse_partially_worked");
        used_failed += get("used_failed") + get("reuse_failed");
        used_na += get("used_not_applicable") + get("reuse_not_applicable");
    }
    let hits_followed = (used_worked + used_partially + used_failed + used_na).max(reports_count);

    // 2. Success rate with colony
    let total_with_evaluated = used_worked + used_partially + used_failed;
    let success_rate_with_colony = if total_with_evaluated > 0 {
        round2((used_worked + used_partially) as f64 / total_with_evaluated as f64 * 100.0)
    } else {
        0.0
    };

    // 3. Hold-out lookups & success rate without colony
    let mut holdouts_evaluated = 0u64;
    for d in 0..days {
        let ts = now - d * 86_400;
        let holdout_n: Option<u64> = redis::cmd("HGET")
            .arg(crate::analytics::day_key(ts))
            .arg("holdout")
            .query_async(con)
            .await
            .unwrap_or(None);
        holdouts_evaluated += holdout_n.unwrap_or(0);
    }

    let daily_effort = daily(con, days, now).await?;
    let mut holdout_solved = 0u64;
    let mut unaided_solved = 0u64;
    let mut aided_solved = 0u64;
    for d in &daily_effort {
        holdout_solved += d["holdout"].as_u64().unwrap_or(0);
        unaided_solved += d["unaided"].as_u64().unwrap_or(0);
        aided_solved += d["aided"].as_u64().unwrap_or(0);
    }

    let success_rate_without_colony = if holdouts_evaluated > 0 {
        round2((holdout_solved as f64 / holdouts_evaluated as f64 * 100.0).clamp(0.0, 100.0))
    } else if total_searches > 0 && unaided_solved > 0 {
        round2((unaided_solved as f64 / total_searches as f64 * 100.0).clamp(0.0, 100.0))
    } else {
        0.0
    };

    // 4. Measured savings (from effort records)
    let per_fp = load(con).await?;
    let live = crate::api::admin::live(st).await;
    let val = value(&per_fp, &live.prices);
    let holdout_est = &val["holdout"];
    let before_after_est = &val["before_after"];

    let has_holdout_errors = holdout_est["errors"].as_u64().unwrap_or(0) > 0;
    let primary_est = if has_holdout_errors {
        holdout_est
    } else {
        before_after_est
    };

    let saved = &primary_est["saved"];
    let tokens_saved = saved["tokens"].as_f64().unwrap_or(0.0);
    let seconds_saved = saved["seconds"].as_f64().unwrap_or(0.0);
    let turns_saved = saved["turns"].as_f64().unwrap_or(0.0);
    let dollars_saved = saved["dollars"].as_f64();

    // 5. Team keys & participation
    let all_keys = crate::access::list(con).await.unwrap_or_default();
    let total_keys = all_keys.len() as u64;
    let last_seen_map = crate::team::last_seen(con).await.unwrap_or_default();
    let since = now - days * 86_400;
    let active_keys = last_seen_map.values().filter(|ts| **ts >= since).count() as u64;

    Ok(json!({
        "pilot_days": days,
        "period": { "from": from_date, "to": to_date },
        "trails_searched": total_searches,
        "hits_followed": hits_followed,
        "success_rate_with_colony": success_rate_with_colony,
        "success_rate_without_colony": success_rate_without_colony,
        "holdout_percent": live.holdout_percent,
        "holdouts_evaluated": holdouts_evaluated,
        "holdout_solved": holdout_solved,
        "aided_records": aided_solved,
        "saved": {
            "tokens": tokens_saved,
            "seconds": seconds_saved,
            "hours": round2(seconds_saved / 3600.0),
            "turns": turns_saved,
            "dollars": dollars_saved,
        },
        "per_problem": primary_est["per_problem"],
        "baseline_method": if has_holdout_errors { "holdout" } else { "before_after" },
        "team": {
            "total_keys": total_keys,
            "active_keys": active_keys,
            "contributors": contributors(con).await.unwrap_or(json!({})),
        }
    }))
}

/// CLI command `myrmo-server pilot-roi [days]`
pub async fn cli_pilot_roi(st: &crate::state::AppState, args: &[String]) -> anyhow::Result<()> {
    let days: i64 = args
        .first()
        .map(|d| d.parse())
        .transpose()?
        .unwrap_or(14)
        .clamp(1, 90);
    let mut con = st.redis();
    let r = pilot_roi(&mut con, st, days, crate::keys::now()).await?;

    println!("============================================================");
    println!("                   MYRMO PILOT ROI SUMMARY                  ");
    println!(
        "        Period: Last {} days ({} to {})",
        r["pilot_days"],
        r["period"]["from"].as_str().unwrap_or(""),
        r["period"]["to"].as_str().unwrap_or("")
    );
    println!("============================================================\n");

    println!("1. Team Engagement:");
    println!(
        "   Active Team Keys:     {} / {}",
        r["team"]["active_keys"], r["team"]["total_keys"]
    );
    println!("   Trails Searched:      {}", r["trails_searched"]);
    println!("   Hits Followed:        {}", r["hits_followed"]);

    println!("\n2. Colony Impact & Success Rate:");
    println!(
        "   Success Rate WITH:    {}% (followed trails that worked)",
        r["success_rate_with_colony"]
    );
    if r["holdouts_evaluated"].as_u64().unwrap_or(0) > 0 {
        println!(
            "   Success Rate WITHOUT: {}% (from {} randomized holdouts)",
            r["success_rate_without_colony"], r["holdouts_evaluated"]
        );
        let with_sr = r["success_rate_with_colony"].as_f64().unwrap_or(0.0);
        let without_sr = r["success_rate_without_colony"].as_f64().unwrap_or(0.0);
        if with_sr > without_sr {
            println!(
                "   Relative Lift:        +{:.1}% higher resolution rate with Colony",
                with_sr - without_sr
            );
        }
    } else {
        println!(
            "   Hold-out Status:      Off (Set holdout_percent in admin to activate randomized control group)"
        );
    }

    println!("\n3. Measured Developer Savings (Telemetry):");
    println!(
        "   Tokens Saved:         {:.0} tokens",
        r["saved"]["tokens"].as_f64().unwrap_or(0.0)
    );
    println!(
        "   Agent Time Saved:     {:.1} hours ({:.0} seconds)",
        r["saved"]["hours"].as_f64().unwrap_or(0.0),
        r["saved"]["seconds"].as_f64().unwrap_or(0.0)
    );
    println!(
        "   Agent Turns Saved:    {:.0} turns",
        r["saved"]["turns"].as_f64().unwrap_or(0.0)
    );
    if let Some(dollars) = r["saved"]["dollars"].as_f64() {
        println!("   Financial Savings:    ${:.2}", dollars);
    } else {
        println!(
            "   Financial Savings:    Configure model token prices in admin Settings to view dollar ROI"
        );
    }

    println!("\n4. Per-Problem Comparison (Baseline vs Colony):");
    let per = &r["per_problem"];
    let without = &per["without"];
    let with = &per["with"];
    println!(
        "   Without Colony:       {:.0} tokens | {:.1} mins | {:.0} turns",
        without["tokens"].as_f64().unwrap_or(0.0),
        without["seconds"].as_f64().unwrap_or(0.0) / 60.0,
        without["turns"].as_f64().unwrap_or(0.0)
    );
    println!(
        "   With Colony:          {:.0} tokens | {:.1} mins | {:.0} turns",
        with["tokens"].as_f64().unwrap_or(0.0),
        with["seconds"].as_f64().unwrap_or(0.0) / 60.0,
        with["turns"].as_f64().unwrap_or(0.0)
    );
    println!("============================================================");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Value {
        json!({
            "role": "aided", "error": "migrate: lock 'migrate' is held by ci-runner-17",
            "trail_id": "3F2B8C1E-9A4D-4E2F-8B1A-2C3D4E5F6A7B",
            "effort": { "input_tokens": 12, "output_tokens": 3400, "cache_read_tokens": 90000, "cache_write_tokens": 20000, "turns": 7, "wall_time_seconds": 140 },
            "agent_info": { "model": "claude-haiku-5-5", "framework": "claude-code" }
        })
    }

    #[test]
    fn the_protocol_schema_and_the_parser_agree() {
        assert_eq!(crate::schema::validate_effort(&body()), Ok(()));
        let mut b = body();
        b["extra"] = json!(1);
        assert!(
            crate::schema::validate_effort(&b).is_err(),
            "unknown fields are refused"
        );
    }

    #[test]
    fn a_record_is_checked() {
        let r = parse(&body()).unwrap();
        assert_eq!(r.role, "aided");
        assert_eq!(
            r.trail_id.as_deref(),
            Some("3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b")
        );
        assert_eq!(r.cost.tokens(), 113_412);
        assert_eq!(r.model, "claude-haiku-5-5");
        let mut b = body();
        b["trail_id"] = Value::Null;
        assert!(parse(&b).is_err(), "aided needs a trail");
        b["role"] = json!("unaided");
        assert!(parse(&b).is_ok());
        b["role"] = json!("holdout");
        assert!(parse(&b).is_err(), "the colony decides what is held out");
        let mut b = body();
        b["effort"]["output_tokens"] = json!(-1);
        assert!(parse(&b).is_err());
        let mut b = body();
        b["effort"] = json!({});
        assert!(parse(&b).is_err());
        let mut b = body();
        b["error"] = json!("short");
        assert!(parse(&b).is_err());
    }

    #[test]
    fn the_hold_out_is_stable_and_about_the_share_asked() {
        assert!(!held_out(
            "s",
            "person:ana",
            "fp2_0123456789abcdef",
            20_000,
            0
        ));
        let a = held_out("s", "person:ana", "fp2_0123456789abcdef", 20_000, 10);
        assert_eq!(
            a,
            held_out("s", "person:ana", "fp2_0123456789abcdef", 20_000, 10)
        );
        let n = (0..10_000)
            .filter(|i| {
                held_out(
                    "s",
                    &format!("person:{i}"),
                    "fp2_0123456789abcdef",
                    20_000,
                    10,
                )
            })
            .count();
        assert!((800..1200).contains(&n), "{n}");
        // Another salt, another draw: the source alone does not say which lookups are held out.
        let differ = (0..200)
            .filter(|i| {
                let a = format!("person:{i}");
                held_out("s", &a, "fp2_x", 1, 50) != held_out("t", &a, "fp2_x", 1, 50)
            })
            .count();
        assert!(differ > 50, "{differ}");
    }

    #[test]
    fn sums_are_read_back_by_role_and_model() {
        let h: HashMap<String, String> = [
            ("aided|claude-haiku-5-5|n", "2"),
            ("aided|claude-haiku-5-5|output", "100"),
            ("unaided|claude-opus-5-5|n", "1"),
            ("unaided|claude-opus-5-5|seconds", "600"),
            ("broken", "9"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let s = sums_of(&h);
        assert_eq!(s[&("aided".into(), "claude-haiku-5-5".into())].n, 2);
        assert_eq!(
            s[&("aided".into(), "claude-haiku-5-5".into())].cost.output,
            100
        );
        assert_eq!(
            s[&("unaided".into(), "claude-opus-5-5".into())]
                .cost
                .seconds,
            600
        );
        assert_eq!(s.len(), 2);
    }

    fn sums(rows: &[(&str, &str, u64, u64, u64)]) -> BTreeMap<(String, String), Sums> {
        rows.iter()
            .map(|(role, model, n, output, seconds)| {
                (
                    (role.to_string(), model.to_string()),
                    Sums {
                        n: *n,
                        cost: Cost {
                            output: *output,
                            seconds: *seconds,
                            ..Default::default()
                        },
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_saving_is_the_difference_of_means_times_the_problems_helped() {
        let prices: Prices = [
            (
                "claude-opus-5-5".to_string(),
                Price {
                    input: 4.0,
                    output: 20.0,
                    cache_read: 0.2,
                    cache_write: 5.0,
                },
            ),
            (
                "claude-haiku-5-5".to_string(),
                Price {
                    input: 0.1,
                    output: 0.5,
                    cache_read: 0.01,
                    cache_write: 0.125,
                },
            ),
        ]
        .into_iter()
        .collect();
        let per_fp = vec![
            // Without help: two problems, 100k output tokens and 30 minutes on average, with Opus.
            // With help: four problems, 10k tokens and 5 minutes on average, with Haiku.
            sums(&[
                ("unaided", "claude-opus-5-5", 2, 200_000, 3600),
                ("aided", "claude-haiku-5-5", 4, 40_000, 1200),
            ]),
            // Helped, but never seen without help: left out.
            sums(&[("aided", "claude-haiku-5-5", 3, 30_000, 300)]),
        ];
        let v = value(&per_fp, &prices);
        let ba = &v["before_after"];
        assert_eq!(ba["errors"], 1);
        assert_eq!(ba["aided_records"], 4);
        assert_eq!(ba["aided_without_baseline"], 3);
        assert_eq!(ba["saved"]["tokens"], 360_000.0);
        assert_eq!(ba["saved"]["seconds"], 6_000.0);
        // 4 x ($2.00 - $0.005)
        assert_eq!(ba["saved"]["dollars"], 7.98);
        assert_eq!(v["holdout"]["errors"], 0, "no hold-out records yet");
        assert_eq!(v["prices_missing"], json!([]));
    }

    #[test]
    fn without_a_price_for_every_model_no_dollars_are_claimed() {
        let per_fp = vec![sums(&[
            ("holdout", "some-model", 1, 1000, 60),
            ("aided", "some-model", 1, 100, 6),
        ])];
        let v = value(&per_fp, &Prices::new());
        assert_eq!(v["holdout"]["errors"], 1);
        assert!(v["holdout"]["saved"]["dollars"].is_null());
        assert_eq!(v["prices_missing"], json!(["some-model"]));
    }

    #[test]
    fn a_dated_model_id_takes_its_family_price() {
        let prices: Prices = [(
            "claude-opus-5-5".to_string(),
            Price {
                input: 4.0,
                output: 20.0,
                cache_read: 0.2,
                cache_write: 5.0,
            },
        )]
        .into_iter()
        .collect();
        assert!(price_of(&prices, "claude-opus-5-5-20261001").is_some());
        assert!(price_of(&prices, "claude-opus-5").is_none());
        assert!(
            parse_prices(
                &json!({ "m": { "input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1.25 } })
            )
            .is_ok()
        );
        assert!(parse_prices(&json!({ "m": { "input": -1, "output": 2, "cache_read": 0.1, "cache_write": 1.25 } })).is_err());
        assert!(parse_prices(&json!({ "m": { "input": 1 } })).is_err());
    }
}
