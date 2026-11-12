# ai-burnrate — Windows One-Liner Uninstaller
# Usage (Remote): irm https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/uninstall.ps1 | iex
# Usage (Local):  .\scripts\uninstall.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  🗑️  AI-BURNRATE UNINSTALLER" -ForegroundColor Yellow
Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor DarkGray

if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm uninstall -g ai-burnrate
    Write-Host "  ✓ ai-burnrate has been completely removed." -ForegroundColor Green
} else {
    Write-Host "  ✗ npm not found in PATH." -ForegroundColor Red
    exit 1
}
Write-Host ""
