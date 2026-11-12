#!/usr/bin/env bash
# ai-burnrate — macOS / Linux One-Liner Uninstaller
# Usage (Remote): curl -fsSL https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/uninstall.sh | bash
# Usage (Local):  ./scripts/uninstall.sh

set -euo pipefail

echo ""
echo -e "\033[1;33m  🗑️  AI-BURNRATE UNINSTALLER\033[0m"
echo -e "\033[90m  ──────────────────────────────────────────────────\033[0m"

if command -v npm >/dev/null 2>&1; then
  npm uninstall -g ai-burnrate
  echo -e "\033[1;32m  ✓ ai-burnrate has been completely removed.\033[0m"
else
  echo -e "\033[1;31m  ✗ npm not found in PATH.\033[0m"
  exit 1
fi
echo ""
