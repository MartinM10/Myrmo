//! Embeddings from a Text Embeddings Inference server. TEI batches concurrent requests
//! dynamically, so the gateway sends one text per request and lets TEI group them.

use anyhow::{Context, Result, bail};
use serde_json::json;

#[derive(Clone)]
pub struct Embedder {
    http: reqwest::Client,
    url: String,
}

impl Embedder {
    pub fn new(http: reqwest::Client, url: &str) -> Self {
        Self {
            http,
            url: format!("{url}/embed"),
        }
    }

    pub async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let res = self
            .http
            .post(&self.url)
            .json(&json!({ "inputs": [text], "normalize": true, "truncate": true }))
            .send()
            .await
            .context("embedding service unreachable")?;
        if !res.status().is_success() {
            bail!(
                "embedding service {}: {}",
                res.status(),
                res.text().await.unwrap_or_default()
            );
        }
        let mut vectors: Vec<Vec<f32>> = res.json().await.context("invalid embedding response")?;
        vectors.pop().context("empty embedding response")
    }
}
