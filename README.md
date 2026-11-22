<div align="center">

# 🔥 ai-burnrate-tool ⚡

**Real-Time Local Token & Equivalent API Cost Tracker for Antigravity CLI, Claude Code & Codex CLI**

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg?style=flat-square)](https://github.com/Cise07/ai-burnrate-tool)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-06b6d4.svg?style=flat-square)](https://nodejs.org/)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Cise07%2Fai--burnrate--tool-d946ef.svg?style=flat-square)](https://github.com/Cise07/ai-burnrate-tool)
[![100% Local](https://img.shields.io/badge/Privacy-100%25%20Local-f59e0b.svg?style=flat-square)](#)

Track in real time how many tokens you are consuming across **Antigravity CLI** (`~/.gemini`), **Claude Code** (`~/.claude`), and **Codex CLI** (`~/.codex`), what your equivalent pay-as-you-go API spend would be in **USD (`$`) or EUR (`€`)**, and how much value you get from Prompt Caching and your monthly subscriptions.

</div>

---

## ✨ Key Features

- 🔒 **100% Local, Dynamic & Cross-Platform:** Automatically resolves your home directory (`~/.gemini`, `~/.claude`, `~/.codex`) on Windows, macOS, and Linux with zero hardcoded paths. Override watched folders anytime via `BURNRATE_GEMINI_DIR`, `BURNRATE_CLAUDE_DIR`, and `BURNRATE_CODEX_DIR`.
- 🤖 **Automatic Subagent Roll-Up & Tool Breakdown:** Subagent sessions spawned by Antigravity CLI (e.g., `image-generator`, `research`) or Claude Code (`/subagents/*.jsonl`) are automatically merged into their parent chat without double-counting, while clearly distinguishing each subagent's own turns, models, tokens, API cost, and cost share.
- 🗑️ **Deleted Chats Archive & Offline Auto-Archive Hooks:** Automatically installs lightweight lifecycle hooks for Antigravity & Claude Code (`--sync-ledger`) so completed turns are snapshotted into `~/.burnrate/sessions-ledger.json` even when the dashboard is closed—preserving exact API spend and models if you later delete a chat.
- 📱 **Mobile & LAN Access with `ai-burnrate.local` (mDNS) + 6-Digit PIN + QR Code:** Running `burn` binds to `0.0.0.0`, advertises **`http://ai-burnrate.local:<port>`** via built-in local mDNS/Bonjour (with LAN IP fallback), and prints a random **6-digit access code** + scannable **terminal QR code** so you can monitor your dashboard live from your phone over Wi-Fi. Localhost stays instant-access, while LAN clients require the PIN (constant-time verification, per-IP rate limiting, and `HttpOnly` session cookies).
- 🟢 **Live Dashboard & Server-Sent Events (SSE):** A background file watcher (`chokidar`) monitors active transcripts and pushes instant real-time updates to charts, KPIs, heatmap, and session tables via `/api/events`.
- 🔄 **Automatic Official Price Sync & Historical Tariff Protection:** On startup and manual rescan, `ai-burnrate-tool` fetches official per-token prices from the **LiteLLM Pricing Registry** and appends timestamped snapshots (`effectiveFrom`) to `~/.burnrate/pricing-ledger.json`—past turns are never recalculated when prices change.
- 💱 **Instant `$ USD` / `€ EUR` Switch & Tax-Accurate Subscriptions:** API equivalent spend stays pure net pay-as-you-go, while customizable monthly subscription plans (Google AI, Claude, Codex/ChatGPT) automatically sync to the active currency and include local retail taxes (+22% VAT in EUR, +7.5% Sales Tax in USD).
- 🧩 **Customizable Dashboard Layout:** Reorder or hide any dashboard section (KPIs, Charts, Activity Heatmap & Top Workspaces, Model Breakdown, Live Workspaces Table) directly from Settings with persistence in `~/.burnrate/settings.json`.
- 🖥️ **Instant Terminal Mode (`--cli`):** Prints colorized ANSI tables (Tool Breakdown, Model Breakdown, grouped Workspaces → Chats → Subagents hierarchy, and Deleted Chats) directly in your terminal, with optional `--eur`, `--tool`, `--range`, and `--json` flags.

---

## 🚀 Quick Install (Windows / macOS / Linux)

Install globally from npm using **one command** from any terminal:

> ⚠️ **Prerequisite:** Make sure you have [Node.js (>= 18)](https://nodejs.org/) and `npm` installed.

### Latest Version
```bash
npm install -g ai-burnrate-tool
```

*(Want to run it once without installing? Use `npx ai-burnrate-tool`)*

### 🏷️ Install a Specific Version
To install a specific release, specify the version tag:
```bash
npm install -g ai-burnrate-tool@X.Y.Z
```

---

## 🎮 Usage & CLI Flags

Once installed, the **`burn`** command is available globally from **any folder** in your terminal:

| Command | Description |
| :--- | :--- |
| `burn` | 🟢 **Live Mode (Default):** Syncs official pricing, ensures offline archive hooks are active, starts the HTTP + SSE server on `0.0.0.0` (localhost + protected LAN access via 6-digit PIN & terminal QR), watches `~/.gemini`, `~/.claude` & `~/.codex`, and opens the React Dashboard in your browser. |
| `burn --cli` | 📊 **Terminal Mode:** Syncs pricing, prints the workspace/chat/subagent token & cost report in colorized ANSI tables, and exits immediately. |
| `burn --eur` | 💶 **EUR Mode (Web UI & CLI):** Sets the currency to EUR (`€`) instead of USD (`$`) in the browser dashboard and terminal report. |
| `burn --tool <tool>` | 🔎 **Tool Filter (Web UI & CLI):** Filters the browser dashboard and `--cli` output by `all`, `antigravity`, `claude`, or `codex`. |
| `burn --range <range>` | 🕒 **Time Range (Web UI & CLI):** Filters the browser dashboard and `--cli` output by `24h`, `7d`, `30d`, or `all`. |
| `burn --cli --json` | 🧾 **CLI JSON Output:** Prints aggregated workspaces, chats, subagents, and per-model breakdowns as JSON. |
| `burn --no-open` | 🔇 **Headless Mode:** Starts the live server and file watcher without automatically opening the browser. |
| `burn --no-hooks` | 🔕 **Skip Hooks:** Launches without installing Antigravity/Claude offline archive hooks. |
| `burn --uninstall-hooks` | 🧹 **Remove Hooks:** Removes `ai-burnrate-tool` offline archive hooks from Antigravity/Claude configs. |
| `burn -p, --port <number>` | 🔌 **Custom Port:** Starts the dashboard on a specific port (default: `4321`, automatically falling back to the next free port if busy). |
| `burn --update` | 🔄 **Self-Update:** Updates `ai-burnrate-tool` to the latest version from npm. |
| `burn --uninstall` | 🗑️ **Self-Uninstall:** Removes offline hooks and uninstalls the global `ai-burnrate-tool` package from your system. |
| `burn -V, --version` | 🏷️ Prints the installed version. |
| `burn -h, --help` | ℹ️ Displays all available CLI options. |

> 💡 **Clean Shutdown:** While running in live mode (`burn`), press `Ctrl+C` (`SIGINT`) to cleanly close all SSE streams, active HTTP sockets, and the `chokidar` file watcher.

---

## 🗑️ How to Uninstall `ai-burnrate-tool`

You can remove the tool at any time using either method:

### 1️⃣ Built-in CLI Flag (Recommended)
```bash
burn --uninstall
```

### 2️⃣ Via `npm`
```bash
npm uninstall -g ai-burnrate-tool
```

---

## 💰 How Pricing & Historical Rate Versioning Work

`ai-burnrate-tool` uses a time-versioned pricing engine (`src/core/pricing.ts`) so provider price updates never distort past spending history:

1. **Initial Seed (`config/pricing.json`):** Provides baseline rates (effective from `1970-01-01T00:00:00.000Z`) and offline fallback for **Claude** (*Opus 5.5 / 4.x, Sonnet 4.x, Haiku*), **Google Gemini** (*Gemini 4 Argon / Carbon / Neon / Hydrogen, 3.8 Flash, 2.5 Pro / Flash / Flash-Lite*), and **OpenAI / Codex** (*GPT-6.2 Astra / Sol, GPT-6.1 Sol / Terra, GPT-6 Astra / Sol / Luna / Cyber / Rosalind, GPT-5.6 Sol / Terra / Luna / Cyber, GPT-5.5 / 5.5 Pro / 5.5 Cyber, GPT-5.4 / Pro / Mini / Nano, GPT-5.3 / 5.2 / 5.1 / 5 Codex, GPT-4.1, o3 / o3-pro / o3-mini, o4-mini*).
2. **Automatic Live Sync (`syncOfficialPricing`):** At launch and on manual **Rescan**, `ai-burnrate-tool` queries the official **LiteLLM Model Pricing Registry** and repository feed (with a 3.5s non-blocking timeout for offline resilience).
3. **Immutable Historical Ledger (`~/.burnrate/pricing-ledger.json`):** Whenever a model's `input`, `output`, `cacheRead`, or `cacheWrite` rate changes, a new `RateSnapshot` stamped with `effectiveFrom` is appended without overwriting historical rates.
4. **Per-Turn Timestamp Matching (`getHistoricalRate`):** Each parsed turn matches its timestamp against `pricing.history`, keeping prior turns permanently valued at their original tariff.

---

## 📊 Dashboard Overview

- **🔝 Responsive Top Navigation Bar:** Displays the `ai-burnrate-tool` logo, pulsing `LIVE` SSE badge, tool filter (`All`, `Antigravity`, `Claude`, `Codex`), time range (`24h`, `7d`, `30d`, `all`), `$ USD` / `€ EUR` switch, Deleted Chats archive, Settings/Layout modal, and manual rescan button.
- **💸 4 Top KPI Cards (with Period-over-Period Deltas):**
  1. **API Equivalent Spend:** Total net API spend, per-tool split (`AGY • Claude • Codex` in `All` view), customizable subscription plan ROI comparison, and today's spend.
  2. **Total Tokens:** Cumulative tokens split into `Input`, `Output`, and `Cached`.
  3. **Cache Savings:** Money saved via context caching and overall *Cache Hit Ratio*.
  4. **Sessions & Projects:** Active sessions, distinct workspaces, deleted chats badge, and average cost per session.
- **📈 Interactive Charts, Heatmap & Model Breakdown:**
  - **Daily API Burn Rate:** Area chart comparing Antigravity, Claude Code, and Codex CLI curves (or isolating the selected tool).
  - **Cost by Model** & **Total Token Usage by Model** with per-1M token tariff display and promo badges.
  - **13-Week Activity Heatmap & Top Workspaces:** GitHub-style daily intensity calendar alongside top spending workspaces.
- **🗂️ Live Workspaces, Chats & Subagent Breakdown:** Searchable, multi-column sortable workspace hierarchy with expandable chat cards showing per-model and **Main Chat vs Subagent Tools** consumption tables, plus filtered **CSV / JSON** export.

---

## 📁 Project Structure

```text
ai-burnrate-tool/
├── config/
│   └── pricing.json                # Baseline model tariffs & subscription presets
├── public/
│   └── logo.svg                    # Dashboard brand icon & favicon
├── src/
│   ├── cli/
│   │   ├── index.ts                # CLI entrypoint (`burn`) & terminal QR output
│   │   └── reporter.ts             # ANSI terminal report formatter (--cli)
│   ├── core/
│   │   ├── analytics.ts            # Filtering, subagent/model breakdowns, heatmap, CSV/JSON export
│   │   ├── hooks.ts                # Antigravity & Claude offline auto-archive lifecycle hooks
│   │   ├── mdns.ts                 # Built-in RFC 6762 mDNS responder (`ai-burnrate.local`)
│   │   ├── parser.ts               # Dynamic ~/.gemini, ~/.claude & ~/.codex JSONL parser & subagent merge
│   │   ├── pricing.ts              # Official price auto-sync & historical rate ledger
│   │   ├── session-ledger.ts       # Persistent session archive & legacy deleted dismissal
│   │   ├── settings.ts             # Persistent user subscription plans & dashboard layout
│   │   ├── watcher.ts              # Real-time chokidar file watcher
│   │   └── types.ts                # Shared TypeScript interfaces
│   ├── server/
│   │   └── index.ts                # HTTP/SSE server (0.0.0.0 bind, LAN 6-digit PIN & cookie auth)
│   └── web/
│       ├── components/
│       │   ├── DeletedChatsModal.tsx
│       │   ├── HeatmapAndWorkspaces.tsx
│       │   └── SettingsModal.tsx
│       ├── App.tsx                 # Responsive Dark Mode React Dashboard
│       ├── main.tsx                # React entrypoint
│       └── index.css               # Tailwind CSS styles
├── dist/                           # Prebuilt bundle (CLI + static web assets)
└── package.json
```

---

## 📄 License

Distributed under the **MIT** License by [Cise07](https://github.com/Cise07). Feel free to open Issues or Pull Requests! ❤️
