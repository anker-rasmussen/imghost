# Reusable Zero Trust Access policies. Apps reference these by ID (see access_apps.tf).
# Threat model (deploy/access-policies.md): everything is public EXCEPT /upload (service token) and /admin (email).

resource "cloudflare_zero_trust_access_policy" "public_paths_bypass" {
  # Named "allow" in the dashboard, but it is a bypass: no identity check for the explicit public paths.
  account_id       = var.account_id
  name             = "allow"
  decision         = "bypass"
  connection_rules = { rdp = {} } # API default on these policies; pinned to avoid drift
  include          = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_policy" "catch_all_bypass" {
  # Bypass for aigf.dev/* — anything not gated by a more specific app is PUBLIC by default (e.g. /showroom/).
  account_id       = var.account_id
  name             = "Bypassview"
  decision         = "bypass"
  connection_rules = { rdp = {} } # API default on these policies; pinned to avoid drift
  include          = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_policy" "deployer_token" {
  # CI deploys over SSH through the tunnel with the imghost-deployer service token.
  account_id       = var.account_id
  name             = "deployer"
  decision         = "non_identity"
  connection_rules = { rdp = {} } # API default on these policies; pinned to avoid drift
  include          = [{ service_token = { token_id = var.deployer_token_id } }]
}

resource "cloudflare_zero_trust_access_policy" "uploader_token" {
  # The screenshot hotkey client authenticates /upload with the imghost-uploader service token.
  account_id       = var.account_id
  name             = "upload_token"
  decision         = "non_identity"
  connection_rules = { rdp = {} } # API default on these policies; pinned to avoid drift
  include          = [{ service_token = { token_id = var.uploader_token_id } }]
}

resource "cloudflare_zero_trust_access_policy" "admin_email" {
  account_id       = var.account_id
  name             = "Email"
  decision         = "allow"
  connection_rules = { rdp = {} } # API default on these policies; pinned to avoid drift
  include          = [{ email = { email = var.admin_email } }]
}
