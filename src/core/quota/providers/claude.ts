import {
  clampNumber,
  computeClockSkewMs,
  computePercentPair,
  computeResetAtFromRelativeSeconds,
  FIVE_HOUR_MS,
  normalizeEpochMs,
  SEVEN_DAY_MS,
} from '../time.js';
import type { ProviderQuotaSnapshot, QuotaWindow, WindowKind } from '../types.js';

interface ClaudeBucketSpec {
  id: string;
  label: string;
  kind: WindowKind;
  models: string[];
  durationMs: number | null;
  order: number;
}

const KNOWN_CLAUDE_BUCKETS: Record<string, ClaudeBucketSpec> = {
  seven_day: {
    id: 'claude:7d',
    label: '7d Weekly',
    kind: 'weekly_7d',
    models: [],
    durationMs: SEVEN_DAY_MS,
    order: 1,
  },
  sevenDay: {
    id: 'claude:7d',
    label: '7d Weekly',
    kind: 'weekly_7d',
    models: [],
    durationMs: SEVEN_DAY_MS,
    order: 1,
  },
  '7d': {
    id: 'claude:7d',
    label: '7d Weekly',
    kind: 'weekly_7d',
    models: [],
    durationMs: SEVEN_DAY_MS,
    order: 1,
  },
  seven_day_sonnet: {
    id: 'claude:7d-sonnet',
    label: '7d Sonnet',
    kind: 'model_pool',
    models: ['Claude Sonnet'],
    durationMs: SEVEN_DAY_MS,
    order: 2,
  },
  sevenDaySonnet: {
    id: 'claude:7d-sonnet',
    label: '7d Sonnet',
    kind: 'model_pool',
    models: ['Claude Sonnet'],
    durationMs: SEVEN_DAY_MS,
    order: 2,
  },
  '7d_sonnet': {
    id: 'claude:7d-sonnet',
    label: '7d Sonnet',
    kind: 'model_pool',
    models: ['Claude Sonnet'],
    durationMs: SEVEN_DAY_MS,
    order: 2,
  },
  seven_day_opus: {
    id: 'claude:7d-opus',
    label: '7d Opus',
    kind: 'model_pool',
    models: ['Claude Opus'],
    durationMs: SEVEN_DAY_MS,
    order: 3,
  },
  sevenDayOpus: {
    id: 'claude:7d-opus',
    label: '7d Opus',
    kind: 'model_pool',
    models: ['Claude Opus'],
    durationMs: SEVEN_DAY_MS,
    order: 3,
  },
  '7d_opus': {
    id: 'claude:7d-opus',
    label: '7d Opus',
    kind: 'model_pool',
    models: ['Claude Opus'],
    durationMs: SEVEN_DAY_MS,
    order: 3,
  },
  five_hour: {
    id: 'claude:5h',
    label: '5h Rolling',
    kind: 'rolling_5h',
    models: [],
    durationMs: FIVE_HOUR_MS,
    order: 4,
  },
  fiveHour: {
    id: 'claude:5h',
    label: '5h Rolling',
    kind: 'rolling_5h',
    models: [],
    durationMs: FIVE_HOUR_MS,
    order: 4,
  },
  '5h': {
    id: 'claude:5h',
    label: '5h Rolling',
    kind: 'rolling_5h',
    models: [],
    durationMs: FIVE_HOUR_MS,
    order: 4,
  },
};

function resolveBucketSpec(key: string): ClaudeBucketSpec {
  if (KNOWN_CLAUDE_BUCKETS[key]) return KNOWN_CLAUDE_BUCKETS[key];
  const snake = key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
  if (KNOWN_CLAUDE_BUCKETS[snake]) return KNOWN_CLAUDE_BUCKETS[snake];

  const slug = snake.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'limit';
  const pretty = snake
    .split('_')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
  const isWeekly = slug.includes('7d') || slug.includes('seven');
  const isFiveH = slug.includes('5h') || slug.includes('five');
  return {
    id: `claude:${slug}`,
    label: pretty || slug,
    kind: isWeekly ? 'weekly_7d' : isFiveH ? 'rolling_5h' : 'unknown',
    models: [],
    durationMs: isWeekly ? SEVEN_DAY_MS : isFiveH ? FIVE_HOUR_MS : null,
    order: isWeekly ? 5 : isFiveH ? 6 : 9,
  };
}

function parseNumericField(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Extracts percent pair with strict 0..100 vs 0..1 scale separation.
 * - `used_percentage` / `used_percent` / `usedPct` / `utilization` (in statusLine/usage JSON) are 0..100.
 * - `remaining_fraction` / `used_fraction` are strictly 0..1 (* 100).
 */
function extractStatuslinePercentPair(
  entry: Record<string, unknown>,
  defaultScale: '0_to_100' | '0_to_1' = '0_to_100'
): { remainingPercent: number | null; usedPercent: number | null } {
  const usedPct = parseNumericField(
    entry.used_percentage ?? entry.used_percent ?? entry.usedPct
  );
  if (usedPct !== null) {
    return computePercentPair({ usedPercent: clampNumber(usedPct, 0, 100) });
  }

  const remPct = parseNumericField(
    entry.remaining_percentage ?? entry.remaining_percent ?? entry.remainingPct
  );
  if (remPct !== null) {
    return computePercentPair({ remainingPercent: clampNumber(remPct, 0, 100) });
  }

  const usedFrac = parseNumericField(entry.used_fraction ?? entry.usedFraction);
  if (usedFrac !== null) {
    return computePercentPair({ usedPercent: clampNumber(usedFrac, 0, 1) * 100 });
  }

  const remFrac = parseNumericField(entry.remaining_fraction ?? entry.remainingFraction);
  if (remFrac !== null) {
    return computePercentPair({ remainingPercent: clampNumber(remFrac, 0, 1) * 100 });
  }

  const util = parseNumericField(entry.utilization);
  if (util !== null) {
    const scaled = defaultScale === '0_to_1' ? clampNumber(util, 0, 1) * 100 : clampNumber(util, 0, 100);
    return computePercentPair({ usedPercent: scaled });
  }

  return { remainingPercent: null, usedPercent: null };
}

/**
 * Pure parser for Claude Code statusLine JSON piped on stdin (`rate_limits` field).
 */
export function parseClaudeStatuslinePayload(
  rawInput: unknown,
  opts: {
    capturedAtMs: number;
    serverNowMs?: number;
    serverTimestampMs?: number | null;
    source?: string;
  }
): ProviderQuotaSnapshot | null {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const top = rawInput as Record<string, unknown>;
  const rl =
    top.rate_limits && typeof top.rate_limits === 'object' && !Array.isArray(top.rate_limits)
      ? (top.rate_limits as Record<string, unknown>)
      : top;

  const detectedServerMs =
    opts.serverTimestampMs ??
    normalizeEpochMs(top.server_time ?? top.serverTime ?? top.date ?? rl.server_time);
  const clockSkewMs = computeClockSkewMs(detectedServerMs, opts.capturedAtMs);
  const serverNowMs = opts.serverNowMs ?? opts.capturedAtMs;

  const windowsMap = new Map<string, { window: QuotaWindow; order: number }>();

  for (const [key, value] of Object.entries(rl)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const { remainingPercent, usedPercent } = extractStatuslinePercentPair(entry, '0_to_100');
    if (remainingPercent === null || usedPercent === null) continue;

    const spec = resolveBucketSpec(key);
    const explicitResetMs = normalizeEpochMs(entry.resets_at ?? entry.resetsAt ?? entry.reset_at ?? entry.reset);
    const relativeResetMs =
      explicitResetMs === null && usedPercent > 0
        ? computeResetAtFromRelativeSeconds(entry.resets_in_seconds ?? entry.resetsInSeconds, opts.capturedAtMs)
        : null;
    const resetAtMs =
      usedPercent <= 0 && explicitResetMs === null
        ? null
        : explicitResetMs ?? relativeResetMs;

    const wmRaw = parseNumericField(entry.window_minutes ?? entry.windowMinutes);
    const windowDurationMs = wmRaw !== null && wmRaw > 0 ? Math.round(wmRaw * 60_000) : spec.durationMs;

    windowsMap.set(spec.id, {
      order: spec.order,
      window: {
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        models: spec.models,
        remainingPercent,
        usedPercent,
        usedUnits: null,
        limitUnits: null,
        resetAtMs,
        windowDurationMs,
        accuracy: 'exact',
        source: opts.source || 'claude_statusline',
      },
    });
  }

  if (windowsMap.size === 0) return null;
  const windows = Array.from(windowsMap.values())
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.window);

  const planObj =
    typeof top.plan_type === 'string' && top.plan_type.trim()
      ? top.plan_type.trim()
      : typeof top.subscription_type === 'string' && top.subscription_type.trim()
        ? top.subscription_type.trim()
        : null;

  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);
  return {
    provider: 'claude',
    planLabel: planObj,
    creditsBalance: null,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs: opts.capturedAtMs,
    sourceUpdatedAtMs: opts.capturedAtMs,
    serverNowMs,
    ...(clockSkewMs !== 0 ? { clockSkewMs } : {}),
    error: null,
  };
}

/**
 * Pure parser for Anthropic unified rate-limit HTTP response headers
 * (`anthropic-ratelimit-unified-5h-{utilization,reset}`, `-7d-`, `-7d_sonnet-`, `-7d_opus-`)
 * plus HTTP `date` header for exact `clockSkewMs` calculation.
 */
export function parseClaudeRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
  opts: {
    capturedAtMs: number;
    serverNowMs?: number;
  }
): ProviderQuotaSnapshot | null {
  const normalizedHeaders = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val === 'string' && val.trim()) {
      normalizedHeaders.set(k.toLowerCase(), val.trim());
    }
  }

  const serverDateMs = normalizeEpochMs(normalizedHeaders.get('date'));
  const clockSkewMs = computeClockSkewMs(serverDateMs, opts.capturedAtMs);
  const serverNowMs = opts.serverNowMs ?? opts.capturedAtMs;

  const bucketPrefixes = new Set<string>();
  for (const key of normalizedHeaders.keys()) {
    const match = key.match(/^anthropic-ratelimit-unified-(.+)-(?:utilization|reset|status)$/);
    if (match && match[1]) {
      bucketPrefixes.add(match[1]);
    }
  }

  const windowsMap = new Map<string, { window: QuotaWindow; order: number }>();
  for (const prefix of bucketPrefixes) {
    const utilStr = normalizedHeaders.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    const resetStr = normalizedHeaders.get(`anthropic-ratelimit-unified-${prefix}-reset`);
    const utilNum = parseNumericField(utilStr);
    if (utilNum === null) continue;

    // Anthropic unified headers always report utilization on 0..1 fraction scale
    const { remainingPercent, usedPercent } = computePercentPair({
      usedPercent: clampNumber(utilNum, 0, 1) * 100,
    });
    if (remainingPercent === null || usedPercent === null) continue;
    const spec = resolveBucketSpec(prefix.replace(/-/g, '_'));
    const resetAtMs = normalizeEpochMs(resetStr);

    windowsMap.set(spec.id, {
      order: spec.order,
      window: {
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        models: spec.models,
        remainingPercent,
        usedPercent,
        usedUnits: null,
        limitUnits: null,
        resetAtMs: usedPercent <= 0 && resetAtMs === null ? null : resetAtMs,
        windowDurationMs: spec.durationMs,
        accuracy: 'exact',
        source: 'claude_ratelimit_headers',
      },
    });
  }

  if (windowsMap.size === 0) return null;
  const windows = Array.from(windowsMap.values())
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.window);

  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);
  return {
    provider: 'claude',
    planLabel: null,
    creditsBalance: null,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs: opts.capturedAtMs,
    sourceUpdatedAtMs: serverDateMs ?? opts.capturedAtMs,
    serverNowMs,
    ...(clockSkewMs !== 0 ? { clockSkewMs } : {}),
    error: null,
  };
}

export function projectClaudeSnapshotAtTime(
  stored: ProviderQuotaSnapshot | undefined,
  evalNowMs: number
): ProviderQuotaSnapshot {
  if (!stored || stored.windows.length === 0) {
    return {
      provider: 'claude',
      planLabel: stored?.planLabel ?? null,
      creditsBalance: null,
      status: 'unavailable',
      windows: [],
      fetchedAtMs: stored?.fetchedAtMs ?? evalNowMs,
      sourceUpdatedAtMs: null,
      serverNowMs: evalNowMs,
      error: {
        code: 'AWAITING_TELEMETRY',
        message: 'Awaiting first prompt response telemetry from Claude Code statusLine.',
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
    status: anyActiveExhausted ? 'exhausted' : anyRolledOver ? 'stale' : stored.status === 'auth_error' ? 'ok' : stored.status,
    windows: projectedWindows,
    serverNowMs: evalNowMs,
  };
}
