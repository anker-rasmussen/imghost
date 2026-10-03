# Cloudflare as code (OpenTofu)

Everything that used to be dashboard clicks for aigf.dev: Zero Trust Access apps and policies, the
`imghost` tunnel object, and the zone's DNS records. Adopted from the live account with `cf-terraforming`
plus `import {}` blocks; the first plan was **14 to import, 0 to change** (an exact match).

| File | What |
|---|---|
| `access_apps.tf` | the five self-hosted Access apps (public paths, catch-all bypass, ssh, /upload, /admin) |
| `access_policies.tf` | reusable policies (bypass, service-token, admin email) |
| `service_tokens.tf` | token IDs only. Tokens are not managed here: import can't read secrets and an update could rotate them |
| `tunnel_dns.tf` | the tunnel (ingress stays in the host's cloudflared config) and DNS records |
| `imports.tf` | one-time adoption; delete after the first successful apply |

Heads-up: the `aigf.dev/*` bypass makes every path public unless a more specific app gates it.

```bash
set -a; . ~/.config/cloudflare/terraform.env; set +a     # CLOUDFLARE_API_TOKEN (never committed)
tofu init
tofu plan      # always review before apply
tofu apply
```

State: local `terraform.tfstate`, gitignored and **encrypted client-side** (OpenTofu `encryption` block, PBKDF2 → AES-GCM;
plans are encrypted too). The passphrase is `TF_VAR_state_passphrase` in `~/.config/cloudflare/terraform.env` (mode 600).
An encrypted backup lives at `~/.config/cloudflare/imghost.tfstate.enc.bak`. Lose the passphrase and you re-import with
`imports.tf` — nothing in Cloudflare is lost. To move to R2 later: enable R2, add an `s3` backend, `tofu init -migrate-state`.

Rotate the API token: create it in the dashboard, copy it, run `~/.local/bin/cf-token-set` (reads the clipboard, then clears it).
Roadmap: uploader → WARP + device posture; deployer → pull-based deploys; then retire both service tokens.
