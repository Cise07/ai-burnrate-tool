import { useEffect, useState } from 'react';

declare const __TOOL_VERSION__: string;

const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/Cise07/ai-burnrate-tool/releases/latest';
const NPM_LATEST_URL = 'https://registry.npmjs.org/ai-burnrate-tool/latest';
const GITHUB_PACKAGE_URL =
  'https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/package.json';
const VERSION_CACHE_KEY = 'burnrate-tool-version';
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

function normalizeVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!SEMVER_RE.test(trimmed)) return null;
  return trimmed.startsWith('v') || trimmed.startsWith('V')
    ? `v${trimmed.slice(1)}`
    : `v${trimmed}`;
}

function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function pickHighestVersion(...candidates: Array<string | null | undefined>): string {
  let best: string | null = null;
  for (const c of candidates) {
    const norm = normalizeVersion(c);
    if (!norm) continue;
    if (!best || compareSemver(norm, best) > 0) {
      best = norm;
    }
  }
  return best ?? 'v1.3.0';
}

function getInitialVersion(): string {
  const buildFallback = normalizeVersion(__TOOL_VERSION__) ?? 'v1.3.0';
  if (typeof window === 'undefined') return buildFallback;
  try {
    const cached = window.sessionStorage.getItem(VERSION_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { v?: string };
      return pickHighestVersion(buildFallback, parsed.v);
    }
  } catch {
    // ignore storage access issues
  }
  return buildFallback;
}

let sharedFetchPromise: Promise<string | null> | null = null;

async function fetchJsonField(
  url: string,
  field: string,
  headers?: Record<string, string>
): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', headers });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return normalizeVersion(data[field]);
  } catch {
    return null;
  }
}

function fetchLatestToolVersion(): Promise<string | null> {
  if (sharedFetchPromise) return sharedFetchPromise;
  // Query GitHub Releases, npm registry, and raw package.json in parallel and pick the
  // highest semver so a fresh release appears immediately without waiting on raw CDN TTL.
  sharedFetchPromise = Promise.all([
    fetchJsonField(GITHUB_LATEST_RELEASE_URL, 'tag_name', {
      Accept: 'application/vnd.github+json',
    }),
    fetchJsonField(NPM_LATEST_URL, 'version'),
    fetchJsonField(GITHUB_PACKAGE_URL, 'version'),
  ]).then((results) => {
    const valid = results.filter((v): v is string => Boolean(v));
    return valid.length > 0 ? pickHighestVersion(...valid) : null;
  });
  return sharedFetchPromise;
}

export function useToolVersion(): string {
  const [version, setVersion] = useState<string>(getInitialVersion);

  useEffect(() => {
    let active = true;
    void fetchLatestToolVersion().then((latest) => {
      if (!active || !latest) return;
      setVersion((prev) => {
        const next = pickHighestVersion(prev, latest);
        try {
          window.sessionStorage.setItem(
            VERSION_CACHE_KEY,
            JSON.stringify({ v: next, ts: Date.now() })
          );
        } catch {
          // ignore storage access issues
        }
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, []);

  return version;
}
