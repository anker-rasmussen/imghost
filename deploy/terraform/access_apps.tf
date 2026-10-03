# Self-hosted Access applications on aigf.dev. Cloudflare matches the most specific path first.

locals {
  public_dest = { type = "public" }
}

# Live settings pinned so adoption is a no-op (provider defaults differ, e.g. http_only_cookie_attribute = true).
locals {
  app_cookie_settings = {
    http_only_cookie_attribute = false
    enable_binding_cookie      = false
    auto_redirect_to_identity  = false
    options_preflight_bypass   = false
  }
}

resource "cloudflare_zero_trust_access_application" "public_paths" {
  account_id       = var.account_id
  name             = "aigf.dev"
  type             = "self_hosted"
  session_duration = "24h"

  http_only_cookie_attribute = local.app_cookie_settings.http_only_cookie_attribute
  enable_binding_cookie      = local.app_cookie_settings.enable_binding_cookie
  auto_redirect_to_identity  = local.app_cookie_settings.auto_redirect_to_identity
  options_preflight_bypass   = local.app_cookie_settings.options_preflight_bypass
  destinations               = [for p in ["aigf.dev/i/*", "aigf.dev/healthz", "aigf.dev/fleet"] : merge(local.public_dest, { uri = p })]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.public_paths_bypass.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "catch_all" {
  account_id       = var.account_id
  name             = "aigf.dev"
  type             = "self_hosted"
  session_duration = "24h"

  http_only_cookie_attribute = local.app_cookie_settings.http_only_cookie_attribute
  enable_binding_cookie      = local.app_cookie_settings.enable_binding_cookie
  auto_redirect_to_identity  = local.app_cookie_settings.auto_redirect_to_identity
  options_preflight_bypass   = local.app_cookie_settings.options_preflight_bypass
  destinations               = [for p in ["aigf.dev/*", "aigf.dev"] : merge(local.public_dest, { uri = p })]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.catch_all_bypass.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "ssh" {
  account_id       = var.account_id
  name             = "ssh"
  type             = "self_hosted"
  session_duration = "24h"

  http_only_cookie_attribute = local.app_cookie_settings.http_only_cookie_attribute
  enable_binding_cookie      = local.app_cookie_settings.enable_binding_cookie
  auto_redirect_to_identity  = local.app_cookie_settings.auto_redirect_to_identity
  options_preflight_bypass   = local.app_cookie_settings.options_preflight_bypass
  destinations               = [for p in ["ssh.aigf.dev", "ssh.aigf.dev/*"] : merge(local.public_dest, { uri = p })]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.deployer_token.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "upload" {
  account_id       = var.account_id
  name             = "aigf.dev"
  type             = "self_hosted"
  session_duration = "24h"

  http_only_cookie_attribute = local.app_cookie_settings.http_only_cookie_attribute
  enable_binding_cookie      = local.app_cookie_settings.enable_binding_cookie
  auto_redirect_to_identity  = local.app_cookie_settings.auto_redirect_to_identity
  options_preflight_bypass   = local.app_cookie_settings.options_preflight_bypass
  destinations               = [merge(local.public_dest, { uri = "aigf.dev/upload" })]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.uploader_token.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "aigf.dev"
  type             = "self_hosted"
  session_duration = "24h"

  http_only_cookie_attribute = local.app_cookie_settings.http_only_cookie_attribute
  enable_binding_cookie      = local.app_cookie_settings.enable_binding_cookie
  auto_redirect_to_identity  = local.app_cookie_settings.auto_redirect_to_identity
  options_preflight_bypass   = local.app_cookie_settings.options_preflight_bypass
  destinations               = [for p in ["aigf.dev/admin", "aigf.dev/admin/*"] : merge(local.public_dest, { uri = p })]
  policies                   = [{ id = cloudflare_zero_trust_access_policy.admin_email.id, precedence = 1 }]
}
