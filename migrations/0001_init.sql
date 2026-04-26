CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    ext TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    original_filename TEXT,
    uploaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_uploaded_at ON uploads(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_sha256 ON uploads(sha256);
