# The tunnel itself is tracked here; its ingress rules are locally managed by cloudflared on the host
# (config_src = "local", deployed by deploy/ansible), so they are not part of this config.

resource "cloudflare_zero_trust_tunnel_cloudflared" "imghost" {
  account_id = var.account_id
  name       = "imghost"
  config_src = "local"
}

locals {
  imghost_tunnel_target = "${cloudflare_zero_trust_tunnel_cloudflared.imghost.id}.cfargotunnel.com"
}

resource "cloudflare_dns_record" "apex" {
  zone_id = var.zone_id
  name    = "aigf.dev"
  type    = "CNAME"
  content = local.imghost_tunnel_target
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.zone_id
  name    = "ssh.aigf.dev"
  type    = "CNAME"
  content = local.imghost_tunnel_target
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "brokencircuits" {
  # Points at a different tunnel (another project), kept here so nothing on the zone is unmanaged.
  zone_id = var.zone_id
  name    = "brokencircuits.dev.aigf.dev"
  type    = "CNAME"
  content = "a6dd4d1a-f6f0-4182-ab62-772752e79ed8.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
