use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::Router;
use sqlx::SqlitePool;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

pub mod admin;
pub mod auth;
pub mod config;
mod fleet;
mod index;
pub mod serve;
pub mod storage;
pub mod upload;

use config::AppConfig;

#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub pool: SqlitePool,
    pub started_at: Instant,
}

/// Build the full application router from the given state.
///
/// This is split out from `main` so integration tests can construct the app
/// in-process without going through environment-variable parsing or binding a
/// real listener.
pub fn build_app(state: AppState) -> Router {
    let cfg = Arc::clone(&state.config);

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

    Router::new()
        .route("/", get(index::index))
        .route("/healthz", get(healthz))
        .route("/fleet", get(fleet::fleet))
        .merge(serve::router(&cfg.objects_dir()))
        .merge(upload_routes)
        .merge(admin_routes)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}
