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
        showroom_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static/showroom"),
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
        .header("origin", "http://localhost")
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
// 13b. POST /admin/delete/:id with foreign or missing Origin — 403 (CSRF guard)
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_admin_delete_csrf_blocked() {
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
    let id = upload["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .split('.')
        .next()
        .unwrap()
        .to_string();

    // Foreign Origin: rejected.
    let res = client()
        .post(format!("{base}/admin/delete/{id}"))
        .basic_auth("admin", Some("secret"))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    // No Origin at all: also rejected.
    let res = client()
        .post(format!("{base}/admin/delete/{id}"))
        .basic_auth("admin", Some("secret"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
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

#[tokio::test]
async fn test_showroom_served_with_csp() {
    let (base, _tmp) = spawn_app(1024).await;
    let c = client();

    // bare path redirects to the trailing-slash index so relative assets resolve
    let r = c
        .get(format!("{base}/showroom"))
        .send()
        .await
        .expect("send");
    assert_eq!(r.status(), 308);

    let r = c
        .get(format!("{base}/showroom/"))
        .send()
        .await
        .expect("send");
    assert_eq!(r.status(), 200);
    let csp = r.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));
    assert!(r.text().await.unwrap().contains("Aurelia"));

    // the edge caches static files for hours: every `?v=<hash>` URL in the page, its modules, stylesheets and the
    // generated asset manifest must match the file's content hash (`make showroom-stamp` / `make showroom`)
    let site = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/static/showroom"));
    let mut sources = vec![site.join("index.html")];
    for dir in ["js", "css"] {
        for e in std::fs::read_dir(site.join(dir)).unwrap() {
            sources.push(e.unwrap().path());
        }
    }
    let mut checked = 0;
    for src in &sources {
        let text = std::fs::read_to_string(src).unwrap();
        for (i, _) in text.match_indices("?v=") {
            let start = text[..i]
                .rfind(['"', '\'', '(', ' ', '\n'])
                .map_or(0, |s| s + 1);
            let rel = &text[start..i];
            let want = &text[i + 3..i + 19];
            // "./x" and "../x" resolve against the referencing file; bare paths against the site root
            let path = if rel.starts_with("./") || rel.starts_with("../") {
                src.parent().unwrap().join(rel)
            } else {
                site.join(rel)
            };
            let bytes =
                std::fs::read(&path).unwrap_or_else(|_| panic!("{}: missing {rel}", src.display()));
            let got = &hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes))[..16];
            assert_eq!(
                want,
                got,
                "stale stamp for {rel} in {}: run `make showroom-stamp`",
                src.display()
            );
            checked += 1;
        }
    }
    assert!(checked > 20, "expected the showroom to stamp its assets");

    let r = c
        .get(format!("{base}/showroom/js/main.js"))
        .send()
        .await
        .expect("send");
    assert_eq!(r.status(), 200);

    // ServeDir must not escape the showroom directory
    let r = c
        .get(format!("{base}/showroom/../Cargo.toml"))
        .send()
        .await
        .expect("send");
    assert_ne!(r.status(), 200);
}

/// Send a request line verbatim (HTTP clients normalise `..` away before it reaches the server).
async fn raw_get(base: &str, path: &str) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let addr = base.trim_start_matches("http://");
    let mut s = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.expect("write");
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.expect("read");
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_lowercase(), body.to_string())
}

#[tokio::test]
async fn test_showroom_static_serving_is_inert() {
    let (base, _tmp) = spawn_app(1024).await;

    // path traversal, raw and percent-encoded, must never reach files outside static/showroom
    for p in [
        "/showroom/../Cargo.toml",
        "/showroom/%2e%2e/Cargo.toml",
        "/showroom/%2E%2E/Cargo.toml",
        "/showroom/..%2fCargo.toml",
        "/showroom/%2e%2e%2fCargo.toml",
        "/showroom/js/..%2f..%2f..%2fCargo.toml",
        "/showroom/%252e%252e/Cargo.toml",
        "/showroom/..\\Cargo.toml",
        "/showroom/%2e%2e%5cCargo.toml",
        "/showroom//etc/passwd",
    ] {
        let (status, _, body) = raw_get(&base, p).await;
        assert_ne!(status, 200, "{p} was served");
        assert!(
            !body.contains("[package]") && !body.contains("root:"),
            "{p} leaked a file"
        );
    }

    // no directory listings
    let (status, _, body) = raw_get(&base, "/showroom/assets/").await;
    assert_ne!(status, 200);
    assert!(!body.contains("href="), "directory listing");

    // assets are data, typed correctly and never sniffed into something executable
    for (p, ct) in [
        (
            "/showroom/vendor/three/addons/libs/basis/basis_transcoder.wasm",
            "application/wasm",
        ),
        (
            "/showroom/vendor/three/addons/libs/basis/ktx2_inline.js",
            "text/javascript",
        ),
        ("/showroom/js/main.js", "text/javascript"),
    ] {
        let (status, head, _) = raw_get(&base, p).await;
        assert_eq!(status, 200, "{p}");
        assert!(head.contains(&format!("content-type: {ct}")), "{p}: {head}");
        assert!(
            head.contains("x-content-type-options: nosniff"),
            "{p}: {head}"
        );
        // the worker inherits its own response CSP: same strict policy, no new origins
        assert!(
            head.contains("script-src 'self' 'wasm-unsafe-eval'"),
            "{p}: {head}"
        );
        assert!(
            !head.contains("blob:") || !head.contains("worker-src"),
            "{p}: worker-src widened"
        );
    }
}

#[tokio::test]
async fn test_showroom_cache_policy() {
    let (base, _tmp) = spawn_app(1024).await;
    let c = client();
    let cc = |r: &reqwest::Response| {
        r.headers()["cache-control"].to_str().unwrap().to_string()
    };
    let site = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/static/showroom"));
    let bytes = std::fs::read(site.join("js/util.js")).unwrap();
    let good = &hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes))[..16];

    // a content-hashed URL whose hash matches the file: cached for a year, never revalidated
    let r = c.get(format!("{base}/showroom/js/util.js?v={good}")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(cc(&r), "public, max-age=31536000, immutable");

    // a wrong / stale / malformed hash, no hash, the page itself, traversal tricks: short-lived only
    for url in [
        "/showroom/js/util.js?v=0000000000000000".to_string(),
        "/showroom/js/util.js?v=ZZZZ".to_string(),
        "/showroom/js/util.js".to_string(),
        "/showroom/".to_string(),
        "/showroom/index.html".to_string(),
        format!("/showroom/js/%75til.js?v={good}"),
    ] {
        let r = c.get(format!("{base}{url}")).send().await.unwrap();
        assert_eq!(cc(&r), "public, max-age=300", "{url}");
    }
}
