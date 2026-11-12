#!/usr/bin/env bash
# ai-burnrate — macOS / Linux One-Liner Installer
# Usage (Remote): curl -fsSL https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.sh | bash
# Usage (Local):  ./scripts/install.sh

set -euo pipefail

REPO_URL="${BURNRATE_REPO:-https://github.com/Cise07/ai-burnrate-tool/archive/main.tar.gz}"

echo ""
echo -e "\033[1;32m  ⚡ AI-BURNRATE INSTALLER\033[0m"
echo -e "\033[90m  ──────────────────────────────────────────────────\033[0m"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo -e "\033[1;31m  ✗ Node.js (>= 18) and npm are required.\033[0m"
  echo -e "    Download from: https://nodejs.org/"
  exit 1
fi

echo -e "\033[36m  ✓ Found Node.js $(node -v)\033[0m"

if [ -f "./package.json" ] && grep -q '"ai-burnrate"' "./package.json"; then
  echo -e "\033[33m  ● Installing from local repository...\033[0m"
  npm install --silent
  npm run build
  npm install -g .
else
  echo -e "\033[33m  ● Installing globally from ${REPO_URL} ...\033[0m"
  npm install -g "${REPO_URL}"
fi

echo ""
echo -e "\033[1;32m  ✓ ai-burnrate installed globally!\033[0m"
echo -e "    Run:       \033[1mburnrate\033[0m          (Live Web Dashboard)"
echo -e "    Run CLI:   \033[1mburnrate --cli\033[0m    (Terminal Report)"
echo -e "    Uninstall: \033[90mburnrate --uninstall\033[0m"
echo ""
