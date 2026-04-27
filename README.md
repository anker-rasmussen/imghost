# imghost

A screenshot host for one. Hotkey, drag a region, URL's on the clipboard.

It's a small Rust + axum service in a distroless container on my homelab box. Public ingress goes through a Cloudflare Tunnel, so nothing on the host listens on the open internet. Cloudflare Access gates `/upload` (service token) and `/admin` (IdP login); only `/i/<id>` and `/healthz` are publicly reachable.

Live at [aigf.dev](https://aigf.dev).

## Local run

```bash
make ci          # fmt, clippy, tests, audit, deny
make build

UPLOAD_TOKEN=test ADMIN_PASS=test PUBLIC_BASE_URL=http://localhost:8080 \
  DATA_DIR=./data BIND_ADDR=127.0.0.1:8080 \
  ./target/release/imghost
```

Smoke it:

```bash
curl -fsS -H 'Authorization: Bearer test' --data-binary @some.png \
  http://127.0.0.1:8080/upload
# {"url":"http://localhost:8080/i/<id>.png","deduped":false}
```

`make help` lists the rest.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | none | static landing page |
| GET | `/healthz` | none | liveness |
| GET | `/i/:name` | none | image bytes; immutable, sandboxed CSP |
| POST | `/upload` | bearer (+ CF Access service token in prod) | mime sniff, sha256 dedupe, atomic write |
| GET | `/admin` | HTTP Basic (+ CF Access IdP in prod) | paginated listing, 50/page |
| POST | `/admin/delete/:id` | HTTP Basic (+ CF Access IdP in prod) | deletes row + file |

Allowed mimes: png, jpeg, gif, webp, avif. SVG and HTML are explicitly rejected.

## Deploy

Full walkthrough lives in [`deploy/auto-deploy.md`](deploy/auto-deploy.md): tunnel setup, the four Cloudflare Access apps, deploy user with a forced-command `authorized_keys`, GitHub repo secrets, host-side GHCR auth.

CI publishes `ghcr.io/<owner>/imghost:sha-<short>` on every master push. A git tag `vX.Y.Z` fires `.github/workflows/deploy.yml`, which promotes that image to `:vX.Y.Z` and `:latest`, SSHes the host through the tunnel, and runs `docker compose pull && up -d`.

```bash
make release VERSION=v0.1.0     # tag + push
make rollback TAG=v0.0.9        # re-deploy an older tag
```

## Hotkey client

`client/screenshot-upload.sh` does capture + upload + clipboard in one. For setups with an existing screenshot pipeline, `client/imghost-upload.sh` is upload-only and takes a file path or reads stdin.

Both read `~/.config/imghost/env` (chmod 600). Template at [`client/env.example`](client/env.example).

## License

MIT.
