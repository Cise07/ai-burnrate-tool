$ErrorActionPreference = "Stop"
$RepoSlug = "Cise07/ai-burnrate-tool"
$RepoUrl = $env:BURNRATE_REPO
if (-not $RepoUrl) {
    if ($env:BURNRATE_VERSION) {
        $Tag = if ($env:BURNRATE_VERSION.StartsWith("v")) { $env:BURNRATE_VERSION } else { "v$($env:BURNRATE_VERSION)" }
        $RepoUrl = "https://github.com/$RepoSlug/archive/refs/tags/$Tag.tar.gz"
    } else {
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases/latest" -Headers @{ "User-Agent" = "ai-burnrate-installer" } -TimeoutSec 4
            if ($Release.tag_name) {
                $RepoUrl = "https://github.com/$RepoSlug/archive/refs/tags/$($Release.tag_name).tar.gz"
            }
        } catch {
            # Fallback to main branch if no release is published yet
        }
        if (-not $RepoUrl) {
            $RepoUrl = "https://github.com/$RepoSlug/archive/refs/heads/main.tar.gz"
        }
    }
}

Write-Host ""
Write-Host "  * AI-BURNRATE INSTALLER" -ForegroundColor Green
Write-Host "  --------------------------------------------------" -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "  x Node.js (>= 18) and npm are required." -ForegroundColor Red
    Write-Host "    Download from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$NodeVersion = (node -v)
Write-Host "  + Found Node.js $NodeVersion" -ForegroundColor Cyan

if (Test-Path ".\package.json") {
    $Pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
    if ($Pkg.name -eq "ai-burnrate-tool") {
        Write-Host "  * Installing from local repository..." -ForegroundColor Yellow
        npm install --silent
        npm run build
        npm install -g .
        Write-Host ""
        Write-Host "  + ai-burnrate installed globally!" -ForegroundColor Green
        Write-Host "    Run:       burnrate          (Live Web Dashboard)" -ForegroundColor White
        Write-Host "    Run CLI:   burnrate --cli    (Terminal Report)" -ForegroundColor White
        Write-Host "    Uninstall: burnrate --uninstall" -ForegroundColor DarkGray
        Write-Host ""
        return
    }
}

Write-Host "  * Installing globally from $RepoUrl ..." -ForegroundColor Yellow
npm install -g $RepoUrl

Write-Host ""
Write-Host "  + ai-burnrate installed globally!" -ForegroundColor Green
Write-Host "    Run:       burnrate          (Live Web Dashboard)" -ForegroundColor White
Write-Host "    Run CLI:   burnrate --cli    (Terminal Report)" -ForegroundColor White
Write-Host "    Uninstall: burnrate --uninstall" -ForegroundColor DarkGray
Write-Host ""