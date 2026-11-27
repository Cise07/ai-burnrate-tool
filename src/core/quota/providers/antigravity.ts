import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadQuotaStore, sanitizeRawPayload } from '../store.js';
import {
  clampNumber,
  computePercentPair,
  computeResetAtFromRelativeSeconds,
  FIVE_HOUR_MS,
  normalizeEpochMs,
  SEVEN_DAY_MS,
} from '../time.js';
import type { ProviderQuotaSnapshot, QuotaWindow, WindowKind } from '../types.js';

const execFileAsync = promisify(execFile);

export interface AntigravityFetchResult {
  snapshot: ProviderQuotaSnapshot;
  rawPayloadSanitized: unknown;
}

export function resolveAntigravityBinary(): string {
  const override = process.env.BURNRATE_AGY_BIN?.trim();
  if (override) return override;

  const home = os.homedir();
  const binName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidate = path.join(home, '.gemini', 'antigravity-cli', 'bin', binName);
  if (fs.existsSync(candidate)) return candidate;
  return 'agy';
}

function normalizeGroupMeta(rawName: unknown, bucketId: string): { groupId: string; groupLabel: string } {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const probe = `${name} ${bucketId}`.toLowerCase();
  if (probe.includes('gemini')) {
    return { groupId: 'gemini', groupLabel: name || 'Gemini Models' };
  }
  if (probe.includes('claude') || probe.includes('gpt') || probe.includes('3p')) {
    return {
      groupId: 'claude_gpt',
      groupLabel: name ? name.replace(/\band\b/i, '&').replace(/\bmodels\b/i, 'Models') : 'Claude & GPT Models',
    };
  }
  const slug = (name || bucketId || 'pool')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return { groupId: slug || 'pool', groupLabel: name || 'Model Pool' };
}

function parseGroupModelsList(description: unknown): string[] {
  if (typeof description !== 'string' || !description.trim()) return [];
  const match = description.match(/models within this group:\s*(.+)$/i);
  const rawList = match ? match[1] : description;
  return rawList
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && !/^within this group/i.test(m));
}

function classifyBucketKind(id: string, rawWindow: unknown): { kind: WindowKind; durationMs: number | null; defaultLabel: string } {
  const w = typeof rawWindow === 'string' ? rawWindow.trim().toLowerCase() : '';
  const probe = `${w} ${id}`.toLowerCase();
  if (probe.includes('weekly') || probe.includes('7d')) {
    return { kind: 'weekly_7d', durationMs: SEVEN_DAY_MS, defaultLabel: '7d Weekly' };
  }
  if (probe.includes('5h') || probe.includes('five')) {
    return { kind: 'rolling_5h', durationMs: FIVE_HOUR_MS, defaultLabel: '5h Rolling' };
  }
  if (probe.includes('daily') || probe.includes('24h')) {
    return { kind: 'daily', durationMs: 86_400_000, defaultLabel: '24h Daily' };
  }
  return { kind: 'model_pool', durationMs: null, defaultLabel: id || 'Pool Limit' };
}

function formatBucketLabel(kind: WindowKind, rawName: unknown, fallbackLabel: string): string {
  if (kind === 'weekly_7d') return '7d Weekly';
  if (kind === 'rolling_5h') return '5h Rolling';
  if (kind === 'daily') return '24h Daily';
  if (typeof rawName === 'string' && rawName.trim()) {
    return rawName.replace(/\s+Remaining$/i, '').trim();
  }
  return fallbackLabel;
}

function windowSortRank(w: QuotaWindow): number {
  const groupRank = w.groupId === 'gemini' ? 0 : w.groupId === 'claude_gpt' ? 10 : 20;
  const kindRank = w.kind === 'weekly_7d' ? 0 : w.kind === 'daily' ? 1 : w.kind === 'rolling_5h' ? 2 : 3;
  return groupRank + kindRank;
}

function isAuthErrorText(message: string): boolean {
  return /auth(?:entication)?\s*required|not\s*authenticated|sign\s*in|logged\s*out|login|unauthorized|unauthenticated/i.test(
    message
  );
}

function buildUnavailableSnapshot(
  opts: { fetchedAtMs: number; serverNowMs: number; creditsBalance?: number | null },
  status: 'auth_error' | 'unavailable',
  code: string,
  message: string
): ProviderQuotaSnapshot {
  return {
    provider: 'antigravity',
    planLabel: null,
    creditsBalance: opts.creditsBalance ?? null,
    status,
    windows: [],
    fetchedAtMs: opts.fetchedAtMs,
    sourceUpdatedAtMs: null,
    serverNowMs: opts.serverNowMs,
    error: { code, message },
  };
}

/**
 * Pure parser for `agy -p /usage --output-format json`.
 * Keeps separate model groups as dedicated QuotaWindows without lossy aggregation.
 */
export function parseAntigravityCliUsageJson(
  rawInput: unknown,
  opts: {
    fetchedAtMs: number;
    serverNowMs?: number;
    planLabel?: string | null;
    creditsBalance?: number | null;
  }
): ProviderQuotaSnapshot {
  const serverNowMs = opts.serverNowMs ?? opts.fetchedAtMs;

  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return buildUnavailableSnapshot(
      { fetchedAtMs: opts.fetchedAtMs, serverNowMs, creditsBalance: opts.creditsBalance },
      'unavailable',
      'INVALID_PAYLOAD',
      'Missing or malformed Antigravity CLI /usage JSON payload.'
    );
  }

  const envelope = rawInput as Record<string, unknown>;
  const rawError = typeof envelope.error === 'string' ? envelope.error.trim() : '';
  const statusStr = typeof envelope.status === 'string' ? envelope.status.trim().toUpperCase() : '';
  if (statusStr === 'ERROR' || rawError) {
    const errMsg = rawError || 'Antigravity CLI /usage returned an error.';
    return buildUnavailableSnapshot(
      { fetchedAtMs: opts.fetchedAtMs, serverNowMs, creditsBalance: opts.creditsBalance },
      isAuthErrorText(errMsg) ? 'auth_error' : 'unavailable',
      isAuthErrorText(errMsg) ? 'AUTH_REQUIRED' : 'CLI_ERROR',
      errMsg
    );
  }

  const cmd = envelope.command && typeof envelope.command === 'object'
    ? (envelope.command as Record<string, unknown>)
    : null;
  const data = cmd?.data && typeof cmd.data === 'object'
    ? (cmd.data as Record<string, unknown>)
    : envelope.data && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>)
      : null;

  const groups = Array.isArray(data?.groups) ? data!.groups : null;
  if (!groups) {
    return buildUnavailableSnapshot(
      { fetchedAtMs: opts.fetchedAtMs, serverNowMs, creditsBalance: opts.creditsBalance },
      'unavailable',
      'NO_GROUPS',
      'Antigravity /usage output did not contain quota groups.'
    );
  }

  const windows: QuotaWindow[] = [];

  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const g = rawGroup as Record<string, unknown>;
    const models = parseGroupModelsList(g.description);
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];

    for (const rawBucket of buckets) {
      if (!rawBucket || typeof rawBucket !== 'object') continue;
      const b = rawBucket as Record<string, unknown>;
      if (b.disabled === true) continue;

      const bucketId = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : 'unknown';
      const { groupId, groupLabel } = normalizeGroupMeta(g.name, bucketId);
      const { kind, durationMs, defaultLabel } = classifyBucketKind(bucketId, b.window);

      let remPctRaw: number | null = null;
      if (typeof b.remaining_fraction === 'number' && Number.isFinite(b.remaining_fraction)) {
        remPctRaw = clampNumber(b.remaining_fraction, 0, 1) * 100;
      } else if (typeof b.remaining_percentage === 'number' && Number.isFinite(b.remaining_percentage)) {
        remPctRaw = clampNumber(b.remaining_percentage, 0, 100);
      } else if (typeof b.remaining_percent === 'number' && Number.isFinite(b.remaining_percent)) {
        remPctRaw = clampNumber(b.remaining_percent, 0, 100);
      }

      if (remPctRaw === null) continue;
      const { remainingPercent, usedPercent } = computePercentPair({ remainingPercent: remPctRaw });
      const rawResetMs = normalizeEpochMs(b.reset_time ?? b.resetTime);
      const relResetMs =
        rawResetMs === null && remainingPercent !== null && remainingPercent < 100
          ? computeResetAtFromRelativeSeconds(b.reset_in_seconds ?? b.resetInSeconds, opts.fetchedAtMs)
          : null;
      const resolvedResetMs =
        remainingPercent !== null && remainingPercent >= 100 && rawResetMs === null
          ? null
          : rawResetMs ?? relResetMs;

      windows.push({
        id: `antigravity:${bucketId}`,
        label: formatBucketLabel(kind, b.name, defaultLabel),
        groupId,
        groupLabel,
        kind,
        models,
        remainingPercent,
        usedPercent,
        usedUnits: null,
        limitUnits: typeof b.remaining_amount === 'number' && Number.isFinite(b.remaining_amount)
          ? b.remaining_amount
          : null,
        resetAtMs: resolvedResetMs,
        windowDurationMs: durationMs,
        accuracy: 'exact',
        source: 'agy_cli_usage',
      });
    }
  }

  windows.sort((a, b) => windowSortRank(a) - windowSortRank(b));

  if (windows.length === 0) {
    return buildUnavailableSnapshot(
      { fetchedAtMs: opts.fetchedAtMs, serverNowMs, creditsBalance: opts.creditsBalance },
      'unavailable',
      'EMPTY_BUCKETS',
      'No quota buckets were returned by Antigravity /usage.'
    );
  }

  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);
  return {
    provider: 'antigravity',
    planLabel: opts.planLabel ?? null,
    creditsBalance: opts.creditsBalance ?? null,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs: opts.fetchedAtMs,
    sourceUpdatedAtMs: opts.fetchedAtMs,
    serverNowMs,
    error: null,
  };
}

/**
 * Pure parser for Antigravity CLI custom statusLine JSON piped on stdin.
 */
export function parseAntigravityStatuslinePayload(
  rawInput: unknown,
  opts: { fetchedAtMs: number; serverNowMs?: number }
): ProviderQuotaSnapshot | null {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const obj = rawInput as Record<string, unknown>;
  const rawQuota = obj.quota;
  if (!rawQuota || typeof rawQuota !== 'object' || Array.isArray(rawQuota)) return null;

  const planLabel = typeof obj.plan_tier === 'string' && obj.plan_tier.trim() ? obj.plan_tier.trim() : null;
  const windows: QuotaWindow[] = [];

  for (const [bucketId, val] of Object.entries(rawQuota as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const entry = val as Record<string, unknown>;
    if (entry.disabled === true) continue;

    let remPctRaw: number | null = null;
    if (typeof entry.remaining_fraction === 'number' && Number.isFinite(entry.remaining_fraction)) {
      remPctRaw = clampNumber(entry.remaining_fraction, 0, 1) * 100;
    } else if (typeof entry.remaining_percentage === 'number' && Number.isFinite(entry.remaining_percentage)) {
      remPctRaw = clampNumber(entry.remaining_percentage, 0, 100);
    }
    if (remPctRaw === null) continue;

    const { remainingPercent, usedPercent } = computePercentPair({ remainingPercent: remPctRaw });
    const { groupId, groupLabel } = normalizeGroupMeta(undefined, bucketId);
    const { kind, durationMs, defaultLabel } = classifyBucketKind(bucketId, undefined);
    const rawResetMs = normalizeEpochMs(entry.reset_time ?? entry.resetTime);
    const relResetMs =
      rawResetMs === null && remainingPercent !== null && remainingPercent < 100
        ? computeResetAtFromRelativeSeconds(entry.reset_in_seconds ?? entry.resetInSeconds, opts.fetchedAtMs)
        : null;
    const resetAtMs =
      remainingPercent !== null && remainingPercent >= 100 && rawResetMs === null
        ? null
        : rawResetMs ?? relResetMs;

    windows.push({
      id: `antigravity:${bucketId}`,
      label: formatBucketLabel(kind, undefined, defaultLabel),
      groupId,
      groupLabel,
      kind,
      models: [],
      remainingPercent,
      usedPercent,
      usedUnits: null,
      limitUnits:
        typeof entry.remaining_amount === 'number' && Number.isFinite(entry.remaining_amount)
          ? entry.remaining_amount
          : null,
      resetAtMs,
      windowDurationMs: durationMs,
      accuracy: 'exact',
      source: 'agy_statusline',
    });
  }

  if (windows.length === 0) return null;
  windows.sort((a, b) => windowSortRank(a) - windowSortRank(b));

  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);
  return {
    provider: 'antigravity',
    planLabel,
    creditsBalance: null,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs: opts.fetchedAtMs,
    sourceUpdatedAtMs: opts.fetchedAtMs,
    serverNowMs: opts.serverNowMs ?? opts.fetchedAtMs,
    error: null,
  };
}

export function parseAntigravityCreditsJson(rawInput: unknown): number | null {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const obj = rawInput as Record<string, unknown>;
  const cmd = obj.command && typeof obj.command === 'object' ? (obj.command as Record<string, unknown>) : null;
  const data = cmd?.data && typeof cmd.data === 'object' ? (cmd.data as Record<string, unknown>) : null;
  const credits = data?.remaining_credits;
  return typeof credits === 'number' && Number.isFinite(credits) ? credits : null;
}

export function projectAntigravitySnapshotAtTime(
  stored: ProviderQuotaSnapshot | undefined,
  evalNowMs: number
): { snapshot: ProviderQuotaSnapshot; needsRefresh: boolean } {
  if (!stored) {
    return {
      snapshot: {
        provider: 'antigravity',
        planLabel: null,
        creditsBalance: null,
        status: 'unavailable',
        windows: [],
        fetchedAtMs: evalNowMs,
        sourceUpdatedAtMs: null,
        serverNowMs: evalNowMs,
        error: { code: 'NOT_FETCHED', message: 'Quota not synced yet. Refreshing from Antigravity CLI.' },
      },
      needsRefresh: true,
    };
  }

  const nowCorrected = evalNowMs + (stored.clockSkewMs ?? 0);
  const anyExpired = stored.windows.some(
    (w) => w.resetAtMs !== null && nowCorrected >= w.resetAtMs
  );

  const nextStatus = anyExpired && stored.status !== 'auth_error' ? 'stale' : stored.status;
  return {
    snapshot: {
      ...stored,
      status: nextStatus,
      serverNowMs: evalNowMs,
    },
    needsRefresh: anyExpired || stored.status === 'stale' || stored.status === 'unavailable',
  };
}

function parseJsonFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate.startsWith('{')) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }
    return null;
  }
}

export async function fetchAntigravityLiveQuota(opts: {
  geminiDir?: string;
  previous?: ProviderQuotaSnapshot | null;
  timeoutMs?: number;
}): Promise<AntigravityFetchResult> {
  const fetchedAtMs = Date.now();
  const previousPlanLabel = opts.previous?.planLabel ?? null;

  // Allow deterministic fixtures during isolated tests when BURNRATE_GEMINI_DIR is overridden
  const fixturePath = process.env.BURNRATE_AGY_USAGE_FIXTURE?.trim();
  if (fixturePath && fs.existsSync(fixturePath)) {
    try {
      const rawJson = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
      const snap = parseAntigravityCliUsageJson(rawJson, {
        fetchedAtMs,
        serverNowMs: fetchedAtMs,
        planLabel: previousPlanLabel,
      });
      return { snapshot: snap, rawPayloadSanitized: sanitizeRawPayload(rawJson) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse fixture';
      const fallback = buildUnavailableSnapshot(
        { fetchedAtMs, serverNowMs: fetchedAtMs },
        'unavailable',
        'FIXTURE_ERROR',
        message
      );
      return { snapshot: fallback, rawPayloadSanitized: null };
    }
  }

  if (process.env.BURNRATE_GEMINI_DIR && process.env.BURNRATE_ENABLE_LIVE_AGY_CLI !== '1') {
    const existing = opts.previous ?? loadQuotaStore().providers.antigravity;
    if (existing) {
      const proj = projectAntigravitySnapshotAtTime(existing, fetchedAtMs);
      return { snapshot: proj.snapshot, rawPayloadSanitized: loadQuotaStore().rawPayloads?.antigravity ?? null };
    }
    return {
      snapshot: buildUnavailableSnapshot(
        { fetchedAtMs, serverNowMs: fetchedAtMs },
        'unavailable',
        'SANDBOX_MODE',
        'Live Antigravity CLI polling is disabled in test sandbox without fixture.'
      ),
      rawPayloadSanitized: null,
    };
  }

  const agyBin = resolveAntigravityBinary();
  const timeout = opts.timeoutMs ?? 8000;

  try {
    const [usageRes, creditsRes] = await Promise.allSettled([
      execFileAsync(agyBin, ['-p', '/usage', '--output-format', 'json'], {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }),
      execFileAsync(agyBin, ['-p', '/credits', '--output-format', 'json'], {
        timeout: Math.min(timeout, 5000),
        maxBuffer: 512 * 1024,
        windowsHide: true,
      }),
    ]);

    let creditsBalance: number | null = opts.previous?.creditsBalance ?? null;
    if (creditsRes.status === 'fulfilled') {
      const parsedCredits = parseAntigravityCreditsJson(parseJsonFromStdout(creditsRes.value.stdout));
      if (parsedCredits !== null) creditsBalance = parsedCredits;
    }

    if (usageRes.status === 'rejected') {
      const errObj = usageRes.reason as { message?: string; stderr?: string; stdout?: string };
      const stdoutParsed = typeof errObj?.stdout === 'string' ? parseJsonFromStdout(errObj.stdout) : null;
      if (stdoutParsed) {
        const parsedErrSnap = parseAntigravityCliUsageJson(stdoutParsed, {
          fetchedAtMs,
          serverNowMs: fetchedAtMs,
          planLabel: previousPlanLabel,
          creditsBalance,
        });
        return { snapshot: parsedErrSnap, rawPayloadSanitized: sanitizeRawPayload(stdoutParsed) };
      }

      const rawMsg = (errObj?.stderr || errObj?.message || 'agy -p /usage failed').trim();
      const authErr = isAuthErrorText(rawMsg);
      if (!authErr && opts.previous && opts.previous.windows.length > 0) {
        return {
          snapshot: {
            ...opts.previous,
            status: 'stale',
            serverNowMs: fetchedAtMs,
            error: { code: 'REFRESH_FAILED', message: rawMsg },
          },
          rawPayloadSanitized: loadQuotaStore().rawPayloads?.antigravity ?? null,
        };
      }
      return {
        snapshot: buildUnavailableSnapshot(
          { fetchedAtMs, serverNowMs: fetchedAtMs, creditsBalance },
          authErr ? 'auth_error' : 'unavailable',
          authErr ? 'AUTH_REQUIRED' : 'CLI_EXEC_FAILED',
          rawMsg
        ),
        rawPayloadSanitized: { error: rawMsg },
      };
    }

    const rawUsageJson = parseJsonFromStdout(usageRes.value.stdout);
    const snap = parseAntigravityCliUsageJson(rawUsageJson, {
      fetchedAtMs,
      serverNowMs: Date.now(),
      planLabel: previousPlanLabel,
      creditsBalance,
    });

    if (snap.status === 'unavailable' && opts.previous && opts.previous.windows.length > 0) {
      return {
        snapshot: {
          ...opts.previous,
          status: 'stale',
          serverNowMs: Date.now(),
          error: snap.error,
        },
        rawPayloadSanitized: sanitizeRawPayload(rawUsageJson),
      };
    }

    return {
      snapshot: snap,
      rawPayloadSanitized: sanitizeRawPayload(rawUsageJson),
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Unexpected Antigravity fetch failure';
    return {
      snapshot: buildUnavailableSnapshot(
        { fetchedAtMs, serverNowMs: Date.now() },
        'unavailable',
        'UNEXPECTED_ERROR',
        rawMsg
      ),
      rawPayloadSanitized: { error: rawMsg },
    };
  }
}
