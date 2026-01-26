#Requires -Version 5.1
<#
.SYNOPSIS
    Extract Obsidian and prepare E2E test directory (Windows)

.DESCRIPTION
    - Local           : Extract directly from installed Obsidian
    - GitHub Actions  : Get .exe installer from GitHub Releases and extract

.PARAMETER CI
    Run in CI mode (download from GitHub Releases instead of using local installation)

.EXAMPLE
    .\setup-obsidian.ps1
    Run in local mode, using installed Obsidian

.EXAMPLE
    .\setup-obsidian.ps1 -CI
    Run in CI mode, downloading Obsidian from GitHub Releases

.NOTES
    Environment Variables:
      OBSIDIAN_VERSION  - Specify a fixed version (e.g., 1.8.10). If not set, uses latest
      OBSIDIAN_PATH     - Override the path to local Obsidian installation
#>

[CmdletBinding()]
param(
    [switch]$CI
)

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------------------------
# 0. Setup paths
# ------------------------------------------------------------------------------
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootPath = Resolve-Path (Join-Path $scriptPath "..")
$vaultPath = Join-Path $rootPath "tests\test-vault"
$unpackedPath = Join-Path $rootPath ".obsidian-unpacked"
$pluginPath = Join-Path $vaultPath ".obsidian\plugins\incremental-reading"

Write-Host "Root path: $rootPath" -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# 1. Get Obsidian installation
# ------------------------------------------------------------------------------
if (-not $CI) {
    # Local mode: find installed Obsidian
    $obsidianPath = $env:OBSIDIAN_PATH

    if (-not $obsidianPath) {
        # Check common installation paths
        $progFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
        $commonPaths = @(
            (Join-Path $env:LOCALAPPDATA "Obsidian"),
            (Join-Path $env:ProgramFiles "Obsidian")
        )
        if ($progFilesX86) {
            $commonPaths += (Join-Path $progFilesX86 "Obsidian")
        }

        foreach ($path in $commonPaths) {
            $exeTest = Join-Path $path "Obsidian.exe"
            if (Test-Path $exeTest) {
                $obsidianPath = $path
                break
            }
        }
    }

    if (-not $obsidianPath -or -not (Test-Path $obsidianPath)) {
        Write-Error "Obsidian not found. Set OBSIDIAN_PATH or install Obsidian."
        exit 1
    }

    Write-Host "Found Obsidian at: $obsidianPath" -ForegroundColor Green
}
else {
    # CI mode: download from GitHub Releases
    $tmpDir = Join-Path $env:TEMP ("obsidian-setup-" + (Get-Random))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    $version = $env:OBSIDIAN_VERSION
    if (-not $version) {
        $version = "latest"
    }

    Write-Host "Downloading Obsidian ($version) via gh CLI" -ForegroundColor Yellow

    # Download the Windows installer (.exe)
    $pattern = "Obsidian-*.exe"

    if ($version -eq "latest") {
        & gh release download -R obsidianmd/obsidian-releases --pattern $pattern --dir $tmpDir
    }
    else {
        & gh release download -R obsidianmd/obsidian-releases --pattern $pattern --dir $tmpDir --tag "v$version"
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to download Obsidian"
        exit 1
    }

    $exePath = Get-ChildItem -Path $tmpDir -Filter "*.exe" | Select-Object -First 1
    if (-not $exePath) {
        Write-Error ".exe not found in download"
        exit 1
    }

    Write-Host "Extracting $($exePath.Name)" -ForegroundColor Yellow

    # Obsidian Windows installer is NSIS-based, we can extract with 7-Zip
    $extractPath = Join-Path $tmpDir "extracted"

    # Try to find 7-Zip
    $progFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
    $sevenZipPaths = @(
        (Join-Path $env:ProgramFiles "7-Zip\7z.exe"),
        "C:\7-Zip\7z.exe"
    )
    if ($progFilesX86) {
        $sevenZipPaths += (Join-Path $progFilesX86 "7-Zip\7z.exe")
    }

    $sevenZip = $null
    foreach ($szPath in $sevenZipPaths) {
        if (Test-Path $szPath) {
            $sevenZip = $szPath
            break
        }
    }

    if (-not $sevenZip) {
        # Try to use 7z from PATH (available in GitHub Actions)
        $cmd = Get-Command "7z" -ErrorAction SilentlyContinue
        if ($cmd) {
            $sevenZip = $cmd.Source
        }
    }

    if (-not $sevenZip) {
        Write-Error "7-Zip not found. Please install 7-Zip or add it to PATH."
        exit 1
    }

    # Extract NSIS installer using 7-Zip
    $outputArg = "-o" + $extractPath
    & $sevenZip x $exePath.FullName $outputArg -y | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to extract Obsidian installer"
        exit 1
    }

    # The extracted content should have the app files
    $obsidianPath = $extractPath

    # Check if there is a nested NSIS structure
    $pluginsDir = Join-Path $extractPath "`$PLUGINSDIR"
    if (Test-Path $pluginsDir) {
        # NSIS installer - look for app-64.7z or similar
        $app7z = Get-ChildItem -Path $extractPath -Filter "app-*.7z" -Recurse | Select-Object -First 1
        if ($app7z) {
            $appExtractPath = Join-Path $extractPath "app"
            $appOutputArg = "-o" + $appExtractPath
            & $sevenZip x $app7z.FullName $appOutputArg -y | Out-Null
            $obsidianPath = $appExtractPath
        }
    }

    Write-Host "Obsidian extracted to: $obsidianPath" -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 2. Extract app.asar
# ------------------------------------------------------------------------------
Write-Host "Unpacking Obsidian to $unpackedPath" -ForegroundColor Yellow

if (Test-Path $unpackedPath) {
    Remove-Item -Path $unpackedPath -Recurse -Force
}

# Find asar files - Windows uses resources/ folder
$asarPath = $null
$obsidianAsarPath = $null

# Check common locations
$resourcesPaths = @(
    (Join-Path $obsidianPath "resources"),
    $obsidianPath
)

foreach ($resPath in $resourcesPaths) {
    $testAsar = Join-Path $resPath "app.asar"
    if (Test-Path $testAsar) {
        $asarPath = $testAsar
        $obsidianAsarPath = Join-Path $resPath "obsidian.asar"
        break
    }
}

# Fallback: search recursively
if (-not $asarPath) {
    $foundAsar = Get-ChildItem -Path $obsidianPath -Filter "app.asar" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($foundAsar) {
        $asarPath = $foundAsar.FullName
        $obsidianAsarPath = Join-Path $foundAsar.DirectoryName "obsidian.asar"
    }
}

if (-not $asarPath -or -not (Test-Path $asarPath)) {
    Write-Error "app.asar not found in $obsidianPath"
    exit 1
}

if (-not (Test-Path $obsidianAsarPath)) {
    Write-Error "obsidian.asar not found at $obsidianAsarPath"
    exit 1
}

Write-Host "  Found app.asar: $asarPath" -ForegroundColor Gray
Write-Host "  Found obsidian.asar: $obsidianAsarPath" -ForegroundColor Gray

# Extract using @electron/asar
& npx --yes "@electron/asar" extract $asarPath $unpackedPath

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to extract app.asar"
    exit 1
}

Copy-Item -Path $obsidianAsarPath -Destination (Join-Path $unpackedPath "obsidian.asar")

Write-Host "Obsidian unpacked" -ForegroundColor Green

# ------------------------------------------------------------------------------
# 3. Build plugin and link to Vault
# ------------------------------------------------------------------------------
Write-Host "Building plugin..." -ForegroundColor Yellow

Push-Location $rootPath
try {
    & npm run build --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed"
        exit 1
    }
}
finally {
    Pop-Location
}

Write-Host "Build done." -ForegroundColor Green

Write-Host "Linking plugin to $pluginPath" -ForegroundColor Yellow

# Create plugin directory
if (-not (Test-Path $pluginPath)) {
    New-Item -ItemType Directory -Path $pluginPath -Force | Out-Null
}

# On Windows, we copy files instead of symlinks (symlinks require admin rights)
# For CI, copying is fine. For local dev, we could use junctions or just copy.
$manifestSource = Join-Path $rootPath "..\manifest.json"
$mainSource = Join-Path $rootPath "..\main.js"

Copy-Item -Path $manifestSource -Destination (Join-Path $pluginPath "manifest.json") -Force
Copy-Item -Path $mainSource -Destination (Join-Path $pluginPath "main.js") -Force

Write-Host "setup-obsidian.ps1 finished!" -ForegroundColor Green
