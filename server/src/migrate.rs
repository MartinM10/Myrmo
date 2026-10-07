//! Moves the fingerprint index from fp1 (runtime, error type and message) to fp2 (the message alone).
//!
//! A trail is filed under its fingerprint in a Redis set (`fp:<fp>`), and its fingerprint is also kept in its
//! metadata and in its search payload. The colony now computes fp2, so a colony that already holds trails has to
//! refile them: for every `fp:fp1_*` set, each trail is read back from the search index, gets the fp2 of its
//! message, and the old set goes away. The move is idempotent, safe to interrupt, and runs once in the
//! background when the gateway or a worker starts: until a trail has moved, a lookup for it misses and the
//! client falls back to the semantic search, so nothing breaks while it runs.

use crate::state::AppState;
use crate::{fingerprint, keys};
use anyhow::Result;
use redis::AsyncCommands;
use serde_json::json;

/// Set once every fp1 set has been moved, so later starts skip the scan.
const DONE: &str = "schema:fingerprint";
/// Held while one process runs the move, so that replicas starting together do not repeat it.
const LOCK: &str = "lock:fingerprint-migration";
const BATCH: usize = 50;

/// Run the move once, unless it is done or another process is doing it. `force` ignores the done marker, for an
/// operator who wants to sweep up trails that an older server filed under fp1 during a rolling update.
pub async fn run_once(st: AppState, force: bool) -> Result<()> {
    let mut con = st.redis();
    if !force {
        let done: Option<String> = con.get(DONE).await?;
        if done.as_deref() == Some("2") {
            return Ok(());
        }
    }
    let locked: Option<String> = redis::cmd("SET")
        .arg(LOCK)
        .arg(keys::now())
        .arg("NX")
        .arg("EX")
        .arg(3600)
        .query_async(&mut con)
        .await?;
    if locked.is_none() {
        tracing::info!("fingerprint migration is already running elsewhere");
        return Ok(());
    }
    let result = move_sets(&st).await;
    let _: redis::RedisResult<()> = con.del(LOCK).await;
    let (sets, trails) = result?;
    let _: () = con.set(DONE, "2").await?;
    tracing::info!(sets, trails, "fingerprints moved to fp2");
    Ok(())
}

/// Every key of the old fingerprint sets, collected before anything moves so the scan is not disturbed by the writes.
async fn old_sets(con: &mut redis::aio::ConnectionManager) -> Result<Vec<String>> {
    let mut cursor: u64 = 0;
    let mut found = Vec::new();
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(keys::fingerprint(&format!("{}*", fingerprint::PREFIX_V1)))
            .arg("COUNT")
            .arg(500)
            .query_async(con)
            .await?;
        found.extend(batch);
        cursor = next;
        if cursor == 0 {
            return Ok(found);
        }
    }
}

async fn move_sets(st: &AppState) -> Result<(usize, usize)> {
    let mut con = st.redis();
    let sets = old_sets(&mut con).await?;
    let mut moved = 0;
    for key in &sets {
        let old_fp = key.strip_prefix("fp:").unwrap_or(key).to_string();
        let ids: Vec<String> = con.smembers(key).await?;
        for chunk in ids.chunks(BATCH) {
            let mut updates = Vec::new();
            let mut pipe = redis::pipe();
            for (id, payload) in st.qdrant.get(chunk).await? {
                let fp = fingerprint::of_trail(&payload["trail"]);
                pipe.cmd("SADD")
                    .arg(keys::fingerprint(&fp))
                    .arg(&id)
                    .ignore();
                pipe.cmd("HSET")
                    .arg(keys::trail(&id))
                    .arg("fingerprint")
                    .arg(&fp)
                    .ignore();
                pipe.cmd("DEL").arg(keys::fingerprint_cache(&fp)).ignore();
                updates.push((id, json!({ "fingerprint": fp })));
                moved += 1;
            }
            // The index first, then the sets: a crash in between leaves the trail findable under both.
            st.qdrant.set_payloads(updates).await?;
            pipe.query_async::<()>(&mut con).await?;
        }
        let _: () = con.del(key).await?;
        let _: () = con.del(keys::fingerprint_cache(&old_fp)).await?;
    }
    Ok((sets.len(), moved))
}
