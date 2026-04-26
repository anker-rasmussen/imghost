use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::storage::{self, Upload};
use crate::AppState;

const ALLOWED_MIMES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/avif", "avif"),
];

/// Body limit is enforced upstream by `DefaultBodyLimit`. We only see <= max here.
pub(crate) async fn upload(State(state): State<AppState>, body: Bytes) -> Response {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty body").into_response();
    }

    // Sniff mime from bytes — never trust the client.
    let Some(kind) = infer::get(&body) else {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unrecognized file type").into_response();
    };

    let mime_str = kind.mime_type();
    let ext = match ALLOWED_MIMES.iter().find(|(m, _)| *m == mime_str) {
        Some((_, e)) => *e,
        None => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                format!("mime {mime_str} is not allowed"),
            )
                .into_response()
        }
    };

    let mut hasher = Sha256::new();
    hasher.update(&body);
    let sha_hex = hex::encode(hasher.finalize());

    // Dedupe.
    match storage::find_by_sha256(&state.pool, &sha_hex).await {
        Ok(Some(existing)) => {
            let url = format!(
                "{}/i/{}.{}",
                state.config.public_base_url, existing.id, existing.ext
            );
            return Json(json!({ "url": url, "deduped": true })).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!(error = %e, "dedupe lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    }

    let id = nanoid::nanoid!(8);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    if let Err(e) =
        storage::atomic_write_object(&state.config.objects_dir(), &id, ext, &body).await
    {
        tracing::error!(error = %e, "object write failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, "write failed").into_response();
    }

    let row = Upload {
        id: id.clone(),
        ext: ext.to_string(),
        mime: mime_str.to_string(),
        size_bytes: body.len() as i64,
        sha256: sha_hex,
        original_filename: None,
        uploaded_at: now,
    };

    if let Err(e) = storage::insert_upload(&state.pool, &row).await {
        tracing::error!(error = %e, "db insert failed");
        let _ = storage::delete_object(&state.config.objects_dir(), &id, ext).await;
        return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
    }

    let url = format!("{}/i/{}.{}", state.config.public_base_url, id, ext);
    Json(json!({ "url": url, "deduped": false })).into_response()
}
