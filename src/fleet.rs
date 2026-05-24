//! `/fleet` — probes the LAN fleet via TCP-connect to SSH (:22) and returns a
//! tiny line-delimited body. Designed for tools that can't do TLS (an ESP32
//! at the office checking on home machines, etc.). Hostnames are resolved
//! by whichever resolver the host process uses, so this code stays portable
//! across re-IP'd machines.

use std::time::Duration;
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::timeout;

const FLEET: &[&str] = &["defcom", "mincom", "centcom", "flightcom"];
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) async fn fleet() -> String {
    let mut set = JoinSet::new();
    for &name in FLEET {
        set.spawn(async move {
            let up = timeout(PROBE_TIMEOUT, TcpStream::connect(format!("{name}:22")))
                .await
                .is_ok_and(|r| r.is_ok());
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
