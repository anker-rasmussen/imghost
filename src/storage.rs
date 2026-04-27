use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub(crate) static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct Upload {
    pub(crate) id: String,
    pub(crate) ext: String,
    pub(crate) mime: String,
    pub(crate) size_bytes: i64,
    pub(crate) sha256: String,
    pub(crate) original_filename: Option<String>,
    pub(crate) uploaded_at: i64,
}

pub async fn init_pool(db_path: &Path, objects_dir: &Path) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::create_dir_all(objects_dir).await?;

    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;

    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

pub(crate) async fn find_by_sha256(pool: &SqlitePool, sha: &str) -> sqlx::Result<Option<Upload>> {
    sqlx::query_as::<_, Upload>("SELECT id, ext, mime, size_bytes, sha256, original_filename, uploaded_at FROM uploads WHERE sha256 = ? LIMIT 1")
        .bind(sha)
        .fetch_optional(pool)
        .await
}

pub(crate) async fn insert_upload(pool: &SqlitePool, u: &Upload) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO uploads (id, ext, mime, size_bytes, sha256, original_filename, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&u.id)
    .bind(&u.ext)
    .bind(&u.mime)
    .bind(u.size_bytes)
    .bind(&u.sha256)
    .bind(&u.original_filename)
    .bind(u.uploaded_at)
    .execute(pool)
    .await
    .map(|_| ())
}

pub(crate) async fn list_uploads(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Upload>> {
    sqlx::query_as::<_, Upload>(
        "SELECT id, ext, mime, size_bytes, sha256, original_filename, uploaded_at FROM uploads ORDER BY uploaded_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub(crate) async fn count_uploads(pool: &SqlitePool) -> sqlx::Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM uploads")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub(crate) async fn stats_summary(pool: &SqlitePool) -> sqlx::Result<(i64, i64, Option<i64>)> {
    let row: (i64, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0), MAX(uploaded_at) FROM uploads",
    )
    .fetch_one(pool)
    .await?;
    Ok((row.0, row.1.unwrap_or(0), row.2))
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct RecentEntry {
    pub(crate) mime: String,
    pub(crate) size_bytes: i64,
    pub(crate) uploaded_at: i64,
}

pub(crate) async fn recent_anonymized(
    pool: &SqlitePool,
    limit: i64,
) -> sqlx::Result<Vec<RecentEntry>> {
    sqlx::query_as::<_, RecentEntry>(
        "SELECT mime, size_bytes, uploaded_at FROM uploads ORDER BY uploaded_at DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub(crate) async fn get_by_id(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Upload>> {
    sqlx::query_as::<_, Upload>("SELECT id, ext, mime, size_bytes, sha256, original_filename, uploaded_at FROM uploads WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub(crate) async fn delete_by_id(pool: &SqlitePool, id: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM uploads WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Atomically write `bytes` to `objects_dir/<id>.<ext>` via a temp file + rename.
pub(crate) async fn atomic_write_object(
    objects_dir: &Path,
    id: &str,
    ext: &str,
    bytes: &[u8],
) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(objects_dir).await?;
    let final_path = objects_dir.join(format!("{id}.{ext}"));
    let tmp_path = objects_dir.join(format!("{id}.{ext}.tmp"));

    let mut f = fs::File::create(&tmp_path).await?;
    f.write_all(bytes).await?;
    f.sync_all().await?;
    drop(f);

    fs::rename(&tmp_path, &final_path).await?;
    Ok(final_path)
}

pub(crate) async fn delete_object(objects_dir: &Path, id: &str, ext: &str) -> anyhow::Result<()> {
    let path = objects_dir.join(format!("{id}.{ext}"));
    match fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
