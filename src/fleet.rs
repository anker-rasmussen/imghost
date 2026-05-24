//! `/fleet` — reports the LAN fleet status as a tiny line-delimited body
//! (`defcom=up\nmincom=up\n…`). Designed for tools that can't do TLS,
//! e.g. an ESP32 polling from a hostile network.
//!
//! Self (`SELF_HOST`) is always reported up — if a response came back,
//! it's up. Others are checked by DNS resolution through the host's
//! resolver: if the name resolves, the box is reachable enough to call
//! "up". TCP-probing from inside the container is unreliable because the
//! bridge → host-LAN path is silently dropped by the host firewall, so
//! DNS is the strongest signal available without changing the network
//! posture of the container.
//!
//! Results are cached for `CACHE_TTL` so a 1Hz poller doesn't trigger
//! four DNS lookups per request; the `Cache-Control` header lets CF
//! edge-cache for the same window.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::net::lookup_host;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio::time::timeout;

const FLEET: &[&str] = &["defcom", "mincom", "centcom", "flightcom"];
const SELF_HOST: &str = "mincom";
// LAN + Tailscale resolves in single-digit ms; 250ms fails fast on
// silent drops without false negatives on a healthy resolver.
const PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const CACHE_TTL: Duration = Duration::from_secs(10);

struct Snapshot {
    body: String,
    at: Instant,
}

static CACHE: OnceLock<Mutex<Option<Snapshot>>> = OnceLock::new();

pub(crate) async fn fleet() -> Response {
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    {
        let guard = cache.lock().await;
        if let Some(snap) = guard.as_ref() {
            if snap.at.elapsed() < CACHE_TTL {
                return respond(snap.body.clone());
            }
        }
    }

    // Re-check under the write lock — a sibling task may have refreshed
    // while we were waiting, in which case there's nothing left to do.
    let mut guard = cache.lock().await;
    if let Some(snap) = guard.as_ref() {
        if snap.at.elapsed() < CACHE_TTL {
            return respond(snap.body.clone());
        }
    }
    let body = probe().await;
    *guard = Some(Snapshot {
        body: body.clone(),
        at: Instant::now(),
    });
    respond(body)
}

async fn probe() -> String {
    let mut set = JoinSet::new();
    for &name in FLEET {
        set.spawn(async move {
            let up = name == SELF_HOST
                || timeout(PROBE_TIMEOUT, lookup_host(format!("{name}:22")))
                    .await
                    .is_ok_and(|r| r.is_ok_and(|mut a| a.next().is_some()));
            (name, up)
        });
    }
    let mut results: Vec<(&str, bool)> = Vec::with_capacity(FLEET.len());
    while let Some(Ok(r)) = set.join_next().await {
        results.push(r);
    }
    let mut out = String::with_capacity(96);
    for name in FLEET {
        let up = results.iter().any(|(n, u)| n == name && *u);
        out.push_str(name);
        out.push('=');
        out.push_str(if up { "up\n" } else { "down\n" });
    }
    out
}

fn respond(body: String) -> Response {
    let mut resp = (StatusCode::OK, body).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=10, s-maxage=10, stale-while-revalidate=30"),
    );
    resp
}
