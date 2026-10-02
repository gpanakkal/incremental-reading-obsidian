#!/usr/bin/env bash
#
# Script to extract Obsidian and prepare E2E test directory (macOS and Linux)
# Reference: https://github.com/proog/obsidian-trash-explorer/blob/4d9bc2c4977d79af116b369904c8f68d1c164b28/e2e-setup.sh
#
# - Local           : Extract directly from installed Obsidian
# - GitHub Actions  : Get release artifact from GitHub Releases and extract
#
# USAGE (local) : ./scripts/setup-obsidian.sh
# USAGE (ci)    : ./scripts/setup-obsidian.sh --ci
#
# Environment Variables
#   OBSIDIAN_VERSION  Specify a fixed version (e.g., 1.8.10). If not set, uses the
#                     latest desktop version from the repo's desktop-releases.json
#   OBSIDIAN_PATH     Override the path to local Obsidian installation
#
set -euo pipefail

# ------------------------------------------------------------------------------
# 0. Detect platform
# ------------------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "❌ Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

root_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
unpacked_path="$root_path/.obsidian-unpacked"

# ------------------------------------------------------------------------------
# 1. Parse arguments
# ------------------------------------------------------------------------------
MODE="local"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci) MODE="ci";;
    *)    echo "Unknown arg: $1" >&2; exit 1;;
  esac
  shift
done

# ------------------------------------------------------------------------------
# 2. Get Obsidian installation
# ------------------------------------------------------------------------------
if [[ "$MODE" == "local" ]]; then
  if [[ "$PLATFORM" == "macos" ]]; then
    obsidian_app="${OBSIDIAN_PATH:-/Applications/Obsidian.app}"
    [[ -d "$obsidian_app" ]] || {
      echo "❌ $obsidian_app not found. Please install Obsidian." >&2
      exit 1
    }
  else
    # Linux: check common installation paths
    obsidian_app="${OBSIDIAN_PATH:-}"
    if [[ -z "$obsidian_app" ]]; then
      # Check for Flatpak installation
      if [[ -d "/var/lib/flatpak/app/md.obsidian.Obsidian" ]]; then
        obsidian_app="/var/lib/flatpak/app/md.obsidian.Obsidian/current/active/files"
      # Check for Snap installation
      elif [[ -d "/snap/obsidian/current" ]]; then
        obsidian_app="/snap/obsidian/current"
      # Check for AppImage in common locations
      elif [[ -f "$HOME/Applications/Obsidian.AppImage" ]]; then
        obsidian_app="$HOME/Applications/Obsidian.AppImage"
      elif [[ -f "/opt/Obsidian/Obsidian.AppImage" ]]; then
        obsidian_app="/opt/Obsidian/Obsidian.AppImage"
      else
        echo "❌ Obsidian not found. Set OBSIDIAN_PATH or install Obsidian." >&2
        exit 1
      fi
    fi
  fi
else
  tmp_dir="$(mktemp -d)"
  version="${OBSIDIAN_VERSION:-latest}"

  if [[ "$version" == "latest" ]]; then
    # GitHub's "latest release" can be mobile-only (v1.13.8 shipped just an .apk),
    # so resolve the newest desktop version from the repo's own manifest instead.
    version="$(gh api -H 'Accept: application/vnd.github.raw' \
      repos/obsidianmd/obsidian-releases/contents/desktop-releases.json \
      --jq .latestVersion)"
    [[ -n "$version" ]] || {
      echo "❌ Could not resolve latest Obsidian desktop version" >&2
      exit 1
    }
  fi

  if [[ "$PLATFORM" == "macos" ]]; then
    # macOS: universal DMG works for both Intel and Apple Silicon
    pattern="Obsidian-*.dmg"
    echo "⏬ Downloading Obsidian ($version) dmg via gh CLI"
  else
    # Linux: select architecture-specific AppImage
    arch="$(uname -m)"
    if [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
      pattern="Obsidian-*-arm64.AppImage"
    elif [[ "$arch" == "x86_64" ]]; then
      # x86_64: download both then delete arm64 (gh doesn't support exclusion patterns)
      pattern="Obsidian-*.AppImage"
    else
      echo "❌ Unsupported architecture: $arch" >&2; exit 1
    fi
    echo "⏬ Downloading Obsidian ($version) AppImage for $arch via gh CLI"
  fi

  # NB: gh takes the tag as a positional arg; there is no --tag flag.
  gh release download "v${version}" -R obsidianmd/obsidian-releases \
    --pattern "$pattern" --dir "$tmp_dir"

  # On x86_64, remove the arm64 AppImage if both were downloaded
  if [[ "$PLATFORM" == "linux" && "$arch" == "x86_64" ]]; then
    rm -f "$tmp_dir"/*-arm64.AppImage
  fi

  if [[ "$PLATFORM" == "macos" ]]; then
    dmg_path="$(find "$tmp_dir" -name '*.dmg' -type f | head -n1)"
    [[ -n "$dmg_path" ]] || { echo "❌ .dmg not found" >&2; exit 1; }

    echo "📦 Mounting $(basename "$dmg_path")"
    mnt_dir="$tmp_dir/mnt"
    mkdir "$mnt_dir"
    hdiutil attach "$dmg_path" -mountpoint "$mnt_dir" -nobrowse -quiet
    trap 'hdiutil detach "$mnt_dir" -quiet || true' EXIT

    cp -R "$mnt_dir/Obsidian.app" "$tmp_dir/Obsidian.app"
    obsidian_app="$tmp_dir/Obsidian.app"

    hdiutil detach "$mnt_dir" -quiet
    trap - EXIT
  else
    appimage_path="$(find "$tmp_dir" -name '*.AppImage' -type f | head -n1)"
    [[ -n "$appimage_path" ]] || { echo "❌ .AppImage not found" >&2; exit 1; }

    echo "📦 Extracting $(basename "$appimage_path")"
    chmod +x "$appimage_path"
    # Extract AppImage to squashfs-root directory
    (cd "$tmp_dir" && "$appimage_path" --appimage-extract >/dev/null 2>&1)
    obsidian_app="$tmp_dir/squashfs-root"
  fi
fi

# ------------------------------------------------------------------------------
# 3. Extract app.asar and build test folder
# ------------------------------------------------------------------------------
echo "🔓 Unpacking $obsidian_app → $unpacked_path"

if [[ "$PLATFORM" == "macos" ]]; then
  asar_path="$obsidian_app/Contents/Resources/app.asar"
  obsidian_asar_path="$obsidian_app/Contents/Resources/obsidian.asar"
else
  # Linux: handle different installation types
  if [[ -f "$obsidian_app" && "$obsidian_app" == *.AppImage ]]; then
    # AppImage needs to be extracted first
    tmp_extract="$(mktemp -d)"
    chmod +x "$obsidian_app"
    (cd "$tmp_extract" && "$obsidian_app" --appimage-extract >/dev/null 2>&1)
    asar_path="$tmp_extract/squashfs-root/resources/app.asar"
    obsidian_asar_path="$tmp_extract/squashfs-root/resources/obsidian.asar"
  elif [[ -d "$obsidian_app/squashfs-root" ]]; then
    # Already extracted AppImage (CI mode)
    asar_path="$obsidian_app/squashfs-root/resources/app.asar"
    obsidian_asar_path="$obsidian_app/squashfs-root/resources/obsidian.asar"
  elif [[ -d "$obsidian_app" ]]; then
    # Flatpak, Snap, or extracted directory
    if [[ -f "$obsidian_app/resources/app.asar" ]]; then
      asar_path="$obsidian_app/resources/app.asar"
      obsidian_asar_path="$obsidian_app/resources/obsidian.asar"
    else
      # Search for asar files
      asar_path="$(find "$obsidian_app" -name 'app.asar' -type f 2>/dev/null | head -n1)"
      obsidian_asar_path="$(find "$obsidian_app" -name 'obsidian.asar' -type f 2>/dev/null | head -n1)"
    fi
  fi
fi

[[ -f "$asar_path" ]] || { echo "❌ app.asar not found at $asar_path" >&2; exit 1; }
[[ -f "$obsidian_asar_path" ]] || { echo "❌ obsidian.asar not found at $obsidian_asar_path" >&2; exit 1; }

# Build the new copy in a temp sibling folder and swap it in only once it is complete,
# so a failed or interrupted run (locked file, npx failure, Ctrl+C) leaves the existing
# copy untouched instead of empty.
staging_path="$(mktemp -d "$unpacked_path.tmp-XXXXXX")"
old_path="$unpacked_path.old-${staging_path##*.tmp-}"
swapped=0
keep_staging=0

restore_unpacked() {
  [[ "$swapped" == 0 ]] || return 0
  if [[ -e "$old_path" && ! -e "$unpacked_path" ]]; then
    mv "$old_path" "$unpacked_path" ||
      echo "⚠️  Could not restore the previous copy; rename $old_path to $unpacked_path by hand" >&2
  fi
  [[ "$keep_staging" == 1 ]] || rm -rf "$staging_path"
}
trap restore_unpacked EXIT
trap 'exit 130' INT TERM

if ! npx --yes @electron/asar extract "$asar_path" "$staging_path"; then
  echo "❌ Failed to extract app.asar; $unpacked_path left unchanged" >&2
  exit 1
fi
if ! cp "$obsidian_asar_path" "$staging_path/obsidian.asar"; then
  echo "❌ Failed to copy obsidian.asar; $unpacked_path left unchanged" >&2
  exit 1
fi

for required in main.js package.json obsidian.asar; do
  [[ -f "$staging_path/$required" ]] || {
    echo "❌ Unpacked copy is missing $required; $unpacked_path left unchanged" >&2
    exit 1
  }
done

if [[ -e "$unpacked_path" ]] && ! mv "$unpacked_path" "$old_path"; then
  # Usually a running Obsidian or e2e run holding a file open. The old copy is still
  # in place, so keep the new one for the user to swap in by hand.
  keep_staging=1
  echo "❌ Could not move the existing $unpacked_path aside (is Obsidian or an e2e run using it?)" >&2
  echo "   The new copy was kept at $staging_path." >&2
  echo "   Close Obsidian, then rerun this script, or delete $unpacked_path and rename $staging_path to $unpacked_path." >&2
  exit 1
fi

if ! mv "$staging_path" "$unpacked_path"; then
  echo "❌ Could not move the new copy into place; restoring $unpacked_path" >&2
  exit 1
fi
swapped=1
trap - EXIT INT TERM

if [[ -e "$old_path" ]] && ! rm -rf "$old_path"; then
  echo "⚠️  Could not delete the previous copy at $old_path; delete it once Obsidian is closed" >&2
fi

echo "✅ Obsidian unpacked"

# NOTE: Plugin files are symlinked to test vaults by createVaultCopy() in helpers.ts
# This allows each test run to use freshly built plugin files without re-running setup.

echo "🎉 setup-obsidian.sh finished!"