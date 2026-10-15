//! Access keys for a private colony: one per person, kept only as a digest, revocable.
//!
//! With `MYRMO_REQUIRE_KEY=1` every `/v1` request needs `Authorization: Bearer <key>`, and the person the key belongs
//! to becomes the caller's identity: their agents share one id, so "an author cannot reinforce their own trail" and
//! "one report per agent and trail per day" apply per person, and reuse between people can be counted.
//!
//!   myrmo-server keys add <person>      prints a new key once
//!   myrmo-server keys list              the people who hold a key
//!   myrmo-server keys revoke <person>   the key stops working at once

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

/// digest of a key -> person
const BY_DIGEST: &str = "access:keys";
/// person -> {"digest", "created_ts"}
const BY_PERSON: &str = "access:people";
pub const PREFIX: &str = "myk_";

pub fn digest(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// Lowercase letters, digits, dots, dashes and underscores; 2 to 32 characters. It ends up in trail metadata and
/// analytics, so it is a handle (`martin`, `ana.r`), never an e-mail address.
pub fn valid_person(person: &str) -> bool {
    (2..=32).contains(&person.len())
        && person
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
}

/// The id a person's agents act under. Not a valid `X-Myrmo-Agent` (it has a colon), so no client can claim it.
pub fn agent_of(person: &str) -> String {
    format!("person:{person}")
}

/// 244 random bits from two v4 UUIDs.
fn generate() -> String {
    format!(
        "{PREFIX}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The bearer token of a request, if any.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    header
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Authenticate an access key. Returns (person, digest) if valid.
pub async fn authenticate<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    key: &str,
) -> Result<Option<(String, String)>> {
    if !key.starts_with(PREFIX) {
        return Ok(None);
    }
    let d = digest(key);
    let person: Option<String> = redis::cmd("HGET")
        .arg(BY_DIGEST)
        .arg(&d)
        .query_async(con)
        .await?;
    Ok(person.map(|p| (p, d)))
}

/// The person a key belongs to, or None for an unknown or revoked key.
pub async fn person_of<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    key: &str,
) -> Result<Option<String>> {
    Ok(authenticate(con, key).await?.map(|(p, _)| p))
}

pub async fn add<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    person: &str,
    now: i64,
) -> Result<String> {
    let mut results = add_batch(con, &[person], now).await?;
    let (_, key) = results.pop().unwrap();
    Ok(key)
}

/// Creates keys for multiple people in one transaction. Returns (person, key) pairs.
pub async fn add_batch<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    people: &[&str],
    now: i64,
) -> Result<Vec<(String, String)>> {
    if people.is_empty() {
        return Ok(Vec::new());
    }
    for person in people {
        if !valid_person(person) {
            bail!("{person:?} is not a valid name: 2-32 lowercase letters, digits, '.', '-' or '_'");
        }
    }
    // Check for duplicates within the input
    let mut seen = std::collections::HashSet::new();
    for p in people {
        if !seen.insert(p) {
            bail!("duplicate name in batch: {p}");
        }
    }
    let mut pipe = redis::pipe();
    for person in people {
        pipe.cmd("HEXISTS").arg(BY_PERSON).arg(*person);
    }
    let exists: Vec<bool> = pipe.query_async(con).await?;
    for (person, ex) in people.iter().zip(exists) {
        if ex {
            bail!("{person} already has a key: revoke it first to issue a new one");
        }
    }

    let mut generated = Vec::with_capacity(people.len());
    let mut save_pipe = redis::pipe();
    save_pipe.atomic();
    for person in people {
        let key = generate();
        let record = serde_json::json!({ "digest": digest(&key), "created_ts": now }).to_string();
        save_pipe
            .hset(BY_DIGEST, digest(&key), *person)
            .ignore()
            .hset(BY_PERSON, *person, record)
            .ignore();
        generated.push((person.to_string(), key));
    }
    save_pipe.query_async::<()>(con).await?;
    Ok(generated)
}

/// Generates `count` individual keys with the given handle prefix (e.g. `pilot-01`, `pilot-02`...).
/// Automatically avoids handles that already exist.
pub async fn generate_n<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    count: usize,
    prefix: &str,
    now: i64,
) -> Result<Vec<(String, String)>> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if count > 500 {
        bail!("can generate at most 500 keys in one batch");
    }
    let prefix = prefix.trim().to_ascii_lowercase();
    let prefix = if prefix.is_empty() { "pilot" } else { &prefix };
    if !valid_person(prefix) {
        bail!("{prefix:?} is not a valid handle prefix");
    }

    let mut handles = Vec::with_capacity(count);
    let mut num = 1;
    while handles.len() < count {
        let candidate = if count <= 99 {
            format!("{prefix}-{num:02}")
        } else {
            format!("{prefix}-{num:03}")
        };
        let exists: bool = redis::cmd("HEXISTS")
            .arg(BY_PERSON)
            .arg(&candidate)
            .query_async(con)
            .await?;
        if !exists {
            handles.push(candidate);
        }
        num += 1;
    }

    let handle_refs: Vec<&str> = handles.iter().map(String::as_str).collect();
    add_batch(con, &handle_refs, now).await
}

pub async fn revoke<C: redis::aio::ConnectionLike + Send>(
    con: &mut C,
    person: &str,
) -> Result<bool> {
    let record: Option<String> = redis::cmd("HGET")
        .arg(BY_PERSON)
        .arg(person)
        .query_async(con)
        .await?;
    let Some(record) = record else {
        return Ok(false);
    };
    let digest = serde_json::from_str::<serde_json::Value>(&record)?["digest"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    redis::pipe()
        .atomic()
        .hdel(BY_DIGEST, digest)
        .ignore()
        .hdel(BY_PERSON, person)
        .ignore()
        .query_async::<()>(con)
        .await?;
    Ok(true)
}

/// (person, created_ts), sorted by name.
pub async fn list<C: redis::aio::ConnectionLike + Send>(con: &mut C) -> Result<Vec<(String, i64)>> {
    let all: Vec<(String, String)> = redis::cmd("HGETALL")
        .arg(BY_PERSON)
        .query_async(con)
        .await?;
    let mut people: Vec<(String, i64)> = all
        .into_iter()
        .map(|(person, record)| {
            let created = serde_json::from_str::<serde_json::Value>(&record)
                .ok()
                .and_then(|v| v["created_ts"].as_i64())
                .unwrap_or(0);
            (person, created)
        })
        .collect();
    people.sort();
    Ok(people)
}

/// `myrmo-server keys ...`: needs only Valkey, so it runs even while the rest of the colony is down.
pub async fn cli(redis_url: &str, args: &[String]) -> Result<()> {
    let client = redis::Client::open(redis_url)?;
    let mut con = client.get_multiplexed_async_connection().await?;
    let now = chrono::Utc::now().timestamp();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["add", person] => {
            let key = add(&mut con, person, now).await?;
            println!("{key}");
            eprintln!(
                "Key for {person}. It is shown only now: give it to them privately. They set up their machine with\n  npx myrmo-mcp init --url <this colony's address> --key <the key> --private --publish auto"
            );
        }
        ["add", people @ ..] if !people.is_empty() => {
            let pairs = add_batch(&mut con, people, now).await?;
            for (person, key) in &pairs {
                println!("{person}\t{key}");
            }
            eprintln!(
                "\n{} keys created. Give each person their key privately. They set up with:\n  npx myrmo-mcp init --url <this colony's address> --key <key> --private --publish auto",
                pairs.len()
            );
        }
        ["generate", count_str] => {
            let count: usize = count_str.parse().map_err(|_| anyhow::anyhow!("invalid count: {count_str}"))?;
            let pairs = generate_n(&mut con, count, "pilot", now).await?;
            for (person, key) in &pairs {
                println!("{person}\t{key}");
            }
            eprintln!(
                "\nGenerated {count} pilot keys. Each developer sets up their machine with:\n  npx myrmo-mcp init --url <this colony's address> --key <their-key> --private --publish auto"
            );
        }
        ["generate", count_str, prefix] => {
            let count: usize = count_str.parse().map_err(|_| anyhow::anyhow!("invalid count: {count_str}"))?;
            let pairs = generate_n(&mut con, count, prefix, now).await?;
            for (person, key) in &pairs {
                println!("{person}\t{key}");
            }
            eprintln!(
                "\nGenerated {count} keys with prefix '{prefix}'. Each developer sets up their machine with:\n  npx myrmo-mcp init --url <this colony's address> --key <their-key> --private --publish auto"
            );
        }
        ["erase", person] | ["revoke", person, "--erase"] => {
            let revoked = revoke(&mut con, person).await?;
            let erased_items = crate::team::erase(&mut con, person, now).await?;
            if revoked {
                eprintln!("{person}'s key revoked and {erased_items} data item(s) erased (GDPR compliance).");
            } else {
                eprintln!("{person} had no active key, but {erased_items} activity data item(s) were erased.");
            }
        }
        ["revoke", person] => {
            if revoke(&mut con, person).await? {
                eprintln!("{person}'s key no longer works.");
            } else {
                bail!("{person} has no key");
            }
        }
        ["list"] => {
            for (person, created) in list(&mut con).await? {
                let when = chrono::DateTime::from_timestamp(created, 0)
                    .map(|d| d.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                println!("{person}\t{when}");
            }
        }
        _ => bail!("usage: myrmo-server keys add <person...> | generate <N> [prefix] | list | revoke <person> [--erase] | erase <person>"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_are_handles_not_addresses() {
        assert!(valid_person("martin"));
        assert!(valid_person("ana.r-2"));
        assert!(!valid_person("m"));
        assert!(!valid_person("Martin"));
        assert!(!valid_person("martin@example.com"));
        assert!(!valid_person(&"a".repeat(33)));
    }

    #[test]
    fn keys_are_long_random_and_never_stored_in_clear() {
        let (a, b) = (generate(), generate());
        assert_ne!(a, b);
        assert!(a.starts_with(PREFIX) && a.len() == PREFIX.len() + 64);
        assert_eq!(digest(&a).len(), 64);
        assert_ne!(digest(&a), a);
    }

    #[test]
    fn a_person_id_cannot_be_claimed_with_the_agent_header() {
        assert_eq!(agent_of("martin"), "person:martin");
        assert!(
            agent_of("martin").contains(':'),
            "X-Myrmo-Agent only accepts [A-Za-z0-9_-]"
        );
    }

    #[test]
    fn bearer_reads_only_the_token() {
        assert_eq!(bearer(Some("Bearer myk_x")), Some("myk_x"));
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn batch_prefixes_must_be_valid_handles() {
        assert!(valid_person("pilot"));
        assert!(valid_person("team-2"));
        assert!(!valid_person("P"));
        assert!(!valid_person("invalid@pilot"));
    }
}
