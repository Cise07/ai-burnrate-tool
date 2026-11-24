import { useEffect, useState } from 'react';

declare const __TOOL_VERSION__: string;

const GITHUB_PACKAGE_URL =
  'https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/package.json';
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/Cise07/ai-burnrate-tool/releases/latest';
const VERSION_CACHE_KEY = 'burnrate-tool-version';
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const SEMVER_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

function normalizeVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = SEMVER_RE.exec(raw.trim());
  return match ? `v${match[1]}` : null;
}

function getInitialVersion(): string {
  const fallback = normalizeVersion(__TOOL_VERSION__) ?? 'v1.2.0';
  if (typeof window === 'undefined') return fallback;
  try {
    const cached = window.sessionStorage.getItem(VERSION_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { v?: string; ts?: number };
      const valid = normalizeVersion(parsed.v);
      if (valid && typeof parsed.ts === 'number' && Date.now() - parsed.ts < VERSION_CACHE_TTL_MS) {
        return valid;
      }
    }
  } catch {
    // ignore storage access issues
  }
  return fallback;
}

let sharedFetchPromise: Promise<string | null> | null = null;

function fetchLatestGitHubVersion(): Promise<string | null> {
  if (sharedFetchPromise) return sharedFetchPromise;
  sharedFetchPromise = (async () => {
    try {
      const res = await fetch(GITHUB_PACKAGE_URL, { cache: 'no-cache' });
      if (res.ok) {
        const pkg = (await res.json()) as { version?: unknown };
        const parsed = normalizeVersion(pkg.version);
        if (parsed) return parsed;
      }
    } catch {
      // fall through to releases API
    }

    try {
      const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const rel = (await res.json()) as { tag_name?: unknown };
        const parsed = normalizeVersion(rel.tag_name);
        if (parsed) return parsed;
      }
    } catch {
      // keep build-time fallback
    }
    return null;
  })();
  return sharedFetchPromise;
}

export function useToolVersion(): string {
  const [version, setVersion] = useState<string>(getInitialVersion);

  useEffect(() => {
    let active = true;
    void fetchLatestGitHubVersion().then((latest) => {
      if (!active || !latest) return;
      setVersion(latest);
      try {
        window.sessionStorage.setItem(
          VERSION_CACHE_KEY,
          JSON.stringify({ v: latest, ts: Date.now() })
        );
      } catch {
        // ignore storage access issues
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return version;
}
