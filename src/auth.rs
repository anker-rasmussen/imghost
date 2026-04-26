use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use subtle::ConstantTimeEq;

use crate::AppState;

/// Bearer-token guard for `POST /upload`. Compares in constant time.
pub(crate) async fn require_bearer(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let header_val = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let provided = header_val.strip_prefix("Bearer ").unwrap_or("");
    let expected = state.config.upload_token.as_bytes();

    if provided.is_empty() || provided.as_bytes().ct_eq(expected).unwrap_u8() == 0 {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    next.run(request).await
}

/// HTTP Basic guard for `/admin*`. Issues `WWW-Authenticate` on failure.
pub(crate) async fn require_basic(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Basic "))
    {
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(auth.trim()) {
            if let Ok(s) = std::str::from_utf8(&decoded) {
                if let Some((user, pass)) = s.split_once(':') {
                    let user_ok = user
                        .as_bytes()
                        .ct_eq(state.config.admin_user.as_bytes())
                        .unwrap_u8()
                        == 1;
                    let pass_ok = pass
                        .as_bytes()
                        .ct_eq(state.config.admin_pass.as_bytes())
                        .unwrap_u8()
                        == 1;
                    if user_ok && pass_ok {
                        return next.run(request).await;
                    }
                }
            }
        }
    }

    let mut resp = (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    resp.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"imghost\""),
    );
    resp
}
