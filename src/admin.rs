use std::fmt::Write as _;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use crate::storage::{self, Upload};
use crate::AppState;

const PAGE_SIZE: i64 = 50;

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    pub(crate) page: Option<i64>,
}

pub(crate) async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let page = q.page.unwrap_or(1).max(1);
    let offset = (page - 1) * PAGE_SIZE;

    let total = match storage::count_uploads(&state.pool).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "count failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    let rows = match storage::list_uploads(&state.pool, PAGE_SIZE, offset).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "list failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    let html = render_admin_page(&rows, page, total, PAGE_SIZE);

    let mut resp = (StatusCode::OK, html).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut().insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        ),
    );
    resp
}

pub(crate) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if !is_safe_id(&id) {
        return (StatusCode::BAD_REQUEST, "bad id").into_response();
    }

    let row = match storage::get_by_id(&state.pool, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return (StatusCode::NOT_FOUND, "not found").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    if let Err(e) = storage::delete_object(&state.config.objects_dir(), &row.id, &row.ext).await {
        tracing::error!(error = %e, id = %row.id, "object delete failed");
    }

    if let Err(e) = storage::delete_by_id(&state.pool, &row.id).await {
        tracing::error!(error = %e, "db delete failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
    }

    Redirect::to("/admin").into_response()
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 16
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn render_admin_page(rows: &[Upload], page: i64, total: i64, page_size: i64) -> String {
    let pages = (total + page_size - 1).max(1) / page_size.max(1);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);

    let mut body = String::with_capacity(2048 + rows.len() * 256);
    body.push_str(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>imghost admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.4 system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; }
h1 { font-size: 1.2em; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid #ccc4; text-align: left; vertical-align: middle; }
th { font-weight: 600; }
img.thumb { width: 64px; height: 64px; object-fit: cover; background: #8884; border-radius: 4px; }
code { font-family: ui-monospace, monospace; font-size: 12px; }
button, .btn { font: inherit; padding: 4px 10px; border: 1px solid #8884; background: transparent; border-radius: 4px; cursor: pointer; }
button:hover, .btn:hover { background: #8881; }
.actions form { display: inline; }
.danger { color: #b22; border-color: #b224; }
.pager { margin: 1em 0; display: flex; gap: 1em; align-items: center; }
.empty { padding: 2em; text-align: center; color: #888; }
</style></head><body>"#,
    );

    let _ = write!(
        body,
        "<h1>imghost — {total} upload{}</h1>",
        if total == 1 { "" } else { "s" }
    );

    if rows.is_empty() {
        body.push_str(r#"<p class="empty">No uploads yet.</p>"#);
    } else {
        body.push_str(
            "<table><thead><tr>\
<th></th><th>id</th><th>mime</th><th>size</th><th>uploaded</th><th>actions</th>\
</tr></thead><tbody>",
        );

        for u in rows {
            let url_path = format!("/i/{}.{}", u.id, u.ext);
            let size = format_size(u.size_bytes);
            let rel = relative_time(now - u.uploaded_at);
            let _ = write!(
                body,
                r#"<tr>
<td><img class="thumb" loading="lazy" width="64" height="64" src="{url}" alt=""></td>
<td><a href="{url}"><code>{id}</code></a></td>
<td><code>{mime}</code></td>
<td>{size}</td>
<td title="unix {at}">{rel}</td>
<td class="actions">
<button class="btn" data-url="{url}" onclick="navigator.clipboard.writeText(this.dataset.url);this.textContent='Copied';setTimeout(()=>this.textContent='Copy URL',1200)">Copy URL</button>
<form method="POST" action="/admin/delete/{id}" onsubmit="return confirm('Delete {id}?')">
<button class="btn danger" type="submit">Delete</button>
</form>
</td></tr>"#,
                url = html_escape(&url_path),
                id = html_escape(&u.id),
                mime = html_escape(&u.mime),
                size = html_escape(&size),
                at = u.uploaded_at,
                rel = html_escape(&rel),
            );
        }
        body.push_str("</tbody></table>");

        body.push_str(r#"<div class="pager">"#);
        if page > 1 {
            let _ = write!(
                body,
                r#"<a class="btn" href="?page={}">&larr; prev</a>"#,
                page - 1
            );
        }
        let _ = write!(body, "<span>page {page} / {pages}</span>");
        if page < pages {
            let _ = write!(
                body,
                r#"<a class="btn" href="?page={}">next &rarr;</a>"#,
                page + 1
            );
        }
        body.push_str("</div>");
    }

    body.push_str("</body></html>");
    body
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn format_size(b: i64) -> String {
    let b = b.max(0) as f64;
    if b < 1024.0 {
        format!("{} B", b as i64)
    } else if b < 1024.0 * 1024.0 {
        format!("{:.1} KB", b / 1024.0)
    } else {
        format!("{:.2} MB", b / (1024.0 * 1024.0))
    }
}

fn relative_time(secs_ago: i64) -> String {
    let s = secs_ago.max(0);
    if s < 60 {
        format!("{s}s ago")
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else if s < 86_400 {
        format!("{}h ago", s / 3600)
    } else {
        format!("{}d ago", s / 86_400)
    }
}
