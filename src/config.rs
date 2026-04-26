use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub bind_addr: SocketAddr,
    pub data_dir: PathBuf,
    pub upload_token: String,
    pub admin_user: String,
    pub admin_pass: String,
    pub public_base_url: String,
    pub max_upload_bytes: usize,
}

impl AppConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid BIND_ADDR: {e}"))?;

        let data_dir =
            PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/var/lib/imghost".to_string()));

        let upload_token = require_env("UPLOAD_TOKEN")?;
        let admin_user = env::var("ADMIN_USER").unwrap_or_else(|_| "admin".to_string());
        let admin_pass = require_env("ADMIN_PASS")?;
        let public_base_url = require_env("PUBLIC_BASE_URL")?
            .trim_end_matches('/')
            .to_string();

        let max_upload_bytes = env::var("MAX_UPLOAD_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(26_214_400);

        Ok(Self {
            bind_addr,
            data_dir,
            upload_token,
            admin_user,
            admin_pass,
            public_base_url,
            max_upload_bytes,
        })
    }

    pub fn objects_dir(&self) -> PathBuf {
        self.data_dir.join("objects")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("imghost.db")
    }
}

fn require_env(name: &str) -> anyhow::Result<String> {
    env::var(name).map_err(|_| anyhow::anyhow!("required env var {name} is not set"))
}
