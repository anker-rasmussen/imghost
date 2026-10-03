# Service tokens are NOT managed here: import cannot read a token's secret, and any provider-side update risks
# rotating it (breaking the upload client and CI deploys). Policies reference them by ID; rotate in the dashboard.

variable "uploader_token_id" {
  description = "Access service token 'imghost-uploader' (used by the screenshot client for /upload)."
  type        = string
  default     = "d169ad62-320e-4854-8088-dcc05c2de59b"
}

variable "deployer_token_id" {
  description = "Access service token 'imghost-deployer' (used by CI to SSH through the tunnel)."
  type        = string
  default     = "1d390eb5-beb3-48ac-a6f5-91e60d3febbc"
}
