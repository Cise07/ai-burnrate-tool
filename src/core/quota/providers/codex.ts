import fs from 'node:fs';
import path from 'node:path';
import {
  clampNumber,
  computePercentPair,
  computeResetAtFromRelativeSeconds,
  FIVE_HOUR_MS,
  normalizeEpochMs,
  ONE_DAY_MS,
  SEVEN_DAY_MS,
} from '../time.js';
import type { ProviderQuotaSnapshot, QuotaWindow, WindowKind } from '../types.js';

export interface CodexScanResult {
  snapshot: ProviderQuotaSnapshot | null;
  rawPayloadSanitized: unknown;
}

function classifyCodexWindowMeta(
  slot: 'primary' | 'secondary',
  windowMinutes: number | null
): { label: string; kind: WindowKind; durationMs: number | null } {
  if (windowMinutes !== null && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    const durationMs = Math.round(windowMinutes * 60_000);
    if (windowMinutes >= 4320) {
      const days = Math.round(windowMinutes / 1440);
      return {
        label: days === 7 ? '7d Weekly' : `${days}d Limit`,
        kind: 'weekly_7d',
        durationMs,
      };
    }
    if (windowMinutes >= 1380 && windowMinutes <= 1500) {
      return { label: '24h Daily', kind: 'daily', durationMs };
    }
    if (windowMinutes >= 270 && windowMinutes <= 330) {
      return { label: '5h Rolling', kind: 'rolling_5h', durationMs };
    }
    if (windowMinutes >= 60 && windowMinutes % 60 === 0) {
      return { label: `${windowMinutes / 60}h Limit`, kind: slot, durationMs };
    }
    return { label: `${Math.round(windowMinutes)}m Limit`, kind: slot, durationMs };
  }

  return slot === 'primary'
    ? { label: 'Primary Limit', kind: 'primary', durationMs: FIVE_HOUR_MS }
    : { label: 'Secondary Limit', kind: 'secondary', durationMs: SEVEN_DAY_MS };
}

function parseCodexWindowEntry(
  rawEntry: unknown,
  slot: 'primary' | 'secondary',
  eventTimestampMs: number | null,
  source: string
): QuotaWindow | null {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return null;
  const obj = rawEntry as Record<string, unknown>;

  const rawUsed = obj.used_percent ?? obj.used_percentage ?? obj.usedPct;
  const usedNum =
    typeof rawUsed === 'number'
      ? rawUsed
      : typeof rawUsed === 'string' && rawUsed.trim() !== ''
        ? Number(rawUsed)
        : NaN;
  if (!Number.isFinite(usedNum)) return null;

  const { remainingPercent, usedPercent } = computePercentPair({
    usedPercent: clampNumber(usedNum, 0, 100),
  });

  const rawWm = obj.window_minutes ?? obj.windowMinutes;
  const windowMinutes =
    typeof rawWm === 'number' && Number.isFinite(rawWm) && rawWm > 0
      ? rawWm
      : typeof rawWm === 'string' && rawWm.trim() !== '' && Number.isFinite(Number(rawWm))
        ? Number(rawWm)
        : null;

  const meta = classifyCodexWindowMeta(slot, windowMinutes);

  // Absolute resets_at wins; relative resets_in_seconds must anchor strictly to eventTimestampMs
  const explicitResetMs = normalizeEpochMs(obj.resets_at ?? obj.resetsAt ?? obj.reset_at);
  const relativeResetMs =
    explicitResetMs === null && usedPercent !== null && usedPercent > 0
      ? computeResetAtFromRelativeSeconds(
          obj.resets_in_seconds ?? obj.resetsInSeconds,
          eventTimestampMs
        )
      : explicitResetMs === null && eventTimestampMs !== null
        ? computeResetAtFromRelativeSeconds(
            obj.resets_in_seconds ?? obj.resetsInSeconds,
            eventTimestampMs
          )
        : null;

  const resetAtMs =
    usedPercent === 0 && explicitResetMs === null && relativeResetMs === null
      ? null
      : explicitResetMs ?? relativeResetMs;

  return {
    id: `codex:${slot}`,
    label: meta.label,
    kind: meta.kind,
    models: [],
    remainingPercent,
    usedPercent,
    usedUnits: null,
    limitUnits: null,
    resetAtMs,
    windowDurationMs: meta.durationMs,
    accuracy: 'exact',
    source,
  };
}

function parseCreditsBalance(rawCredits: unknown): number | null {
  if (!rawCredits || typeof rawCredits !== 'object') return null;
  const bal = (rawCredits as Record<string, unknown>).balance;
  if (typeof bal === 'number' && Number.isFinite(bal)) return bal;
  if (typeof bal === 'string' && bal.trim() !== '') {
    const cleaned = bal.replace(/[^0-9.-]+/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isPrimaryCodexLimitId(limitId: unknown): boolean {
  if (typeof limitId !== 'string' || !limitId.trim()) return true;
  const norm = limitId.trim().toLowerCase();
  return norm === 'codex' || norm === 'premium';
}

/**
 * Pure parser for a single Codex CLI rate_limits payload (from rollout JSONL `event_msg` / `RateLimitsUpdated`).
 * Preserves `primary` and `secondary` as separate QuotaWindows without merging.
 */
export function parseCodexRateLimitsEvent(
  rawEventOrLimits: unknown,
  opts: {
    eventTimestampMs: number | null;
    serverNowMs?: number;
    source?: string;
    limitId?: string | null;
  }
): (ProviderQuotaSnapshot & { _isPrimaryLimitId?: boolean }) | null {
  if (!rawEventOrLimits || typeof rawEventOrLimits !== 'object' || Array.isArray(rawEventOrLimits)) {
    return null;
  }

  const top = rawEventOrLimits as Record<string, unknown>;
  const payload =
    top.payload && typeof top.payload === 'object' ? (top.payload as Record<string, unknown>) : top;
  const rl =
    (payload.rate_limits && typeof payload.rate_limits === 'object'
      ? (payload.rate_limits as Record<string, unknown>)
      : null) ??
    (payload.info &&
    typeof payload.info === 'object' &&
    (payload.info as Record<string, unknown>).rate_limits &&
    typeof (payload.info as Record<string, unknown>).rate_limits === 'object'
      ? ((payload.info as Record<string, unknown>).rate_limits as Record<string, unknown>)
      : null) ??
    (top.rate_limits && typeof top.rate_limits === 'object'
      ? (top.rate_limits as Record<string, unknown>)
      : null) ??
    payload;

  if (!rl || typeof rl !== 'object') return null;

  const eventTimestampMs =
    opts.eventTimestampMs ??
    normalizeEpochMs(top.timestamp ?? payload.timestamp);
  const source = opts.source || 'codex_session_jsonl';

  const primary = parseCodexWindowEntry(rl.primary, 'primary', eventTimestampMs, source);
  const secondary = parseCodexWindowEntry(rl.secondary, 'secondary', eventTimestampMs, source);
  const windows = [primary, secondary].filter((w): w is QuotaWindow => w !== null);
  if (windows.length === 0) return null;

  // Present longer window above shorter window in UI while keeping exact IDs (`codex:primary`, `codex:secondary`)
  windows.sort((a, b) => {
    const durA = a.windowDurationMs ?? (a.kind === 'secondary' ? SEVEN_DAY_MS : ONE_DAY_MS);
    const durB = b.windowDurationMs ?? (b.kind === 'secondary' ? SEVEN_DAY_MS : ONE_DAY_MS);
    return durB - durA;
  });

  const planType =
    typeof rl.plan_type === 'string' && rl.plan_type.trim()
      ? rl.plan_type.trim().charAt(0).toUpperCase() + rl.plan_type.trim().slice(1).toLowerCase()
      : null;
  const creditsBalance = parseCreditsBalance(rl.credits);
  const fetchedAtMs = eventTimestampMs ?? opts.serverNowMs ?? Date.now();
  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);

  return {
    provider: 'codex',
    planLabel: planType,
    creditsBalance,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs,
    sourceUpdatedAtMs: eventTimestampMs,
    serverNowMs: opts.serverNowMs ?? Date.now(),
    error: null,
    _isPrimaryLimitId: isPrimaryCodexLimitId(opts.limitId ?? rl.limit_id),
  };
}

export function projectCodexSnapshotAtTime(
  stored: ProviderQuotaSnapshot | undefined,
  evalNowMs: number
): ProviderQuotaSnapshot {
  if (!stored || stored.windows.length === 0) {
    return {
      provider: 'codex',
      planLabel: stored?.planLabel ?? null,
      creditsBalance: stored?.creditsBalance ?? null,
      status: 'unavailable',
      windows: [],
      fetchedAtMs: stored?.fetchedAtMs ?? evalNowMs,
      sourceUpdatedAtMs: null,
      serverNowMs: evalNowMs,
      error: {
        code: 'AWAITING_TELEMETRY',
        message: 'No Codex CLI rate_limits events found in local session JSONL logs.',
      },
    };
  }

  const skew = stored.clockSkewMs ?? 0;
  const nowCorrectedMs = evalNowMs + skew;
  let anyRolledOver = false;
  let anyActiveExhausted = false;

  const projectedWindows: QuotaWindow[] = stored.windows.map((w) => {
    if (w.resetAtMs !== null && nowCorrectedMs >= w.resetAtMs) {
      anyRolledOver = true;
      return {
        ...w,
        remainingPercent: 100,
        usedPercent: 0,
        resetAtMs: null,
        accuracy: 'derived',
        source: w.source.endsWith(':post_reset') ? w.source : `${w.source}:post_reset`,
      };
    }
    if (w.remainingPercent !== null && w.remainingPercent <= 0) {
      anyActiveExhausted = true;
    }
    return w;
  });

  return {
    ...stored,
    status: anyActiveExhausted ? 'exhausted' : anyRolledOver ? 'stale' : 'ok',
    windows: projectedWindows,
    serverNowMs: evalNowMs,
  };
}

function collectCodexJsonlFiles(dirPath: string, out: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectCodexJsonlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scans Codex session logs and picks the freshest valid non-null `rate_limits` event
 * by comparing numeric UTC event timestamps across all recent sessions (not mtime or string ordering).
 */
export function scanLatestCodexQuota(codexDir: string, serverNowMs = Date.now()): CodexScanResult {
  const dirs = [
    path.join(codexDir, 'sessions'),
    path.join(codexDir, 'archived_sessions'),
  ];
  const files: string[] = [];
  for (const d of dirs) collectCodexJsonlFiles(d, files);
  if (files.length === 0) return { snapshot: null, rawPayloadSanitized: null };

  // Sort candidates by file mtime descending as an I/O budget optimization only for huge archives,
  // reading full contents for at least the 50 most recently modified files so out-of-order events are always seen
  const statList: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of files) {
    try {
      statList.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // skip
    }
  }
  statList.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanTarget = statList.slice(0, 60);

  let best: (ProviderQuotaSnapshot & { _isPrimaryLimitId?: boolean }) | null = null;
  let bestSortTs = -1;
  let bestRaw: unknown = null;

  for (const { file, mtimeMs } of scanTarget) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('{') || !trimmed.includes('rate_limits')) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const payload =
        obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : obj;
      const rawRl =
        payload.rate_limits ??
        (payload.info && typeof payload.info === 'object'
          ? (payload.info as Record<string, unknown>).rate_limits
          : null) ??
        obj.rate_limits;
      if (!rawRl || typeof rawRl !== 'object') continue;

      const explicitEventTs = normalizeEpochMs(obj.timestamp ?? payload.timestamp);
      const parsed = parseCodexRateLimitsEvent(obj, {
        eventTimestampMs: explicitEventTs,
        serverNowMs,
        source: 'codex_session_jsonl',
      });
      if (!parsed) continue;

      const candidateSortTs = explicitEventTs ?? Math.round(mtimeMs);
      const isBetter =
        best === null ||
        candidateSortTs > bestSortTs ||
        (candidateSortTs === bestSortTs &&
          Boolean(parsed._isPrimaryLimitId) &&
          !Boolean(best._isPrimaryLimitId));

      if (isBetter) {
        best = parsed;
        bestSortTs = candidateSortTs;
        bestRaw = obj;
      }
    }
  }

  if (!best) return { snapshot: null, rawPayloadSanitized: null };

  const { _isPrimaryLimitId: _ignored, ...cleanSnap } = best;
  const projected = projectCodexSnapshotAtTime(
    { ...cleanSnap, fetchedAtMs: serverNowMs },
    serverNowMs
  );
  return { snapshot: projected, rawPayloadSanitized: bestRaw };
}
