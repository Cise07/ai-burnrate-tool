# Security Policy

## Supported Versions

Security updates are provided for the latest `1.3.x` release of `ai-burnrate-tool`.

| Version | Supported |
| :--- | :--- |
| `1.3.x` | Yes |
| `< 1.3.0` | Upgrade to latest |

## Local Privacy & Architecture Guarantees

`ai-burnrate-tool` is designed as a 100% local analytics tool:
- **Zero telemetry & zero cloud uploads:** Session transcripts, workspace paths, and cost ledgers stay on your machine under `~/.burnrate/`.
- **No credential or PII harvesting:** Live quota tracking never reads OAuth tokens, API keys, passwords, or email/account identifiers, and redacts sensitive fields before writing local diagnostic caches.
- **Network hardening:**
  - Use `burn --no-lan` to bind strictly to `127.0.0.1` and disable mDNS/QR LAN exposure on untrusted or public Wi-Fi networks.
  - All HTTP requests validate the `Host` header against a strict local allowlist to mitigate DNS Rebinding.
  - Mutating `POST /api/*` routes enforce same-origin validation and CSRF request header checks.
  - LAN authentication uses a random 6-digit PIN (`POST /__auth`), a 128-bit QR access token (`?qr=...`), `HttpOnly; SameSite=Lax` cookies, constant-time secret comparison, and non-evicting per-IP + global brute-force lockouts.
  - Hook log syncing (`--sync-ledger`) confines reads to `.jsonl` files inside the configured Antigravity, Claude Code, and Codex directories.

## Reporting a Vulnerability

If you discover a security vulnerability in `ai-burnrate-tool`, please report it responsibly **without** opening a public issue:
1. Use GitHub's **Private Vulnerability Reporting** in the repository's **Security -> Advisories** tab: `https://github.com/Cise07/ai-burnrate-tool/security/advisories/new`.
2. Include steps to reproduce, affected versions, and potential impact.

We aim to acknowledge reports within 72 hours and ship a fix as promptly as possible.
