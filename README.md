# imghost

A single-user, self-hosted screenshot host.

- Hotkey on Arch Linux → region capture → public URL on the clipboard.
- Rust + axum origin in a hardened distroless container on a homelab box.
- **Cloudflare Tunnel** for ingress (no port forward, TLS at the edge).
- **Cloudflare Access** in front of `POST /upload` (service token) and `/admin*`
  (IdP login). Only `GET /i/:name` and `/healthz` are publicly reachable.
- Public domain: **`aigf.dev`**.

```
hotkey → flameshot/grim/maim → curl(POST /upload) → CF Access → CF Tunnel
                                                                   ↓
                                                           container :8080
                                                                   ↓
                                                            sqlite + fs volume
```

## Threat model — short version

| # | Threat | Mitigation |
|---|---|---|
| T1 | Unauthorized upload | CF Access service token + app-layer bearer (defense in depth). |
| T2 | Unauthorized admin | CF Access IdP login + app-layer HTTP Basic. |
| T3 | Path traversal on `/i/*` | `tower-http::ServeDir` rejects `..` and absolute paths. |
| T4 | Large/slow uploads | 25 MB cap (`DefaultBodyLimit`) + 30 s timeout + Cloudflare WAF rate-limit. |
| T5 | Stored XSS / mime confusion | Mime allowlist (no SVG/HTML), `infer` magic-byte sniff, `CSP: default-src 'none'; sandbox`, `nosniff`, `Content-Disposition: inline` on `/i/*`. |
| T6 | Token leakage | Client `~/.config/imghost/env` and host `/etc/imghost.env` must be `chmod 600`. Client script refuses to run otherwise. |
| T7 | Container escape | Distroless `nonroot`, read-only rootfs, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`. Volume is the only writable path. |
| T8 | ID enumeration | 8-char nanoid (`A-Za-z0-9_-`) → ~2⁴⁸ space; not secret but not scrapable. |
| T9 | Supply chain | `Cargo.lock` committed; `cargo audit` + `cargo deny check` run in CI on every push and weekly. Policy in `.cargo/audit.toml` and `deny.toml`. |
| T10 | Data loss | Persistent named docker volume; `rsync` cron snippet below. |
| T11 | Timing attacks | All credential compares via `subtle::ConstantTimeEq`. |
| T12 | Log leakage | JSON `tracing` logs; auth headers and request bodies are never logged. |
| T13 | Deploy compromise | sshd binds `127.0.0.1` only; reachable solely via Cloudflare Tunnel + Access service token. `deploy` user's `authorized_keys` uses a forced command — even with the SSH key an attacker can ONLY run `docker compose pull && up -d`. CI publishes images as `:sha-<short>` first; the deploy workflow promotes `:latest` only after a release tag is pushed. See `deploy/auto-deploy.md`. |

## Endpoints

| Method | Path | App auth | CF Access | Notes |
|---|---|---|---|---|
| GET | `/healthz` | none | bypass | Liveness |
| GET | `/i/:name` | none | bypass | Image bytes; `Cache-Control: immutable`, `CSP sandbox`, `nosniff`. |
| POST | `/upload` | Bearer | service token | Sniff + dedupe + atomic write; returns `{"url":...,"deduped":bool}`. |
| GET | `/admin` | Basic | IdP | Paginated listing, 50/page. |
| POST | `/admin/delete/:id` | Basic | IdP | Form post; deletes row + file. |

Allowed mimes: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`.
SVG and HTML are explicitly excluded.

## Repo layout

```
.
├── Cargo.toml / Cargo.lock        crate manifest (axum 0.8, sqlx 0.8, …)
├── Makefile                       common dev / release tasks (`make help`)
├── deny.toml / .cargo/audit.toml  cargo-deny + cargo-audit policy
├── Dockerfile                     multi-stage; rust:1.91 → distroless cc nonroot
├── docker-compose.yml             read-only rootfs, cap_drop, tmpfs, named volume
├── src/
│   ├── main.rs                    binary entrypoint (env parsing, listener)
│   ├── lib.rs                     `build_app()` — router wiring shared with tests
│   └── config, auth, upload, serve, admin, storage
├── tests/integration.rs           in-process HTTP tests against `build_app()`
├── migrations/0001_init.sql       SQLite uploads table + indexes
├── client/screenshot-upload.sh    POSIX hotkey client
├── deploy/
│   ├── cloudflared.example.yml
│   ├── imghost.env.example
│   ├── access-policies.md         walkthrough for the four CF Access apps
│   └── auto-deploy.md             tag-triggered deploy via Tunnel + Access SSH
├── .github/workflows/
│   ├── ci.yml                     fmt + clippy + test + audit + deny + image
│   └── deploy.yml                 release-tag-triggered host deploy + rollback
└── LICENSE                        MIT
```

## Build & local run

```bash
make install-deps     # one-time: cargo-audit, cargo-deny
make ci               # fmt --check + clippy + test + audit + deny — same as CI
make build            # release binary at ./target/release/imghost
make help             # list every target

# Local run (no CF in front — bypass everything by hitting the host directly).
mkdir -p data
UPLOAD_TOKEN=test ADMIN_PASS=test PUBLIC_BASE_URL=http://localhost:8080 \
  DATA_DIR=./data BIND_ADDR=127.0.0.1:8080 \
  ./target/release/imghost
```

The integration suite under `tests/integration.rs` spawns the app on a kernel-
assigned port with an isolated tempdir, exercises every endpoint (upload happy
path, dedupe, 401/413/415, `/i/*` security headers, admin auth, delete), and
runs in-process via `imghost::build_app`. New endpoints should add coverage
there before the manual `curl` step.

Smoke test:

```bash
curl -fsS -H "Authorization: Bearer test" \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png \
  http://127.0.0.1:8080/upload
# → {"url":"http://localhost:8080/i/<id>.png","deduped":false}

curl -I http://127.0.0.1:8080/i/<id>.jpg
# 200 + Cache-Control: immutable + Content-Security-Policy: default-src 'none'; sandbox

# Negatives
curl -i --data-binary @README.md -H "Authorization: Bearer test" \
  -H "Content-Type: text/markdown" http://127.0.0.1:8080/upload   # 415
curl -i http://127.0.0.1:8080/upload                              # 401
```

## Container build

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

Hardening sanity-check:

```bash
docker exec imghost id                       # uid=65532 nonroot
docker exec imghost touch /foo               # read-only fs → fails
docker exec imghost touch /tmp/foo           # tmpfs → ok
docker inspect imghost --format '{{.HostConfig.CapAdd}} / {{.HostConfig.CapDrop}}'
# → [] / [ALL]
```

## Deploy on the homelab box

### 1. Build & install the env file

```bash
sudo install -d /etc/cloudflared /var/lib/imghost /opt/imghost
sudo install -m 0600 -o root -g root deploy/imghost.env.example /etc/imghost.env
sudoedit /etc/imghost.env     # set UPLOAD_TOKEN, ADMIN_PASS, PUBLIC_BASE_URL=https://aigf.dev
sudo install -m 0644 docker-compose.yml /opt/imghost/docker-compose.yml
sudo -u root docker compose -f /opt/imghost/docker-compose.yml up -d --build
```

The first bring-up uses `--build` against the local source. After that,
ongoing deploys are pull-only — see [§ Releases & auto-deploy](#releases--auto-deploy).

Generate strong secrets:

```bash
openssl rand -base64 48   # UPLOAD_TOKEN
openssl rand -base64 32   # ADMIN_PASS
```

### 2. Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create imghost
cloudflared tunnel route dns imghost aigf.dev
sudo install -m 0644 deploy/cloudflared.example.yml /etc/cloudflared/config.yml
sudoedit /etc/cloudflared/config.yml         # fill in <tunnel-id>
sudo systemctl enable --now cloudflared
```

### 3. Cloudflare Access apps

Follow `deploy/access-policies.md`. Three apps on `aigf.dev`, plus a fourth
on `ssh.aigf.dev` if you wire up auto-deploy:

- `imghost-upload` — path `/upload` — Service Token policy.
- `imghost-admin` — paths `/admin`, `/admin/*` — IdP login policy.
- `imghost-public` — paths `/i/*`, `/healthz` — Bypass.
- `imghost-deploy` — `ssh.aigf.dev/*` — Service Token policy. *(optional, auto-deploy only)*

Copy the upload service token Client ID / Client Secret from the dashboard into
`~/.config/imghost/env` on every machine that should be allowed to upload.

### 4. Backups

```cron
# /etc/cron.d/imghost-backup
0 3 * * * root rsync -a --delete /var/lib/docker/volumes/imghost_imghost-data/_data/ backup-host:imghost/
```

## Hotkey client

Install:

```bash
sudo install -m 0755 client/screenshot-upload.sh /usr/local/bin/imghost-screenshot
mkdir -p ~/.config/imghost
cat > ~/.config/imghost/env <<'EOF'
BASE_URL=https://aigf.dev
TOKEN=<UPLOAD_TOKEN from /etc/imghost.env>
CF_ACCESS_CLIENT_ID=<from CF Access service token>
CF_ACCESS_CLIENT_SECRET=<from CF Access service token>
EOF
chmod 600 ~/.config/imghost/env
```

The script refuses to run if the env file is more permissive than `0600`.

### Bind a hotkey

**Hyprland** (`~/.config/hypr/hyprland.conf`):
```
bind = SUPER SHIFT, S, exec, /usr/local/bin/imghost-screenshot
```

**sway** (`~/.config/sway/config`):
```
bindsym $mod+Shift+s exec /usr/local/bin/imghost-screenshot
```

**i3** (`~/.config/i3/config`):
```
bindsym $mod+Shift+s exec --no-startup-id /usr/local/bin/imghost-screenshot
```

**sxhkd** (`~/.config/sxhkd/sxhkdrc`):
```
super + shift + s
    /usr/local/bin/imghost-screenshot
```

**GNOME**: Settings → Keyboard → Custom Shortcuts → `imghost-screenshot` → bind.

### Required tools on the client

- One of: `flameshot`, `grim` + `slurp`, or `maim`.
- `curl` (always).
- `wl-copy` (Wayland) or `xclip` / `xsel` (X11).
- `jq` recommended (script falls back to `sed` parsing).
- `notify-send` for the toast (optional).

On Arch:
```bash
sudo pacman -S --needed flameshot grim slurp wl-clipboard xclip jq libnotify
```

## Operating

```bash
docker compose logs -f imghost      # live logs (JSON)
docker compose restart imghost
docker compose pull && docker compose up -d --build
```

Manual delete from the admin UI at `https://aigf.dev/admin` (requires CF Access
login plus the HTTP Basic prompt). Or directly:

```sql
sqlite3 /var/lib/docker/volumes/imghost_imghost-data/_data/imghost.db \
  'DELETE FROM uploads WHERE id = "abcd1234";'
rm /var/lib/docker/volumes/imghost_imghost-data/_data/objects/abcd1234.png
```

## CI

`.github/workflows/ci.yml` runs on every push to `master`, every pull request,
and on a weekly schedule (so new advisories surface even without commits).
Jobs: `fmt --check`, `clippy -D warnings`, `cargo test --all-targets`,
`cargo audit`, `cargo deny check`, and a `docker buildx build`. On push to
`master` the image job also pushes the runtime image to GHCR as
`ghcr.io/<owner>/imghost:sha-<short>` — gated on every other job passing —
so it's available for the deploy workflow to promote later. Third-party
actions are pinned to commit SHAs.

## Releases & auto-deploy

Release gate is a git tag. The Makefile wraps the common moves:

```bash
make release VERSION=v0.1.0    # tag + push — fires .github/workflows/deploy.yml
make rollback TAG=v0.0.9       # re-deploy any prior tag without rebuilding
```

The deploy workflow promotes the existing `:sha-<short>` image to `:v0.1.0` +
`:latest` in GHCR, then SSHes the host through Cloudflare Tunnel + Access
(service token) and runs `docker compose pull && up -d`. No public inbound
port is opened — sshd on the host binds `127.0.0.1` only and is reached only
via the tunnel.

Full host setup (deploy user, forced command, GitHub Secrets, CF Access app)
is in `deploy/auto-deploy.md`.

## Supply-chain checks

```bash
cargo install cargo-audit cargo-deny       # one-time
cargo audit
cargo deny check
```

Run locally before pushing if you've touched `Cargo.toml` / `Cargo.lock`. CI
re-runs both on every PR.

### Documented advisory ignores

- **RUSTSEC-2023-0071** (`rsa` 0.9 — Marvin timing attack). Pulled in via
  `sqlx-mysql`, which is compiled because sqlx's `macros` feature
  unconditionally drags in every DB driver. We never instantiate a MySQL
  connection at runtime, so the affected RSA paths are unreachable. Mirrored
  in `.cargo/audit.toml` and `deny.toml`. Re-evaluate when sqlx or `rsa` ship
  a fix.

## License

MIT — see `LICENSE`.
