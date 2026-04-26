#!/usr/bin/env bash
# imghost-upload — POST an image to imghost, copy URL to clipboard, notify.
#
# Capture-agnostic counterpart to screenshot-upload.sh. Use this when you
# already have a screenshot pipeline and just need imghost as the upload sink.
#
# Usage:
#   imghost-upload FILE                   # upload from file path
#   imghost-upload -                      # read bytes from stdin
#   capture-tool --raw | imghost-upload   # implicit stdin (no args)
#
# Reads required config from $XDG_CONFIG_HOME/imghost/env (default
# ~/.config/imghost/env):
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
  printf 'imghost-upload: %s\n' "$*" >&2
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

src="${1:--}"

# Stdin → temp file. We need a real file because (a) `file` can't sniff stdin
# robustly, and (b) curl needs --data-binary to know the size for retries.
if [[ "$src" == "-" ]]; then
  tmp=$(mktemp --suffix=.bin) || die "mktemp failed"
  trap 'rm -f "$tmp"' EXIT
  cat > "$tmp"
  src="$tmp"
fi

[[ -s "$src" ]] || die "empty input"

# Local mime sniff — server validates again, but failing fast here gives a
# clearer error than the 415 we'd otherwise get back.
mime=$(file -b --mime-type "$src" 2>/dev/null || echo "")
case "$mime" in
  image/png|image/jpeg|image/gif|image/webp|image/avif) ;;
  "")  die "could not sniff mime type of $src" ;;
  *)   die "mime $mime not allowed (png/jpeg/gif/webp/avif)" ;;
esac

response=$(curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: $mime" \
  --data-binary "@$src" \
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
