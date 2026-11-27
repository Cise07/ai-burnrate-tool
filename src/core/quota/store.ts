import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computePercentPair,
  normalizeEpochMs,
} from './time.js';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaAccuracy,
  QuotaStatus,
  QuotaStoreFile,
  QuotaWindow,
  WindowKind,
} from './types.js';

export const CURRENT_QUOTA_SCHEMA_VERSION = 4 as const;
const VALID_PROVIDERS: readonly ProviderId[] = ['antigravity', 'claude', 'codex'];
const VALID_ACCURACIES = new Set<QuotaAccuracy>(['exact', 'derived', 'unavailable']);
const VALID_STATUSES = new Set<QuotaStatus>([
  'ok',
  'exhausted',
  'stale',
  'auth_error',
  'unavailable',
]);
const VALID_KINDS = new Set<WindowKind>([
  'rolling_5h',
  'weekly_7d',
  'daily',
  'model_pool',
  'primary',
  'secondary',
  'unknown',
]);

let memoryQuotaStore: QuotaStoreFile = {
  schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
  updatedAtMs: 0,
  providers: {},
  rawPayloads: {},
};

export function getQuotaStatePath(): string {
  if (process.env.BURNRATE_QUOTA_PATH) {
    return path.resolve(process.env.BURNRATE_QUOTA_PATH);
  }
  return path.join(os.homedir(), '.burnrate', 'quota-state.json');
}

function isPersistentQuotaEnabled(): boolean {
  if (process.env.BURNRATE_QUOTA_PATH) return true;
  if (
    process.env.BURNRATE_GEMINI_DIR ||
    process.env.BURNRATE_CLAUDE_DIR ||
    process.env.BURNRATE_CODEX_DIR ||
    process.env.BURNRATE_SETTINGS_PATH
  ) {
    return false;
  }
  return true;
}

const SECRET_KEY_RE =
  /(?:^token$|access_?token|refresh_?token|id_?token|oauth_?token|bearer_?token|session_?token|auth_?token|csrf_?token|secret|password|passphrase|authorization|cookie|api_?key|credential|bearer|private_?key|session_?key|email|user_?id|account_?id|account_?uuid)/i;

export function sanitizeRawPayload(raw: unknown, depth = 0): unknown {
  if (raw === null || raw === undefined) return raw ?? null;
  if (depth > 10) return '[TRUNCATED]';
  if (typeof raw === 'string') {
    const cleaned = raw.replace(
      /\b(Bearer\s+[A-Za-z0-9._-]+|ya29\.[A-Za-z0-9._-]+|AIza[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]{16,})\b/g,
      '[REDACTED]'
    );
    return cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    return raw.slice(0, 50).map((item) => sanitizeRawPayload(item, depth + 1));
  }
  if (typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeRawPayload(v, depth + 1);
      }
    }
    return out;
  }
  return String(raw);
}

function sanitizeWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== 'string' || !w.id.trim()) return null;
  if (typeof w.label !== 'string' || !w.label.trim()) return null;

  const { remainingPercent, usedPercent } = computePercentPair({
    remainingPercent:
      typeof w.remainingPercent === 'number' && Number.isFinite(w.remainingPercent)
        ? w.remainingPercent
        : null,
    usedPercent:
      typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null,
  });

  const kind: WindowKind =
    typeof w.kind === 'string' && VALID_KINDS.has(w.kind as WindowKind)
      ? (w.kind as WindowKind)
      : 'unknown';
  const accuracy: QuotaAccuracy =
    typeof w.accuracy === 'string' && VALID_ACCURACIES.has(w.accuracy as QuotaAccuracy)
      ? (w.accuracy as QuotaAccuracy)
      : 'unavailable';

  return {
    id: w.id.trim(),
    label: w.label.trim(),
    groupId: typeof w.groupId === 'string' && w.groupId.trim() ? w.groupId.trim() : null,
    groupLabel: typeof w.groupLabel === 'string' && w.groupLabel.trim() ? w.groupLabel.trim() : null,
    kind,
    models: Array.isArray(w.models)
      ? w.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [],
    remainingPercent,
    usedPercent,
    usedUnits: typeof w.usedUnits === 'number' && Number.isFinite(w.usedUnits) ? w.usedUnits : null,
    limitUnits: typeof w.limitUnits === 'number' && Number.isFinite(w.limitUnits) ? w.limitUnits : null,
    resetAtMs: normalizeEpochMs(w.resetAtMs),
    windowDurationMs:
      typeof w.windowDurationMs === 'number' && Number.isFinite(w.windowDurationMs) && w.windowDurationMs > 0
        ? w.windowDurationMs
        : null,
    accuracy,
    source: typeof w.source === 'string' && w.source.trim() ? w.source.trim() : 'unknown',
  };
}

function sanitizeProviderSnapshot(
  provider: ProviderId,
  raw: unknown
): ProviderQuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const fetchedAtMs = normalizeEpochMs(obj.fetchedAtMs);
  if (fetchedAtMs === null) return null;

  const status: QuotaStatus =
    typeof obj.status === 'string' && VALID_STATUSES.has(obj.status as QuotaStatus)
      ? (obj.status as QuotaStatus)
      : 'unavailable';
  const windows = Array.isArray(obj.windows)
    ? obj.windows.map(sanitizeWindow).filter((w): w is QuotaWindow => w !== null)
    : [];
  const sourceUpdatedAtMs = normalizeEpochMs(obj.sourceUpdatedAtMs);
  const serverNowMs = normalizeEpochMs(obj.serverNowMs) ?? fetchedAtMs;
  const clockSkewMs =
    typeof obj.clockSkewMs === 'number' && Number.isFinite(obj.clockSkewMs)
      ? Math.round(obj.clockSkewMs)
      : 0;

  let error: ProviderQuotaSnapshot['error'] = null;
  if (obj.error && typeof obj.error === 'object') {
    const e = obj.error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.trim()) {
      error = {
        code: typeof e.code === 'string' && e.code.trim() ? e.code.trim() : 'UNKNOWN',
        message: e.message.trim(),
      };
    }
  }

  return {
    provider,
    planLabel: typeof obj.planLabel === 'string' && obj.planLabel.trim() ? obj.planLabel.trim() : null,
    creditsBalance:
      typeof obj.creditsBalance === 'number' && Number.isFinite(obj.creditsBalance)
        ? obj.creditsBalance
        : null,
    status,
    windows,
    fetchedAtMs,
    sourceUpdatedAtMs,
    serverNowMs,
    ...(clockSkewMs !== 0 ? { clockSkewMs } : {}),
    error,
  };
}

function migrateLegacyV3Telemetry(
  provider: 'claude' | 'codex',
  rawTel: unknown
): ProviderQuotaSnapshot | null {
  if (!rawTel || typeof rawTel !== 'object') return null;
  const t = rawTel as Record<string, unknown>;
  const capturedAtMs = normalizeEpochMs(t.capturedAt);
  if (capturedAtMs === null) return null;

  const windows: QuotaWindow[] = [];
  const convertWin = (rawWin: unknown, id: string, label: string, kind: WindowKind, defaultDur: number) => {
    if (!rawWin || typeof rawWin !== 'object') return;
    const w = rawWin as Record<string, unknown>;
    if (typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct)) return;
    const { remainingPercent, usedPercent } = computePercentPair({ usedPercent: w.usedPct });
    const wm = typeof w.windowMinutes === 'number' && Number.isFinite(w.windowMinutes) ? w.windowMinutes : null;
    windows.push({
      id,
      label,
      kind,
      models: [],
      remainingPercent,
      usedPercent,
      resetAtMs: normalizeEpochMs(w.resetsAt),
      windowDurationMs: wm ? wm * 60_000 : defaultDur,
      accuracy: 'exact',
      source: provider === 'claude' ? 'claude_statusline' : 'codex_session_jsonl',
    });
  };

  if (provider === 'claude') {
    convertWin(t.sevenDay, 'claude:7d', '7d Weekly', 'weekly_7d', 7 * 86_400_000);
    convertWin(t.fiveHour, 'claude:5h', '5h Rolling', 'rolling_5h', 5 * 3_600_000);
  } else {
    convertWin(t.sevenDay, 'codex:secondary', 'Secondary Limit', 'secondary', 7 * 86_400_000);
    convertWin(t.fiveHour, 'codex:primary', 'Primary Limit', 'primary', 5 * 3_600_000);
  }

  if (windows.length === 0) return null;
  const isExhausted = windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0);
  return {
    provider,
    planLabel: typeof t.planType === 'string' && t.planType.trim() ? t.planType.trim() : null,
    status: isExhausted ? 'exhausted' : 'ok',
    windows,
    fetchedAtMs: capturedAtMs,
    sourceUpdatedAtMs: capturedAtMs,
    serverNowMs: Date.now(),
    error: null,
  };
}

export function sanitizeQuotaStore(raw: unknown): QuotaStoreFile {
  const empty: QuotaStoreFile = {
    schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
    updatedAtMs: 0,
    providers: {},
    rawPayloads: {},
  };
  if (!raw || typeof raw !== 'object') return empty;
  const obj = raw as Record<string, unknown>;
  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;

  // Migrate v3 official telemetry for Claude/Codex cleanly while discarding legacy Antigravity heuristic calibrations
  if (schemaVersion < CURRENT_QUOTA_SCHEMA_VERSION) {
    const rawTel =
      obj.telemetry && typeof obj.telemetry === 'object'
        ? (obj.telemetry as Record<string, unknown>)
        : {};
    const providers: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {};
    const migratedClaude = migrateLegacyV3Telemetry('claude', rawTel.claude);
    if (migratedClaude) providers.claude = migratedClaude;
    const migratedCodex = migrateLegacyV3Telemetry('codex', rawTel.codex);
    if (migratedCodex) providers.codex = migratedCodex;
    return {
      schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
      updatedAtMs: Date.now(),
      providers,
      rawPayloads: {},
    };
  }

  const providers: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {};
  const rawProviders =
    obj.providers && typeof obj.providers === 'object'
      ? (obj.providers as Record<string, unknown>)
      : {};
  for (const p of VALID_PROVIDERS) {
    const snap = sanitizeProviderSnapshot(p, rawProviders[p]);
    if (snap) providers[p] = snap;
  }

  const rawPayloads: Partial<Record<ProviderId, unknown>> = {};
  const srcRaw =
    obj.rawPayloads && typeof obj.rawPayloads === 'object'
      ? (obj.rawPayloads as Record<string, unknown>)
      : {};
  for (const p of VALID_PROVIDERS) {
    if (srcRaw[p] !== undefined) {
      rawPayloads[p] = sanitizeRawPayload(srcRaw[p]);
    }
  }

  return {
    schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
    updatedAtMs: normalizeEpochMs(obj.updatedAtMs) ?? 0,
    providers,
    rawPayloads,
  };
}

export function loadQuotaStore(): QuotaStoreFile {
  if (!isPersistentQuotaEnabled()) {
    return structuredClone(memoryQuotaStore);
  }
  const quotaPath = getQuotaStatePath();
  if (!fs.existsSync(quotaPath)) {
    return {
      schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
      updatedAtMs: 0,
      providers: {},
      rawPayloads: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(quotaPath, 'utf-8'));
    return sanitizeQuotaStore(parsed);
  } catch {
    return {
      schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
      updatedAtMs: 0,
      providers: {},
      rawPayloads: {},
    };
  }
}

export function saveQuotaStore(next: QuotaStoreFile): QuotaStoreFile {
  const sanitized = sanitizeQuotaStore({
    ...next,
    schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
    updatedAtMs: next.updatedAtMs || Date.now(),
  });
  if (!isPersistentQuotaEnabled()) {
    memoryQuotaStore = structuredClone(sanitized);
    return sanitized;
  }
  try {
    const quotaPath = getQuotaStatePath();
    fs.mkdirSync(path.dirname(quotaPath), { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(sanitized, null, 2);
    const tmpPath = `${quotaPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, quotaPath);
    } catch {
      fs.writeFileSync(quotaPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore read-only FS errors
  }
  return sanitized;
}

export function saveProviderQuotaSnapshot(
  snapshot: ProviderQuotaSnapshot,
  rawPayload?: unknown
): QuotaStoreFile {
  const store = loadQuotaStore();
  const existing = store.providers[snapshot.provider];

  if (
    existing &&
    snapshot.sourceUpdatedAtMs !== null &&
    existing.sourceUpdatedAtMs !== null &&
    snapshot.sourceUpdatedAtMs < existing.sourceUpdatedAtMs &&
    snapshot.status !== 'auth_error'
  ) {
    // Ignore stale out-of-order updates for the same account
    return store;
  }

  return saveQuotaStore({
    schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
    updatedAtMs: Date.now(),
    providers: {
      ...store.providers,
      [snapshot.provider]: snapshot,
    },
    rawPayloads: {
      ...(store.rawPayloads || {}),
      ...(rawPayload !== undefined ? { [snapshot.provider]: sanitizeRawPayload(rawPayload) } : {}),
    },
  });
}

export function resetQuotaStoreForTests(): void {
  memoryQuotaStore = {
    schemaVersion: CURRENT_QUOTA_SCHEMA_VERSION,
    updatedAtMs: 0,
    providers: {},
    rawPayloads: {},
  };
}
