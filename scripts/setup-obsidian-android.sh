#!/usr/bin/env bash
#
# Download the Obsidian Android APK for the Android e2e tests.
#
# Obsidian publishes the APK on the same GitHub releases as the desktop builds,
# but not on every release: some releases are desktop-only and some (v1.13.8)
# are mobile-only. So "latest" here means the newest release that has an .apk,
# not GitHub's latest release.
#
# There is no iOS counterpart. The iOS app ships only through the App Store,
# and the iOS Simulator can only run builds compiled for it, which Obsidian
# does not publish.
#
# USAGE: ./scripts/setup-obsidian-android.sh
#
# Environment Variables
#   OBSIDIAN_MOBILE_VERSION  Specify a fixed version (e.g., 1.13.8). If not set,
#                            uses the newest release that ships an .apk
#   GH_TOKEN                 Needed in CI for the gh CLI
#
set -euo pipefail

root_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
apk_dir="$root_path/.obsidian-android"
apk_path="$apk_dir/Obsidian.apk"

version="${OBSIDIAN_MOBILE_VERSION:-latest}"
if [[ "$version" == "latest" ]]; then
  version="$(gh api 'repos/obsidianmd/obsidian-releases/releases?per_page=30' \
    --jq '[.[] | select(any(.assets[]; .name | endswith(".apk")))][0].tag_name' \
    | sed 's/^v//')"
  [[ -n "$version" ]] || {
    echo "❌ Could not find an Obsidian release with an .apk" >&2
    exit 1
  }
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "⏬ Downloading Obsidian ($version) APK via gh CLI"
gh release download "v${version}" -R obsidianmd/obsidian-releases \
  --pattern '*.apk' --dir "$tmp_dir"

downloaded="$(find "$tmp_dir" -name '*.apk' -type f | head -n1)"
[[ -n "$downloaded" ]] || { echo "❌ .apk not found in v${version}" >&2; exit 1; }

mkdir -p "$apk_dir"
mv "$downloaded" "$apk_path"
echo "$version" > "$apk_dir/version.txt"

echo "✅ Obsidian $version APK at $apk_path"
