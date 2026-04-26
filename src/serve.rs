use std::path::Path;

use axum::http::{header, HeaderName, HeaderValue};
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::AppState;

/// Mount `GET /i/:name` serving files from `objects_dir` with hardened response headers.
/// `ServeDir` blocks `..` and absolute paths internally.
pub(crate) fn router(objects_dir: &Path) -> Router<AppState> {
    let serve = ServeDir::new(objects_dir).append_index_html_on_directories(false);

    Router::new()
        .nest_service("/i", serve)
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("inline"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("default-src 'none'; sandbox"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
}
