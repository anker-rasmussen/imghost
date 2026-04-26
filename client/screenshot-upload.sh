#!/usr/bin/env bash
# imghost screenshot uploader.
#
# Picks the first available screenshot tool (flameshot -> grim+slurp -> maim+slop),
# captures a region selection, POSTs to the imghost upload endpoint behind
# Cloudflare Access, and copies the returned URL to the clipboard.
#
# Reads required config from $XDG_CONFIG_HOME/imghost/env (default ~/.config/imghost/env):
#
#   BASE_URL=https://your.domain
#   TOKEN=<UPLOAD_TOKEN>
#   CF_ACCESS_CLIENT_ID=<service-token-id>.access
#   CF_ACCESS_CLIENT_SECRET=<service-token-secret>
#
# That file MUST be chmod 600.

set -Eeuo pipefail

cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/imghost"
cfg_file="$cfg_dir/env"

die() {
  printf 'imghost: %s\n' "$*" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send -u critical "imghost" "$*" || true
  exit 1
}

[[ -r "$cfg_file" ]] || die "config not found at $cfg_file"

# Refuse to run if the config is world/group readable — it has secrets.
perms=$(stat -c '%a' "$cfg_file" 2>/dev/null || stat -f '%Lp' "$cfg_file")
case "$perms" in
  600|400) ;;
  *) die "$cfg_file has permissions $perms — chmod 600 it first" ;;
esac

# shellcheck disable=SC1090
. "$cfg_file"

: "${BASE_URL:?BASE_URL not set in $cfg_file}"
: "${TOKEN:?TOKEN not set in $cfg_file}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID not set in $cfg_file}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET not set in $cfg_file}"

tmp=$(mktemp --suffix=.png)
trap 'rm -f "$tmp"' EXIT

if command -v flameshot >/dev/null 2>&1; then
  flameshot gui --raw > "$tmp"
elif command -v grim >/dev/null 2>&1 && command -v slurp >/dev/null 2>&1; then
  region=$(slurp) || die "selection cancelled"
  grim -g "$region" "$tmp"
elif command -v maim >/dev/null 2>&1; then
  maim -s "$tmp"
else
  die "need one of: flameshot, grim+slurp, maim"
fi

[[ -s "$tmp" ]] || die "empty screenshot — selection cancelled?"

response=$(curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: image/png" \
  --data-binary "@$tmp" \
  "$BASE_URL/upload") || die "upload failed"

if command -v jq >/dev/null 2>&1; then
  url=$(printf '%s' "$response" | jq -er .url)
else
  url=$(printf '%s' "$response" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

[[ -n "$url" ]] || die "no url in response: $response"

if [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$url" | wl-copy
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$url" | xclip -selection clipboard
elif command -v xsel >/dev/null 2>&1; then
  printf '%s' "$url" | xsel --clipboard --input
else
  die "no clipboard tool (wl-copy / xclip / xsel) — got URL: $url"
fi

command -v notify-send >/dev/null 2>&1 && notify-send "imghost" "Copied: $url" || true
printf '%s\n' "$url"
