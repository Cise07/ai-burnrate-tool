<div align="center">

# 🔥 ai-burnrate ⚡

**Real-Time Local Token & Equivalent API Cost Tracker for Antigravity CLI & Claude Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg?style=flat-square)](https://github.com/Cise07/ai-burnrate-tool)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-06b6d4.svg?style=flat-square)](https://nodejs.org/)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Cise07%2Fai--burnrate--tool-d946ef.svg?style=flat-square)](https://github.com/Cise07/ai-burnrate-tool)
[![100% Local](https://img.shields.io/badge/Privacy-100%25%20Local-f59e0b.svg?style=flat-square)](#)

Track in real time how many tokens you are consuming across **Antigravity CLI** (`~/.gemini`) and **Claude Code** (`~/.claude`), what your equivalent pay-as-you-go API spend would be in **USD (`$`) or EUR (`€`)**, and how much money you are saving through Prompt Caching and your monthly subscriptions.

</div>

---

## ✨ Key Features

- 🔒 **100% Local, Dynamic & Cross-Platform:** Automatically resolves your user home directory (`os.homedir()` → `~/.gemini` and `~/.claude`) on Windows, macOS, and Linux with zero hardcoded paths. You can also override watched folders via `BURNRATE_GEMINI_DIR` and `BURNRATE_CLAUDE_DIR`.
- 🟢 **Live Dashboard & Server-Sent Events (SSE):** A background file watcher (`chokidar`) monitors your active AI transcripts and pushes instant real-time updates to charts, KPIs, and session tables in the browser via `/api/events`.
- 🔄 **Automatic Official Price Sync & Historical Tariff Protection:** On startup (and on manual rescan), `ai-burnrate` automatically fetches the latest official per-token model prices from the public **LiteLLM Pricing Registry** and the official repository feed. Whenever a model's price changes, a new timestamped rate snapshot (`effectiveFrom`) is appended to `~/.burnrate/pricing-ledger.json`—**tokens consumed before the price change are never recalculated**, and the new tariff applies strictly to turns recorded after the change.
- 💱 **Instant `$ USD` / `€ EUR` Currency Switch:** Toggle the entire dashboard (KPI cards, monthly subscription comparison, charts, and live session table) between US Dollars and Euros with persistent `localStorage` state.
- 🧠 **Granular Per-Model Token Breakdown:** Dedicated central widget and ANSI CLI tables breaking down *Input (Uncached)*, *Cache Read (Context)*, and *Output (Thinking + Response/Code)* with automatic streaming chunk deduplication.
- 🖥️ **Instant Terminal Mode (`--cli`):** Prints colorized ANSI tables (Tool Breakdown, Model Breakdown, and Top 12 Recent Sessions) directly in your terminal and exits immediately.

---

## 🚀 Quick Install (Latest Version)

You don't need to manually download or clone the repository—simply paste **one command** into your terminal from any directory. The installer automatically resolves the latest GitHub Release (falling back to `main` if none exist yet).

> ⚠️ **Prerequisite:** Make sure you have [Node.js (>= 18)](https://nodejs.org/) and `npm` installed.

### 🪟 Windows (PowerShell)
Open PowerShell and run:
```powershell
irm https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.ps1 | iex
```
> 💡 **Note on Windows permissions:** If PowerShell blocks the script with an `ExecutionPolicy` or permission error, enable script execution for your user by running:
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

### 🍎 macOS / 🐧 Linux (Bash / Zsh)
Open your terminal and run:
```bash
curl -fsSL https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.sh | bash
```

### 📦 Universal Alternative via `npm` (Cross-Platform)
```bash
npm install -g https://github.com/Cise07/ai-burnrate-tool/archive/main.tar.gz
```

*(Want to run it once without installing? Use `npx https://github.com/Cise07/ai-burnrate-tool/archive/main.tar.gz`)*

### 🏷️ Install a Specific Release Version
To pin a specific release tag (e.g., `v1.0.1`), use the release tarball directly or pass `BURNRATE_VERSION` to the installer:

```bash
# Universal (recommended for GitHub Release notes)
npm install -g https://github.com/Cise07/ai-burnrate-tool/archive/refs/tags/vX.Y.Z.tar.gz
```

```powershell
# Windows PowerShell
$env:BURNRATE_VERSION="vX.Y.Z"; irm https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.ps1 | iex
```

```bash
# macOS / Linux
BURNRATE_VERSION=vX.Y.Z curl -fsSL https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/install.sh | bash
```

---

## 🛠️ Install from Local Clone (For Developers)

If you clone the repository locally, the installer script automatically detects `package.json`, installs dependencies, compiles both the React frontend (`dist/public`) and CLI (`dist/cli`), and registers the global `burnrate` binary:

```bash
# 1. Clone the repository
git clone https://github.com/Cise07/ai-burnrate-tool.git
cd ai-burnrate-tool

# 2. Build and install globally
.\scripts\install.ps1   # Windows PowerShell
./scripts/install.sh    # macOS / Linux
# Or via npm script:
npm run setup
```

---

## 🎮 Usage & CLI Flags

Once installed, the **`burnrate`** (or **`ai-burnrate`**) command is available globally from **any folder** in your terminal:

| Command | Description |
| :--- | :--- |
| `burnrate` | 🟢 **Live Mode (Default):** Syncs official pricing, starts the local HTTP + SSE server, watches `~/.gemini` & `~/.claude`, and opens the React Dashboard in your browser. |
| `burnrate --cli` | 📊 **Terminal Mode:** Syncs pricing, prints the full token & cost report in colorized ANSI tables in the terminal, and exits immediately. |
| `burnrate --no-open` | 🔇 **Headless Mode:** Starts the live server and file watcher without automatically opening the browser. |
| `burnrate -p, --port <number>` | 🔌 **Custom Port:** Starts the dashboard on a specific port (default: `4321`, automatically falling back to the next free port if busy). |
| `burnrate --update` | 🔄 **Self-Update:** Updates `ai-burnrate` to the latest release directly from GitHub. |
| `burnrate --uninstall` | 🗑️ **Self-Uninstall:** Completely removes the global `burnrate` package from your system. |
| `burnrate -V, --version` | 🏷️ Prints the installed version (`1.0.0`). |
| `burnrate -h, --help` | ℹ️ Displays all available CLI options. |

> 💡 **Clean Shutdown:** While running in live mode (`burnrate`), press `Ctrl+C` (`SIGINT`) to cleanly close all SSE streams, active HTTP sockets, and the `chokidar` file watcher.

---

## 🗑️ How to Uninstall `ai-burnrate`

You can remove the tool at any time using any of the following methods:

### 1️⃣ Built-in CLI Flag (Recommended)
From any directory in your terminal, simply run:
```bash
burnrate --uninstall
```

### 2️⃣ Via `npm`
```bash
npm uninstall -g ai-burnrate-tool
```

### 3️⃣ Via One-Liner Script
- **Windows (PowerShell):**
  ```powershell
  irm https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/uninstall.ps1 | iex
  ```
- **macOS / Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/scripts/uninstall.sh | bash
  ```

---

## 💰 How Pricing & Historical Rate Versioning Work

`ai-burnrate` uses a time-versioned pricing engine (`src/core/pricing.ts`) so that price updates from AI providers never distort your past spending history:

1. **Initial Seed (`config/pricing.json`):** Provides the initial baseline rates (effective from `1970-01-01T00:00:00.000Z`) and offline fallback for **Claude** (*Opus 4.x, Sonnet 4.x, 3.7 Sonnet, 3.5 Sonnet, Haiku*) and **Google Gemini** (*Gemini 4 Argon, Gemini Pro, Gemini 3.8 Flash High, Gemini Flash, Flash-Lite*).
2. **Automatic Live Sync (`syncOfficialPricing`):** At launch and whenever you click the **Rescan** button in the UI, `ai-burnrate` queries the official **LiteLLM Model Pricing Registry** and the GitHub repository feed (with a 3.5s non-blocking timeout for offline resilience).
3. **Immutable Historical Ledger (`~/.burnrate/pricing-ledger.json`):**
   - When the sync detects that a provider has changed a model's `input`, `output`, `cacheRead`, or `cacheWrite` rate, it **does not overwrite** previous rates.
   - Instead, it appends a new `RateSnapshot` to the `history` array in `~/.burnrate/pricing-ledger.json` stamped with `effectiveFrom: <current ISO timestamp>`.
4. **Per-Turn Timestamp Matching (`getHistoricalRate`):**
   - Every turn parsed from `~/.gemini` and `~/.claude` has its own `timestamp`.
   - `calculateTurnCost` matches each turn's timestamp against `pricing.history` (`snapshot.effectiveFrom <= turn.timestamp`).
   - All tokens used **before** a price change remain permanently valued at the old rate, while tokens used **after** the price change are valued at the new rate.

---

## 📊 Dashboard Overview

- **🔝 Non-Wrapping Top Bar:** Displays the pulsing `LIVE` SSE connection badge, tool filter (`All`, `Antigravity`, `Claude`), time window selector (`24h`, `7d`, `30d`, `all`), `$ USD` / `€ EUR` currency switch, and manual rescan button.
- **💸 4 Top KPI Cards:**
  1. **API Equivalent Spend:** Total spend with per-tool split (`AGY` vs `Claude`) and ROI multiplier against monthly subscription plans.
  2. **Total Tokens:** Cumulative tokens processed across all LLM turns, split into `Input`, `Output`, and `Cached`.
  3. **Cache Savings:** Total money saved via context caching and overall *Cache Hit Ratio* percentage.
  4. **Sessions & Projects:** Active sessions count, distinct workspaces count, and average cost per session.
- **📈 Interactive Charts & Model Token Widget:**
  - **Daily API Burn Rate:** Stacked area chart comparing Antigravity CLI and Claude Code spend over time.
  - **Cost by Model:** Horizontal bar chart ranking spend by model.
  - **Total Token Usage by Model:** Central grid showing total tokens, percentage share, and `Input / Cached / Output` breakdown for every model.
- **🗂️ Live Sessions & Workspaces Table:** Real-time searchable table displaying tool badge, relative workspace path (`~/...`), primary model, turns, input/output tokens, cache read tokens, cache savings, API cost, and relative last-active time.

---

## 📁 Project Structure

```text
ai-burnrate/
├── config/
│   └── pricing.json        # Initial baseline model rates & subscription references
├── scripts/
│   ├── install.ps1         # Windows remote one-liner & local installer
│   ├── uninstall.ps1       # Windows one-liner uninstaller
│   ├── install.sh          # macOS/Linux remote one-liner & local installer
│   └── uninstall.sh        # macOS/Linux one-liner uninstaller
├── src/
│   ├── cli/
│   │   ├── index.ts        # CLI entrypoint (#!/usr/bin/env node)
│   │   └── reporter.ts     # ANSI terminal table formatter (--cli)
│   ├── core/
│   │   ├── parser.ts       # Dynamic ~/.gemini & ~/.claude JSONL parser
│   │   ├── pricing.ts      # Official price auto-sync & historical rate ledger
│   │   ├── watcher.ts      # Real-time file watcher with chokidar
│   │   └── types.ts        # Shared TypeScript interfaces
│   ├── server/
│   │   └── index.ts        # Local HTTP server + SSE stream (/api/events)
│   └── web/
│       ├── App.tsx         # Dark Mode React Dashboard + USD/EUR toggle
│       ├── main.tsx        # React entrypoint
│       └── index.css       # Tailwind CSS styles
├── dist/                   # Prebuilt bundle (CLI + static web assets)
└── package.json
```

---

## 📄 License

Distributed under the **MIT** License by [Cise07](https://github.com/Cise07). Feel free to open Issues or Pull Requests! ❤️
