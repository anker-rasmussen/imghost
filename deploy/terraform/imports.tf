# One-time adoption of resources that were created by hand in the dashboard. After the first successful
# `apply` these blocks are no-ops and can be deleted.
locals { acct = var.account_id }

import {
  to = cloudflare_zero_trust_access_application.public_paths
  id = "accounts/${local.acct}/da7f4a4b-f363-43c5-b518-d50ca932c6bd"
}

import {
  to = cloudflare_zero_trust_access_application.catch_all
  id = "accounts/${local.acct}/d28476ab-e4e5-420d-bf9a-de63d54b0fae"
}

import {
  to = cloudflare_zero_trust_access_application.ssh
  id = "accounts/${local.acct}/1ccbdeaa-b8dd-4a04-8872-ba79fcfc6d8c"
}

import {
  to = cloudflare_zero_trust_access_application.upload
  id = "accounts/${local.acct}/48d3b128-e397-4236-836c-f0788f6ec8ff"
}

import {
  to = cloudflare_zero_trust_access_application.admin
  id = "accounts/${local.acct}/60161438-f652-4db4-a215-92b36a5d4af9"
}


import {
  to = cloudflare_zero_trust_access_policy.public_paths_bypass
  id = "${local.acct}/560442c0-75bd-4a70-9cf3-2db549197731"
}

import {
  to = cloudflare_zero_trust_access_policy.catch_all_bypass
  id = "${local.acct}/97ae88bb-0b7c-47e8-94a9-7e2176c97b48"
}

import {
  to = cloudflare_zero_trust_access_policy.deployer_token
  id = "${local.acct}/0da22a62-00c2-4213-b84a-cf87ceb90785"
}

import {
  to = cloudflare_zero_trust_access_policy.uploader_token
  id = "${local.acct}/969d5809-7f99-4592-ac79-65f41b0761e7"
}

import {
  to = cloudflare_zero_trust_access_policy.admin_email
  id = "${local.acct}/4185beb1-cd65-42b0-ba58-3b1380194ffd"
}



import {
  to = cloudflare_zero_trust_tunnel_cloudflared.imghost
  id = "${local.acct}/ff3af661-82c7-4f32-87a7-8f670c282b88"
}


import {
  to = cloudflare_dns_record.apex
  id = "${var.zone_id}/14d1fb036be8218a23b7be2441790ac3"
}

import {
  to = cloudflare_dns_record.brokencircuits
  id = "${var.zone_id}/a245629c751a99abe9c906d74f5b899a"
}

import {
  to = cloudflare_dns_record.ssh
  id = "${var.zone_id}/0e156d08457c12adad0a8ca47db9e34e"
}

