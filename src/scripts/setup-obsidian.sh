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
#   OBSIDIAN_VERSION  Specify a fixed version (e.g., 1.8.10). If not set, uses latest
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
vault_path="$root_path/tests/test-vault"
unpacked_path="$root_path/.obsidian-unpacked"
plugin_path="$vault_path/.obsidian/plugins/incremental-reading"

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
        obsidian_app="/var/lib/flatpak/app/md.obsidian.Obsidian/current/active/files/obsidian"
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

  if [[ "$PLATFORM" == "macos" ]]; then
    pattern="Obsidian-*.dmg"
    echo "⏬ Downloading Obsidian ($version) dmg via gh CLI"
  else
    pattern="Obsidian-*.AppImage"
    echo "⏬ Downloading Obsidian ($version) AppImage via gh CLI"
  fi

  if [[ "$version" == "latest" ]]; then
    gh release download -R obsidianmd/obsidian-releases \
      --pattern "$pattern" --dir "$tmp_dir"
  else
    gh release download -R obsidianmd/obsidian-releases \
      --pattern "$pattern" --dir "$tmp_dir" --tag "v${version}"
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
rm -rf "$unpacked_path"

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

npx --yes @electron/asar extract "$asar_path" "$unpacked_path"
cp "$obsidian_asar_path" "$unpacked_path/obsidian.asar"

echo "✅ Obsidian unpacked"

# ------------------------------------------------------------------------------
# 4. Build plugin and link to Vault
# ------------------------------------------------------------------------------
echo "🔧 Building plugin…"
npm run build --silent
echo "✅ Build done."

echo "🔗 Linking plugin → $plugin_path"
mkdir -p "$plugin_path"
ln -fs "$root_path/manifest.json" "$plugin_path/manifest.json"
ln -fs "$root_path/main.js"       "$plugin_path/main.js"

echo "🎉 setup-obsidian.sh finished!"