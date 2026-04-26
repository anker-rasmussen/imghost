use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::Router;
use sqlx::SqlitePool;
use axum::http::StatusCode;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

mod admin;
mod auth;
mod config;
mod serve;
mod storage;
mod upload;

use config::AppConfig;

#[derive(Clone, Debug)]
pub(crate) struct AppState {
    pub(crate) config: Arc<AppConfig>,
    pub(crate) pool: SqlitePool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--healthcheck") {
        return run_healthcheck();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "imghost=info,tower_http=info".into()),
        )
        .json()
        .init();

    let cfg = Arc::new(AppConfig::from_env()?);
    tracing::info!(
        bind = %cfg.bind_addr,
        data_dir = %cfg.data_dir.display(),
        max_upload = cfg.max_upload_bytes,
        "starting imghost"
    );

    let pool = storage::init_pool(&cfg.db_path(), &cfg.objects_dir()).await?;
    let state = AppState {
        config: cfg.clone(),
        pool,
    };

    let upload_routes = Router::new()
        .route("/upload", post(upload::upload))
        .layer(DefaultBodyLimit::max(cfg.max_upload_bytes))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(from_fn_with_state(state.clone(), auth::require_bearer));

    let admin_routes = Router::new()
        .route("/admin", get(admin::list))
        .route("/admin/delete/{id}", post(admin::delete))
        .layer(from_fn_with_state(state.clone(), auth::require_basic));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .merge(serve::router(&cfg.objects_dir()))
        .merge(upload_routes)
        .merge(admin_routes)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

fn run_healthcheck() -> anyhow::Result<()> {
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let port = addr.rsplit(':').next().unwrap_or("8080");
    // The docker healthcheck just needs to confirm the listener is accepting connections.
    let _stream = std::net::TcpStream::connect(format!("127.0.0.1:{port}"))?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
