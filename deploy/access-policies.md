# Cloudflare Access policies

The threat model assumes only `GET /`, `GET /i/*`, and `GET /healthz` are publicly
reachable. `POST /upload` and `/admin*` must be fronted by Cloudflare Access. Set up
three applications in **Zero Trust → Access → Applications** on the same hostname,
ordered most-specific first.

## 1. `imghost-upload`  (service token)

| Field | Value |
| --- | --- |
| Type | Self-hosted |
| Application domain | `aigf.dev` |
| Path | `/upload` |
| Session duration | 24h (irrelevant — service tokens don't expire on session) |
| Identity providers | (none — disable all) |

**Policy:** `Service Auth` → action **Allow** → include rule **Service Token = imghost-uploader**.

Create the service token under **Access → Service Auth → Service Tokens**. Copy the
**Client ID** and **Client Secret** into `~/.config/imghost/env` on the client
machine as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. The secret is shown
exactly once — store it immediately.

## 2. `imghost-admin`  (user identity)

| Field | Value |
| --- | --- |
| Type | Self-hosted |
| Application domain | `aigf.dev` |
| Path | `/admin` and `/admin/*` (add both as path entries) |
| Session duration | 24h |
| Identity providers | One-time PIN (default) and/or GitHub |

**Policy:** action **Allow** → include rule **Emails = your@email**.

Optionally add a second include rule for an `@yourdomain` email pattern if you want
multiple admins later.

## 3. `imghost-public`  (bypass)

| Field | Value |
| --- | --- |
| Type | Self-hosted |
| Application domain | `aigf.dev` |
| Path | `/`, `/i/*`, and `/healthz` (add each as a path entry) |

**Policy:** action **Bypass** → include rule **Everyone**.

You can also leave `/`, `/i/*`, and `/healthz` outside Access entirely. Adding a
Bypass app makes the intent explicit in the UI and protects against future "Block by
default on this hostname" toggles.

## 4. `imghost-deploy`  (service token, SSH)

Only needed if you use the auto-deploy workflow. Walkthrough lives in
`deploy/auto-deploy.md` — what follows is the Access piece.

| Field | Value |
| --- | --- |
| Type | Self-hosted |
| Application domain | `ssh.aigf.dev` |
| Path | `/*` (whole hostname) |
| Identity providers | (none — disable all) |

**Policy:** `Service Auth` → action **Allow** → include rule **Service Token = imghost-deployer**.

Create a separate service token under **Access → Service Auth → Service Tokens** —
do not reuse `imghost-uploader`. The deploy token has more privilege (it ends up
with shell on the host, restricted to a single forced command); reusing the upload
token blurs blast radius. Copy the **Client ID** and **Client Secret** into the
GitHub repo secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

## Verification

```bash
# From a public network (no service token, no IdP login):
curl -i https://aigf.dev/                       # 200 (landing)
curl -i https://aigf.dev/healthz                # 200
curl -i https://aigf.dev/i/<id>.jpg             # 200 (or 404)
curl -i https://aigf.dev/upload                  # 302 to CF Access login
curl -i https://aigf.dev/admin                  # 302 to CF Access login

# With a service token:
curl -i \
  -H "CF-Access-Client-Id: $ID" \
  -H "CF-Access-Client-Secret: $SECRET" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png \
  https://aigf.dev/upload
# → {"url":"https://aigf.dev/i/<id>.png","deduped":false}
```

Tail container logs while running the unauthenticated `curl` calls — they should
**not** appear, confirming the request was rejected at the Cloudflare edge before
reaching the origin.
