//! Shared application state and connections, with startup retries so containers can
//! start in any order.

use crate::config::Config;
use crate::decision::Decision;
use crate::embed::Embedder;
use crate::store::Qdrant;
use anyhow::{Context, Result};
use redis::aio::ConnectionManager;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub cfg: Config,
    pub redis: ConnectionManager,
    pub qdrant: Qdrant,
    pub embedder: Embedder,
    pub decision: Decision,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

async fn retry<T, F, Fut>(what: &str, attempts: u32, mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut last = None;
    for attempt in 1..=attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(err) => {
                tracing::info!(attempt, error = %err, "waiting for {what}");
                last = Some(err);
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
    Err(last.unwrap()).with_context(|| format!("{what} not reachable"))
}

impl AppState {
    pub async fn connect(cfg: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(256)
            .timeout(Duration::from_secs(15))
            .build()?;

        let client = redis::Client::open(cfg.redis_url.as_str())?;
        let redis = retry("redis", 100, || {
            let client = client.clone();
            async move { Ok(ConnectionManager::new(client).await?) }
        })
        .await?;

        let qdrant = Qdrant::new(http.clone(), &cfg.qdrant_url, &cfg.collection);
        let embedder = Embedder::new(http.clone(), &cfg.embed_url);
        let decision = Decision::new(http.clone(), cfg.decision_url.clone(), cfg.decision_api_key.clone());

        // The embedding model can take minutes to download on first start.
        let dimension = retry("embedding service", 200, || {
            let embedder = embedder.clone();
            async move { Ok(embedder.embed("dimension probe").await?.len()) }
        })
        .await?;
        retry("qdrant", 100, || {
            let qdrant = qdrant.clone();
            async move { qdrant.ensure_collection(dimension).await }
        })
        .await?;
        tracing::info!(dimension, "connected to redis, qdrant and the embedding service");

        Ok(AppState(Arc::new(Inner { cfg, redis, qdrant, embedder, decision })))
    }

    pub fn redis(&self) -> ConnectionManager {
        self.redis.clone()
    }
}
