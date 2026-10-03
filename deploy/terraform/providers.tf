terraform {
  required_version = ">= 1.8"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Client-side state + plan encryption (OpenTofu). State stays local and gitignored; even a leaked copy is
  # unreadable without TF_VAR_state_passphrase (kept in ~/.config/cloudflare/terraform.env, never committed).
  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}

# Auth: CLOUDFLARE_API_TOKEN from the environment (never committed).
provider "cloudflare" {}
