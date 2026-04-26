use std::sync::Arc;

use imghost::{build_app, storage, AppState};

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

    let cfg = Arc::new(imghost::config::AppConfig::from_env()?);
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

    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
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
