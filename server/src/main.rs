//! Myrmo colony server.
//!
//!   myrmo-server serve    REST gateway (stateless; run as many as needed)
//!   myrmo-server enrich   enrichment worker (run as many as needed)
//!   myrmo-server all      both in one process, for small deployments

mod analytics;
mod api;
mod config;
mod decision;
mod embed;
mod enricher;
mod fingerprint;
mod keys;
mod norm;
mod redact;
mod risk;
mod schema;
mod state;
mod store;
mod strength;

use anyhow::Result;
use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    if std::env::var("MYRMO_LOG_JSON").is_ok_and(|v| v == "1") {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let mode = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    let cfg = config::Config::from_env();
    let st = state::AppState::connect(cfg.clone()).await?;

    match mode.as_str() {
        "serve" => serve(st).await,
        "enrich" => {
            // On a stop signal, leave unfinished entries pending: they are reclaimed and retried.
            tokio::select! {
                result = enricher::run(st) => result,
                () = shutdown_signal() => Ok(()),
            }
        }
        "all" => {
            tokio::spawn(enricher::run(st.clone()));
            serve(st).await
        }
        other => anyhow::bail!("unknown mode {other:?}; expected serve, enrich or all"),
    }
}

async fn serve(st: state::AppState) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(&st.cfg.bind).await?;
    tracing::info!(address = %st.cfg.bind, "gateway listening");
    let app = api::router(st);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Resolves on Ctrl-C or SIGTERM. `docker stop` sends SIGTERM, which a process running as
/// PID 1 ignores unless it installs a handler: without this every deploy waited out the grace
/// period and ended in SIGKILL, dropping in-flight requests.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
