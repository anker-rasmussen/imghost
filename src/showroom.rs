use std::path::Path;

use axum::http::{header, HeaderName, HeaderValue};
use axum::response::Redirect;
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::AppState;

/// CSP for the static WebGL showroom. Everything is self-hosted except Google Fonts. `wasm-unsafe-eval` lets the
/// vendored meshopt decoder compile its WASM; the one inline script is the import map, pinned by hash.
const SHOWROOM_CSP: &str = "default-src 'none'; \
    script-src 'self' 'wasm-unsafe-eval' 'sha256-GrYJXwxye0I3hzyc7iEYb0SjdRcHNaWy7DM+OgwzKR4='; \
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
    font-src https://fonts.gstatic.com; \
    img-src 'self' blob: data:; \
    connect-src 'self' blob: data:; \
    media-src 'self'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Mount `GET /showroom/*`: a static, read-only portfolio page (three.js ship viewer) served from `dir`.
/// `ServeDir` blocks `..` and absolute paths internally. `/showroom` redirects to the trailing-slash URL so the
/// page's relative asset paths resolve.
pub(crate) fn router(dir: &Path) -> Router<AppState> {
    let serve = ServeDir::new(dir).append_index_html_on_directories(true);

    Router::new()
        .route(
            "/showroom",
            get(|| async { Redirect::permanent("/showroom/") }),
        )
        .nest_service("/showroom/", serve)
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(SHOWROOM_CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
}
