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

use std::time::Duration;
use tokio::net::lookup_host;
use tokio::task::JoinSet;
use tokio::time::timeout;

const FLEET: &[&str] = &["defcom", "mincom", "centcom", "flightcom"];
const SELF_HOST: &str = "mincom";
// LAN + Tailscale resolves in single-digit ms; 250ms fails fast on
// silent drops without false negatives on a healthy resolver.
const PROBE_TIMEOUT: Duration = Duration::from_millis(250);

pub(crate) async fn fleet() -> String {
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
