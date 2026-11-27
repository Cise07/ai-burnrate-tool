export const ONE_MINUTE_MS = 60_000;
export const FIVE_HOUR_MS = 5 * 3_600_000;
export const ONE_DAY_MS = 86_400_000;
export const SEVEN_DAY_MS = 7 * 86_400_000;

/** Accept timestamps between 2000-01-01T00:00:00Z and 2100-01-01T00:00:00Z. Rejects Go 1970/0001 zero-times. */
export const MIN_VALID_EPOCH_MS = 946_684_800_000;
export const MAX_VALID_EPOCH_MS = 4_102_444_800_000;

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function roundCleanPercent(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = clampNumber(value, 0, 100);
  const factor = 10 ** decimals;
  return Math.round((clamped + Number.EPSILON) * factor) / factor;
}

export function computePercentPair(input: {
  remainingPercent?: number | null;
  usedPercent?: number | null;
}): { remainingPercent: number | null; usedPercent: number | null } {
  if (typeof input.remainingPercent === 'number' && Number.isFinite(input.remainingPercent)) {
    const remainingPercent = roundCleanPercent(input.remainingPercent, 4);
    const usedPercent = roundCleanPercent(100 - remainingPercent, 4);
    return { remainingPercent, usedPercent };
  }
  if (typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)) {
    const usedPercent = roundCleanPercent(input.usedPercent, 4);
    const remainingPercent = roundCleanPercent(100 - usedPercent, 4);
    return { remainingPercent, usedPercent };
  }
  return { remainingPercent: null, usedPercent: null };
}

/**
 * Format exact percentages for compact display while preserving fractional progress near 0% and 100%.
 * Full precision remains intact inside `remainingPercent` / `usedPercent` on `QuotaWindow`.
 */
export function formatDisplayPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const clamped = clampNumber(value, 0, 100);
  if (clamped <= 0) return '0%';
  if (clamped >= 100) return '100%';
  if (clamped < 0.1) return '<0.1%';
  if (clamped > 99.95) return '99.9%';
  const rounded = Number(clamped.toFixed(1));
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

/**
 * Normalizes Unix seconds (10-digit int/float), Unix ms (13-digit), or ISO-8601 strings
 * (including numeric offsets and Z) strictly to UTC epoch milliseconds.
 * Returns `null` for sentinels (`0`, `-1`, `"1970-01-01T00:00:00Z"`, `"0001-01-01T00:00:00Z"`).
 */
export function normalizeEpochMs(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
    return ms >= MIN_VALID_EPOCH_MS && ms <= MAX_VALID_EPOCH_MS ? ms : null;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return normalizeEpochMs(Number(trimmed));
    }

    let iso = trimmed;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(iso)) {
      iso = iso.replace(' ', 'T');
    }
    iso = iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const rounded = Math.round(ms);
    return rounded >= MIN_VALID_EPOCH_MS && rounded <= MAX_VALID_EPOCH_MS ? rounded : null;
  }

  return null;
}

/**
 * Computes `resetAtMs` from relative seconds strictly anchored to `anchorTimestampMs`
 * (the event/response capture time). Never falls back to `Date.now()`.
 */
export function computeResetAtFromRelativeSeconds(
  resetsInSeconds: unknown,
  anchorTimestampMs: number | null | undefined
): number | null {
  if (
    typeof anchorTimestampMs !== 'number' ||
    !Number.isFinite(anchorTimestampMs) ||
    anchorTimestampMs < MIN_VALID_EPOCH_MS ||
    anchorTimestampMs > MAX_VALID_EPOCH_MS
  ) {
    return null;
  }

  const secs =
    typeof resetsInSeconds === 'number'
      ? resetsInSeconds
      : typeof resetsInSeconds === 'string' && resetsInSeconds.trim() !== ''
        ? Number(resetsInSeconds)
        : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return null;

  const target = Math.round(anchorTimestampMs + secs * 1000);
  return target >= MIN_VALID_EPOCH_MS && target <= MAX_VALID_EPOCH_MS ? target : null;
}

export function computeClockSkewMs(
  serverTimestampMs: number | null | undefined,
  localTimestampMs: number
): number {
  if (typeof serverTimestampMs !== 'number' || !Number.isFinite(serverTimestampMs)) {
    return 0;
  }
  if (!Number.isFinite(localTimestampMs)) return 0;
  return Math.round(serverTimestampMs - localTimestampMs);
}

export interface CountdownEvaluation {
  state: 'idle' | 'active' | 'sub_minute' | 'refreshing';
  remainingMs: number | null;
  formatted: string;
  formattedDetailed: string;
  isExpired: boolean;
}

/**
 * Computes minute-accurate countdown consistent with official provider CLIs (e.g. `agy /usage`):
 * - `resetAtMs == null`: `"Ready"` (inactive window)
 * - `remainingMs === 0`: `"Updating..."` (expired / awaiting rollover refresh, never negative or `"0m"`)
 * - `0 < remainingMs < 60_000`: `"< 1m"` (never `"0m"` while limit is active)
 * - `remainingMs >= 60_000`: `Math.floor(remainingMs / 60_000)` truncated to whole minutes (`"5d 19h 12m"`, `"4h 54m"`, `"18m"`).
 */
export function evaluateCountdown(
  resetAtMs: number | null | undefined,
  nowMs: number,
  clockSkewMs = 0
): CountdownEvaluation {
  if (resetAtMs === null || resetAtMs === undefined || !Number.isFinite(resetAtMs)) {
    return {
      state: 'idle',
      remainingMs: null,
      formatted: 'Ready',
      formattedDetailed: 'Ready',
      isExpired: false,
    };
  }

  const nowCorrectedMs = nowMs + (Number.isFinite(clockSkewMs) ? clockSkewMs : 0);
  const rawDiffMs = resetAtMs - nowCorrectedMs;
  if (rawDiffMs <= 0) {
    return {
      state: 'refreshing',
      remainingMs: 0,
      formatted: 'Updating...',
      formattedDetailed: 'Updating...',
      isExpired: true,
    };
  }

  if (rawDiffMs < ONE_MINUTE_MS) {
    const secs = Math.max(1, Math.ceil(rawDiffMs / 1000));
    return {
      state: 'sub_minute',
      remainingMs: rawDiffMs,
      formatted: '< 1m',
      formattedDetailed: `< 1m (${secs}s)`,
      isExpired: false,
    };
  }

  const totalMinutes = Math.floor(rawDiffMs / ONE_MINUTE_MS);
  let formatted: string;
  if (totalMinutes < 60) {
    formatted = `${totalMinutes}m`;
  } else {
    const totalHours = Math.floor(totalMinutes / 60);
    const remMinutes = totalMinutes % 60;
    if (totalHours < 24) {
      formatted = remMinutes > 0 ? `${totalHours}h ${remMinutes}m` : `${totalHours}h`;
    } else {
      const days = Math.floor(totalHours / 24);
      const remHours = totalHours % 24;
      const parts = [`${days}d`];
      if (remHours > 0) parts.push(`${remHours}h`);
      if (remMinutes > 0) parts.push(`${remMinutes}m`);
      formatted = parts.join(' ');
    }
  }

  return {
    state: 'active',
    remainingMs: rawDiffMs,
    formatted,
    formattedDetailed: formatted,
    isExpired: false,
  };
}

function getCalendarDayKey(epochMs: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(epochMs));
}

export function formatResetLocalTime(
  resetAtMs: number | null | undefined,
  nowMs: number,
  opts?: { timeZone?: string; locale?: string }
): string | null {
  if (resetAtMs === null || resetAtMs === undefined || !Number.isFinite(resetAtMs)) {
    return null;
  }
  const timeZone = opts?.timeZone;
  const locale = opts?.locale;
  const resetDay = getCalendarDayKey(resetAtMs, timeZone);
  const nowDay = getCalendarDayKey(nowMs, timeZone);
  const date = new Date(resetAtMs);

  if (resetDay === nowDay) {
    return new Intl.DateTimeFormat(locale, {
      ...(timeZone ? { timeZone } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  }

  return new Intl.DateTimeFormat(locale, {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function formatResetIsoLocal(resetAtMs: number | null | undefined): string | null {
  if (resetAtMs === null || resetAtMs === undefined || !Number.isFinite(resetAtMs)) {
    return null;
  }
  const d = new Date(resetAtMs);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = pad(Math.floor(absMin / 60));
  const offM = pad(absMin % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`;
}

export function formatMinutesAgo(fetchedAtMs: number | null | undefined, nowMs: number): string {
  if (fetchedAtMs === null || fetchedAtMs === undefined || !Number.isFinite(fetchedAtMs)) {
    return 'unknown';
  }
  const elapsedMs = Math.max(0, nowMs - fetchedAtMs);
  if (elapsedMs < ONE_MINUTE_MS) return 'just now';
  const mins = Math.floor(elapsedMs / ONE_MINUTE_MS);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
}

/**
 * Computes delay until the next minute (or second when a window is < 90s from reset),
 * capped at 15s so PC sleep/wake recovery happens within seconds without drift.
 */
export function msUntilNextAlignedTick(
  nowMs: number,
  clockSkewMs = 0,
  fastMode = false
): number {
  const corrected = nowMs + (Number.isFinite(clockSkewMs) ? clockSkewMs : 0);
  const positiveMod = (val: number, mod: number) => ((val % mod) + mod) % mod;
  if (fastMode) {
    return 1000 - positiveMod(corrected, 1000) + 20;
  }
  const toNextMinute = ONE_MINUTE_MS - positiveMod(corrected, ONE_MINUTE_MS) + 25;
  return Math.min(15_000, toNextMinute);
}
