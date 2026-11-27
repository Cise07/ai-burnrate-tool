export type ProviderId = 'antigravity' | 'claude' | 'codex';
export type QuotaAccuracy = 'exact' | 'derived' | 'unavailable';
export type QuotaStatus = 'ok' | 'exhausted' | 'stale' | 'auth_error' | 'unavailable';
export type WindowKind =
  | 'rolling_5h'
  | 'weekly_7d'
  | 'daily'
  | 'model_pool'
  | 'primary'
  | 'secondary'
  | 'unknown';

export interface QuotaWindow {
  id: string;
  label: string;
  groupId?: string | null;
  groupLabel?: string | null;
  kind: WindowKind;
  models: string[];
  remainingPercent: number | null;
  usedPercent: number | null;
  usedUnits?: number | null;
  limitUnits?: number | null;
  resetAtMs: number | null;
  windowDurationMs?: number | null;
  accuracy: QuotaAccuracy;
  source: string;
}

export interface ProviderQuotaError {
  code: string;
  message: string;
}

export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  planLabel?: string | null;
  creditsBalance?: number | null;
  status: QuotaStatus;
  windows: QuotaWindow[];
  fetchedAtMs: number;
  sourceUpdatedAtMs: number | null;
  serverNowMs: number;
  clockSkewMs?: number;
  error?: ProviderQuotaError | null;
}

export interface QuotaStoreFile {
  schemaVersion: 4;
  updatedAtMs: number;
  providers: Partial<Record<ProviderId, ProviderQuotaSnapshot>>;
  rawPayloads?: Partial<Record<ProviderId, unknown>>;
}

export interface QuotaWindowDiagnostic {
  id: string;
  label: string;
  kind: WindowKind;
  accuracy: QuotaAccuracy;
  source: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetAtMs: number | null;
  resetAtIsoLocal: string | null;
  remainingMs: number | null;
  countdown: string;
}

export interface QuotaDebugEntry {
  provider: ProviderId;
  source: string;
  rawPayloadSanitized: unknown;
  snapshot: ProviderQuotaSnapshot;
  computedWindows: QuotaWindowDiagnostic[];
}
