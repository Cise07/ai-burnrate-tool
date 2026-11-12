# ai-burnrate — Windows One-Liner Installer
# Usage (Remote): irm https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.ps1 | iex
# Usage (Local):  .\scripts\install.ps1

$ErrorActionPreference = "Stop"
$RepoUrl = if ($env:BURNRATE_REPO) { $env:BURNRATE_REPO } else { "https://github.com/Cise07/ai-burnrate-tool/archive/main.tar.gz" }

Write-Host ""
Write-Host "  ⚡ AI-BURNRATE INSTALLER" -ForegroundColor Green
Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "  ✗ Node.js (>= 18) and npm are required." -ForegroundColor Red
    Write-Host "    Download from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$NodeVersion = (node -v)
Write-Host "  ✓ Found Node.js $NodeVersion" -ForegroundColor Cyan

if (Test-Path ".\package.json") {
    $Pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
    if ($Pkg.name -eq "ai-burnrate") {
        Write-Host "  ● Installing from local repository..." -ForegroundColor Yellow
        npm install --silent
        npm run build
        npm install -g .
        Write-Host ""
        Write-Host "  ✓ ai-burnrate installed globally!" -ForegroundColor Green
        Write-Host "    Run:       burnrate          (Live Web Dashboard)" -ForegroundColor White
        Write-Host "    Run CLI:   burnrate --cli    (Terminal Report)" -ForegroundColor White
        Write-Host "    Uninstall: burnrate --uninstall" -ForegroundColor DarkGray
        Write-Host ""
        return
    }
}

Write-Host "  ● Installing globally from $RepoUrl ..." -ForegroundColor Yellow
npm install -g $RepoUrl

Write-Host ""
Write-Host "  ✓ ai-burnrate installed globally!" -ForegroundColor Green
Write-Host "    Run:       burnrate          (Live Web Dashboard)" -ForegroundColor White
Write-Host "    Run CLI:   burnrate --cli    (Terminal Report)" -ForegroundColor White
Write-Host "    Uninstall: burnrate --uninstall" -ForegroundColor DarkGray
Write-Host ""
