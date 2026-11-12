$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  * AI-BURNRATE UNINSTALLER" -ForegroundColor Yellow
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray

if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm uninstall -g ai-burnrate
    Write-Host "  + ai-burnrate has been completely removed." -ForegroundColor Green
} else {
    Write-Host "  x npm not found in PATH." -ForegroundColor Red
    exit 1
}
Write-Host ""