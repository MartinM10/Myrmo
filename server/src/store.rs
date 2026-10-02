//! Qdrant over its REST API. One point per indexed trail; the payload holds the
//! redacted trail and its enrichment, so a search needs a single round trip.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Qdrant {
    http: reqwest::Client,
    base: String,
    collection: String,
}

pub struct Hit {
    pub id: String,
    pub score: f64,
}

impl Qdrant {
    pub fn new(http: reqwest::Client, base: &str, collection: &str) -> Self {
        Self {
            http,
            base: base.to_string(),
            collection: collection.to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/collections/{}{}", self.base, self.collection, path)
    }

    async fn call(&self, req: reqwest::RequestBuilder) -> Result<Value> {
        let res = req.send().await.context("qdrant unreachable")?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("qdrant {status}: {body}");
        }
        Ok(body["result"].clone())
    }

    /// Create the collection and payload indexes if missing. Safe to call concurrently.
    pub async fn ensure_collection(&self, dimension: usize) -> Result<()> {
        let exists = self
            .http
            .get(self.url(""))
            .send()
            .await
            .context("qdrant unreachable")?;
        if exists.status().is_success() {
            return Ok(());
        }
        let created = self
            .http
            .put(self.url(""))
            .json(&json!({
                "vectors": { "size": dimension, "distance": "Cosine" },
                "on_disk_payload": true
            }))
            .send()
            .await?;
        // A concurrent creator wins the race with 409; that is fine.
        if !created.status().is_success() && created.status().as_u16() != 409 {
            bail!(
                "cannot create collection: {}",
                created.text().await.unwrap_or_default()
            );
        }
        for (field, schema) in [
            ("fingerprint", "keyword"),
            ("category", "keyword"),
            ("runtime", "keyword"),
        ] {
            self.call(
                self.http
                    .put(self.url("/index"))
                    .json(&json!({ "field_name": field, "field_schema": schema })),
            )
            .await
            .ok();
        }
        Ok(())
    }

    /// Whether the collection answers.
    pub async fn healthy(&self) -> bool {
        self.http
            .get(self.url(""))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .is_ok_and(|res| res.status().is_success())
    }

    /// Remove a point from the index. Missing points are fine.
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.call(
            self.http
                .post(self.url("/points/delete?wait=true"))
                .json(&json!({ "points": [id] })),
        )
        .await?;
        Ok(())
    }

    pub async fn upsert(&self, id: &str, vector: Vec<f32>, payload: Value) -> Result<()> {
        self.call(
            self.http
                .put(self.url("/points?wait=true"))
                .json(&json!({ "points": [{ "id": id, "vector": vector, "payload": payload }] })),
        )
        .await?;
        Ok(())
    }

    /// Payloads for the given ids, in no particular order. Missing ids are skipped.
    pub async fn get(&self, ids: &[String]) -> Result<Vec<(String, Value)>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let result = self
            .call(
                self.http
                    .post(self.url("/points"))
                    .json(&json!({ "ids": ids, "with_payload": true, "with_vector": false })),
            )
            .await?;
        Ok(result
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| (id_string(&p["id"]), p["payload"].clone()))
            .collect())
    }

    pub async fn search(&self, vector: &[f32], limit: usize) -> Result<Vec<Hit>> {
        let result = self
            .call(self.http.post(self.url("/points/query")).json(&json!({
                "query": vector,
                "limit": limit,
                "with_payload": false
            })))
            .await?;
        Ok(result["points"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| Hit {
                id: id_string(&p["id"]),
                score: p["score"].as_f64().unwrap_or(0.0),
            })
            .collect())
    }

    /// Merge a payload update into each point, in one batch request.
    pub async fn set_payloads(&self, updates: Vec<(String, Value)>) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let operations: Vec<Value> = updates
            .into_iter()
            .map(|(id, payload)| json!({ "set_payload": { "payload": payload, "points": [id] } }))
            .collect();
        self.call(
            self.http
                .post(self.url("/points/batch?wait=false"))
                .json(&json!({ "operations": operations })),
        )
        .await?;
        Ok(())
    }
}

fn id_string(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
