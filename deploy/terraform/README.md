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

State: not committed (`*.tfstate` is ignored). Planned: remote state on R2 with OpenTofu state encryption.
Roadmap: uploader → WARP + device posture; deployer → pull-based deploys; then retire both service tokens.
