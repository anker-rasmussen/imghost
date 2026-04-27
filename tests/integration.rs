/// Integration tests for imghost.
///
/// Each test spawns the app on a kernel-assigned port with an isolated temp
/// directory, so tests are fully independent and can run in parallel.
use std::net::SocketAddr;
use std::sync::Arc;

use imghost::{build_app, config::AppConfig, storage, AppState};
use tempfile::TempDir;

// Minimal 1×1 red PNG (67 bytes). Well-known byte sequence.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk len + type
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB, CRC
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed 1 red pixel
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // CRC
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82, // IEND CRC
];

/// Construct an isolated app and return `(base_url, _tmp_guard)`.
/// The `TempDir` must be kept alive for the duration of the test.
async fn spawn_app(max_upload_bytes: usize) -> (String, TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();

    let cfg = Arc::new(AppConfig {
        bind_addr: "127.0.0.1:0".parse().expect("addr"),
        data_dir: data_dir.clone(),
        upload_token: "test-token".to_string(),
        admin_user: "admin".to_string(),
        admin_pass: "secret".to_string(),
        public_base_url: "http://localhost".to_string(),
        max_upload_bytes,
    });

    let pool = storage::init_pool(&cfg.db_path(), &cfg.objects_dir())
        .await
        .expect("init_pool");

    let state = AppState {
        config: cfg,
        pool,
        started_at: std::time::Instant::now(),
    };
    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("local_addr");

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    (format!("http://127.0.0.1:{}", addr.port()), tmp)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

// ---------------------------------------------------------------------------
// 1. Upload happy path
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_happy_path() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .header("content-type", "image/png")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert!(body["url"].is_string(), "missing url");
    assert_eq!(body["deduped"], false);
}

// ---------------------------------------------------------------------------
// 2. Upload dedupe
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_dedupe() {
    let (base, _tmp) = spawn_app(26_214_400).await;

    let first: serde_json::Value = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["deduped"], false);

    let second: serde_json::Value = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(second["deduped"], true);
    assert_eq!(first["url"], second["url"]);
}

// ---------------------------------------------------------------------------
// 3. Upload missing auth
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_missing_auth() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .post(format!("{base}/upload"))
        .body(TINY_PNG)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

// ---------------------------------------------------------------------------
// 4. Upload wrong bearer
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_wrong_bearer() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("wrong-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

// ---------------------------------------------------------------------------
// 5. Upload empty body
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_empty_body() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(vec![])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

// ---------------------------------------------------------------------------
// 6. Upload disallowed MIME
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_disallowed_mime() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    // Plain ASCII text — infer cannot classify it as an image.
    let text = b"Hello, this is just plain text and not an image file at all.";
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(text.as_ref())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 415);
}

// ---------------------------------------------------------------------------
// 7. Upload too large
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_upload_too_large() {
    // Set a tiny limit so we can exceed it without a big payload.
    let (base, _tmp) = spawn_app(256).await;
    // TINY_PNG is 69 bytes; pad it to 300 bytes with garbage after the PNG.
    let big: Vec<u8> = vec![0u8; 300];
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(big)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);
}

// ---------------------------------------------------------------------------
// 8. GET /i/<id>.png after upload — 200 + security headers
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_serve_after_upload() {
    let (base, _tmp) = spawn_app(26_214_400).await;

    let upload: serde_json::Value = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // The URL in the response uses public_base_url ("http://localhost"), so
    // reconstruct the path portion and use our actual test base.
    let url_str = upload["url"].as_str().unwrap();
    let path = url_str.trim_start_matches("http://localhost").to_string();
    let serve_url = format!("{base}{path}");

    let res = client().get(&serve_url).send().await.unwrap();
    assert_eq!(res.status(), 200);

    let headers = res.headers();

    let ct = headers.get("content-type").unwrap().to_str().unwrap();
    assert!(ct.contains("image/png"), "unexpected content-type: {ct}");

    assert_eq!(
        headers.get("cache-control").unwrap().to_str().unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        headers
            .get("x-content-type-options")
            .unwrap()
            .to_str()
            .unwrap(),
        "nosniff"
    );
    assert_eq!(
        headers
            .get("content-disposition")
            .unwrap()
            .to_str()
            .unwrap(),
        "inline"
    );
    assert_eq!(
        headers
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap(),
        "default-src 'none'; sandbox"
    );
    assert_eq!(
        headers.get("referrer-policy").unwrap().to_str().unwrap(),
        "no-referrer"
    );
}

// ---------------------------------------------------------------------------
// 9. GET /i/<bogus>.png — 404
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_serve_bogus() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .get(format!("{base}/i/doesnotexist.png"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

// ---------------------------------------------------------------------------
// 10. /admin without auth — 401 + WWW-Authenticate header
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_admin_no_auth() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client().get(format!("{base}/admin")).send().await.unwrap();
    assert_eq!(res.status(), 401);
    let www_auth = res
        .headers()
        .get("www-authenticate")
        .expect("missing WWW-Authenticate header")
        .to_str()
        .unwrap();
    assert_eq!(www_auth, "Basic realm=\"imghost\"");
}

// ---------------------------------------------------------------------------
// 11. /admin with wrong basic — 401
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_admin_wrong_basic() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .get(format!("{base}/admin"))
        .basic_auth("admin", Some("wrongpass"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

// ---------------------------------------------------------------------------
// 12. /admin with right basic — 200, body contains uploaded id
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_admin_right_basic() {
    let (base, _tmp) = spawn_app(26_214_400).await;

    // Upload something first.
    let upload: serde_json::Value = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Extract the id from the URL path segment.
    let url_str = upload["url"].as_str().unwrap();
    // e.g. "http://localhost/i/abcd1234.png"
    let filename = url_str.rsplit('/').next().unwrap(); // "abcd1234.png"
    let id = filename.split('.').next().unwrap(); // "abcd1234"

    let res = client()
        .get(format!("{base}/admin"))
        .basic_auth("admin", Some("secret"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let body = res.text().await.unwrap();
    assert!(body.contains(id), "admin page missing id={id}");
}

// ---------------------------------------------------------------------------
// 13. POST /admin/delete/:id — redirect + subsequent GET is 404
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_admin_delete() {
    let (base, _tmp) = spawn_app(26_214_400).await;

    // Upload a file.
    let upload: serde_json::Value = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .body(TINY_PNG)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let url_str = upload["url"].as_str().unwrap();
    let path = url_str.trim_start_matches("http://localhost").to_string();
    let filename = url_str.rsplit('/').next().unwrap();
    let id = filename.split('.').next().unwrap();

    // Delete via admin endpoint.
    let del = client()
        .post(format!("{base}/admin/delete/{id}"))
        .basic_auth("admin", Some("secret"))
        .send()
        .await
        .unwrap();
    // Expect a redirect (303 / 302).
    assert!(
        del.status().is_redirection(),
        "expected redirect, got {}",
        del.status()
    );

    // File should now be gone.
    let serve_url = format!("{base}{path}");
    let res = client().get(&serve_url).send().await.unwrap();
    assert_eq!(res.status(), 404);
}

// ---------------------------------------------------------------------------
// 14. /healthz — 200 "ok"
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_healthz() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client()
        .get(format!("{base}/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "ok");
}

// ---------------------------------------------------------------------------
// 15. /  — landing page, public, html, edge-cacheable, snapshot baked in
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_index_empty_db() {
    let (base, _tmp) = spawn_app(26_214_400).await;
    let res = client().get(&base).send().await.unwrap();
    assert_eq!(res.status(), 200);

    let headers = res.headers().clone();
    let ctype = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(ctype.starts_with("text/html"), "content-type: {ctype}");

    let cc = headers
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(cc.contains("max-age=300"), "cache-control: {cc}");
    assert!(cc.contains("s-maxage=300"), "cache-control: {cc}");

    let csp = headers
        .get("content-security-policy")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(csp.contains("default-src 'none'"), "csp: {csp}");

    let body = res.text().await.unwrap();
    assert!(body.contains("imghost"));
    // SNAPSHOT block must be inlined and well-formed for an empty db.
    assert!(body.contains("count: 0"));
    assert!(body.contains("bytes: 0"));
    assert!(body.contains("lastAt: null"));
    assert!(body.contains("recent: []"));
}

#[tokio::test]
async fn test_index_after_upload() {
    let (base, _tmp) = spawn_app(26_214_400).await;

    // upload one png so the snapshot has real data
    let res = client()
        .post(format!("{base}/upload"))
        .bearer_auth("test-token")
        .header("content-type", "image/png")
        .body(TINY_PNG.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let res = client().get(&base).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body = res.text().await.unwrap();
    assert!(body.contains("count: 1"), "expected count: 1 in body");
    assert!(
        body.contains("\"mime\":\"image/png\""),
        "expected anonymized recent entry to contain image/png mime"
    );
    // the anonymized feed must NOT leak the upload id.
    assert!(
        !body.contains("\"id\":"),
        "anonymized feed should not include any id field"
    );
}
