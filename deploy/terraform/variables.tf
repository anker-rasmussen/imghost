variable "account_id" {
  description = "Cloudflare account that owns the Zero Trust (Access) configuration."
  type        = string
  default     = "ed1ae38cd983a29f55a1f827a2c18251"
}

variable "zone_id" {
  description = "Zone ID for aigf.dev."
  type        = string
  default     = "8b2ea727edbffe30472067b7168caf9d"
}

variable "admin_email" {
  description = "Identity allowed through Access to /admin."
  type        = string
  default     = "anker@rasmussen.engineering"
}

variable "state_passphrase" {
  description = "Passphrase for OpenTofu state/plan encryption (>= 16 chars). Set TF_VAR_state_passphrase."
  type        = string
  sensitive   = true
}
