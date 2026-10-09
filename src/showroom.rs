use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::{Redirect, Response};
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
    font-src 'self' https://fonts.gstatic.com; \
    img-src 'self' blob: data:; \
    connect-src 'self' blob: data:; \
    media-src 'self'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Mount `GET /showroom/*`: a static, read-only portfolio page (three.js ship viewer) served from `dir`.
/// `ServeDir` blocks `..` and absolute paths internally. `/showroom` redirects to the trailing-slash URL so the
/// page's relative asset paths resolve.
pub(crate) fn router(dir: &Path) -> Router<AppState> {
    let serve = ServeDir::new(dir).append_index_html_on_directories(true);
    let hashes = Arc::new(Hashes { root: dir.to_path_buf(), seen: Mutex::new(HashMap::new()) });

    Router::new()
        .route(
            "/showroom",
            get(|| async { Redirect::permanent("/showroom/") }),
        )
        .nest_service("/showroom/", serve)
        .layer(axum::middleware::from_fn(move |req: Request, next: Next| {
            let hashes = hashes.clone();
            async move { cache_policy(hashes, req, next).await }
        }))
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

/// Content hashes of served files, keyed by path and invalidated by mtime.
struct Hashes {
    root: PathBuf,
    seen: Mutex<HashMap<PathBuf, (SystemTime, String)>>,
}

/// Long-lived and immutable when the URL carries `?v=<sha256[:16]>` *and* that hash matches the file being served
/// (so a stale or forged hash never pins old or wrong content in a cache); everything else (the page itself,
/// unstamped URLs) revalidates after five minutes.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const SHORT: &str = "public, max-age=300";

async fn cache_policy(hashes: Arc<Hashes>, req: Request, next: Next) -> Response {
    let want = req.uri().query().and_then(|q| {
        q.split('&').find_map(|kv| kv.strip_prefix("v=")).filter(|v| {
            v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
    });
    let file = want.and_then(|_| safe_rel(req.uri().path()).map(|rel| hashes.root.join(rel)));
    let want = want.map(str::to_owned);
    let mut res = next.run(req).await;
    let immutable = match (want, file) {
        (Some(want), Some(file)) if res.status().is_success() => {
            let h = hashes.clone();
            tokio::task::spawn_blocking(move || h.matches(&file, &want))
                .await
                .unwrap_or(false)
        }
        _ => false,
    };
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { IMMUTABLE } else { SHORT }),
    );
    res
}

/// `/showroom/js/x.js` -> `js/x.js`, only for plain relative paths (no `..`, `.`, empty or encoded segments):
/// anything else simply gets the short policy (`ServeDir` does its own, stricter, path handling for the body).
fn safe_rel(path: &str) -> Option<PathBuf> {
    let rel = path.strip_prefix("/showroom/")?;
    if rel.is_empty() || rel.contains(['%', '\\', '\0']) {
        return None;
    }
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

impl Hashes {
    fn matches(&self, file: &Path, want: &str) -> bool {
        let Ok(meta) = std::fs::metadata(file) else { return false };
        if !meta.is_file() {
            return false;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if let Some((m, h)) = self.seen.lock().map(|s| s.get(file).cloned()).ok().flatten() {
            if m == mtime {
                return h == want;
            }
        }
        let Ok(bytes) = std::fs::read(file) else { return false };
        let h = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes))[..16].to_owned();
        let ok = h == want;
        if let Ok(mut s) = self.seen.lock() {
            s.insert(file.to_path_buf(), (mtime, h));
        }
        ok
    }
}
