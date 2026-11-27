import { getWatchRoots } from '../parser.js';
import { loadUserSettings } from '../settings.js';
import {
  evaluateCountdown,
  formatResetIsoLocal,
  normalizeEpochMs,
} from './time.js';
import {
  loadQuotaStore,
  sanitizeRawPayload,
  saveProviderQuotaSnapshot,
} from './store.js';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaDebugEntry,
  QuotaWindow,
  QuotaWindowDiagnostic,
} from './types.js';
import {
  fetchAntigravityLiveQuota,
  parseAntigravityStatuslinePayload,
  projectAntigravitySnapshotAtTime,
} from './providers/antigravity.js';
import {
  parseClaudeStatuslinePayload,
  projectClaudeSnapshotAtTime,
} from './providers/claude.js';
import {
  parseCodexRateLimitsEvent,
  projectCodexSnapshotAtTime,
  scanLatestCodexQuota,
} from './providers/codex.js';

const DEFAULT_ANTIGRAVITY_TTL_MS = 120_000;
const ACTIVITY_ANTIGRAVITY_COOLDOWN_MS = 15_000;
const BACKGROUND_POLL_INTERVAL_MS = 180_000;
const MAX_ROLLOVER_RETRIES = 3;

export interface QuotaEngineOptions {
  antigravityTtlMs?: number;
  activityCooldownMs?: number;
  pollIntervalMs?: number;
  onUpdate?: (quotas: Record<ProviderId, ProviderQuotaSnapshot>, reason: string) => void;
}

export class QuotaEngine {
  private readonly inFlight = new Map<ProviderId, Promise<ProviderQuotaSnapshot>>();
  private readonly antigravityTtlMs: number;
  private readonly activityCooldownMs: number;
  private readonly pollIntervalMs: number;
  private onUpdate?: QuotaEngineOptions['onUpdate'];

  private lastActivityAttemptMs: Record<ProviderId, number> = {
    antigravity: 0,
    claude: 0,
    codex: 0,
  };
  private rolloverTimer: NodeJS.Timeout | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private activityDebounceTimer: NodeJS.Timeout | null = null;
  private rolloverRetryCount = 0;
  private isLiveSyncRunning = false;

  constructor(opts: QuotaEngineOptions = {}) {
    this.antigravityTtlMs = opts.antigravityTtlMs ?? DEFAULT_ANTIGRAVITY_TTL_MS;
    this.activityCooldownMs = opts.activityCooldownMs ?? ACTIVITY_ANTIGRAVITY_COOLDOWN_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? BACKGROUND_POLL_INTERVAL_MS;
    this.onUpdate = opts.onUpdate;
  }

  public getCachedQuotas(serverNowMs = Date.now()): Record<ProviderId, ProviderQuotaSnapshot> {
    const store = loadQuotaStore();
    const { codexDir } = getWatchRoots();

    const agyProjected = projectAntigravitySnapshotAtTime(
      store.providers.antigravity,
      serverNowMs
    ).snapshot;

    const claudeProjected = projectClaudeSnapshotAtTime(
      store.providers.claude,
      serverNowMs
    );

    const scannedCodex = scanLatestCodexQuota(codexDir, serverNowMs);
    let codexSnap: ProviderQuotaSnapshot;
    if (scannedCodex.snapshot) {
      const storedCodex = store.providers.codex;
      if (
        !storedCodex ||
        (scannedCodex.snapshot.sourceUpdatedAtMs ?? 0) > (storedCodex.sourceUpdatedAtMs ?? 0)
      ) {
        saveProviderQuotaSnapshot(scannedCodex.snapshot, scannedCodex.rawPayloadSanitized);
        codexSnap = scannedCodex.snapshot;
      } else {
        codexSnap = projectCodexSnapshotAtTime(storedCodex, serverNowMs);
      }
    } else {
      codexSnap = projectCodexSnapshotAtTime(store.providers.codex, serverNowMs);
    }

    return {
      antigravity: agyProjected,
      claude: claudeProjected,
      codex: codexSnap,
    };
  }

  public refreshProvider(
    provider: ProviderId,
    opts: { force?: boolean; reason?: string } = {}
  ): Promise<ProviderQuotaSnapshot> {
    const existingPromise = this.inFlight.get(provider);
    if (existingPromise) {
      return existingPromise;
    }

    const work = this.executeProviderRefresh(provider, opts)
      .finally(() => {
        this.inFlight.delete(provider);
        if (this.isLiveSyncRunning) {
          this.scheduleNextRollover();
        }
      });

    this.inFlight.set(provider, work);
    return work;
  }

  private async executeProviderRefresh(
    provider: ProviderId,
    opts: { force?: boolean; reason?: string }
  ): Promise<ProviderQuotaSnapshot> {
    const nowMs = Date.now();
    const store = loadQuotaStore();
    const { geminiDir, codexDir } = getWatchRoots();

    if (provider === 'antigravity') {
      const cached = store.providers.antigravity;
      const projected = projectAntigravitySnapshotAtTime(cached, nowMs);
      const minAge = opts.reason === 'activity' ? this.activityCooldownMs : this.antigravityTtlMs;
      const isFresh =
        Boolean(cached) &&
        !projected.needsRefresh &&
        nowMs - cached!.fetchedAtMs < minAge &&
        cached!.status !== 'unavailable';

      if (!opts.force && isFresh) {
        return projected.snapshot;
      }

      const res = await fetchAntigravityLiveQuota({
        geminiDir,
        previous: cached,
      });
      saveProviderQuotaSnapshot(res.snapshot, res.rawPayloadSanitized);

      if (opts.reason === 'rollover') {
        const stillExpired = res.snapshot.windows.some(
          (w) => w.resetAtMs !== null && Date.now() >= w.resetAtMs
        );
        if (
          (stillExpired || res.snapshot.status === 'stale') &&
          this.rolloverRetryCount < MAX_ROLLOVER_RETRIES &&
          this.isLiveSyncRunning
        ) {
          this.rolloverRetryCount++;
          const backoffMs = 3000 * 3 ** (this.rolloverRetryCount - 1) + Math.floor(Math.random() * 1500);
          this.scheduleRetryTimer(backoffMs);
        } else {
          this.rolloverRetryCount = 0;
        }
      }

      return res.snapshot;
    }

    if (provider === 'claude') {
      return projectClaudeSnapshotAtTime(store.providers.claude, nowMs);
    }

    const scanned = scanLatestCodexQuota(codexDir, nowMs);
    if (scanned.snapshot) {
      saveProviderQuotaSnapshot(scanned.snapshot, scanned.rawPayloadSanitized);
      return scanned.snapshot;
    }
    return projectCodexSnapshotAtTime(store.providers.codex, nowMs);
  }

  public async refreshAll(opts: {
    force?: boolean;
    reason?: string;
    provider?: ProviderId;
  } = {}): Promise<Record<ProviderId, ProviderQuotaSnapshot>> {
    if (opts.provider) {
      await this.refreshProvider(opts.provider, opts);
      return this.getCachedQuotas(Date.now());
    }
    const [antigravity, claude, codex] = await Promise.all([
      this.refreshProvider('antigravity', opts),
      this.refreshProvider('claude', opts),
      this.refreshProvider('codex', opts),
    ]);
    return { antigravity, claude, codex };
  }

  public notifyActivity(provider: ProviderId): void {
    if (loadUserSettings().experimentalQuota === false) return;
    const now = Date.now();
    if (now - this.lastActivityAttemptMs[provider] < this.activityCooldownMs) {
      return;
    }
    if (this.activityDebounceTimer) clearTimeout(this.activityDebounceTimer);
    this.activityDebounceTimer = setTimeout(() => {
      this.lastActivityAttemptMs[provider] = Date.now();
      void this.refreshProvider(provider, { force: provider !== 'antigravity', reason: 'activity' })
        .then(() => {
          this.onUpdate?.(this.getCachedQuotas(Date.now()), `quota-activity:${provider}`);
        })
        .catch(() => undefined);
    }, 800);
    this.activityDebounceTimer.unref?.();
  }

  public startLiveSync(opts?: {
    onUpdate?: QuotaEngineOptions['onUpdate'];
  }): void {
    if (opts?.onUpdate) {
      this.onUpdate = opts.onUpdate;
    }
    this.stopLiveSync();
    this.isLiveSyncRunning = true;

    this.scheduleNextRollover();
    this.pollInterval = setInterval(() => {
      if (loadUserSettings().experimentalQuota === false) return;
      void this.refreshAll({ force: false, reason: 'poll' })
        .then((quotas) => {
          this.onUpdate?.(quotas, 'quota-poll');
        })
        .catch(() => undefined);
    }, this.pollIntervalMs);
    this.pollInterval.unref?.();
  }

  public stopLiveSync(): void {
    this.isLiveSyncRunning = false;
    if (this.rolloverTimer) {
      clearTimeout(this.rolloverTimer);
      this.rolloverTimer = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.activityDebounceTimer) {
      clearTimeout(this.activityDebounceTimer);
      this.activityDebounceTimer = null;
    }
  }

  private scheduleRetryTimer(delayMs: number): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    this.rolloverTimer = setTimeout(() => {
      void this.refreshAll({ force: true, reason: 'rollover' })
        .then((quotas) => {
          this.onUpdate?.(quotas, 'quota-rollover-retry');
        })
        .catch(() => undefined);
    }, delayMs);
    this.rolloverTimer.unref?.();
  }

  public scheduleNextRollover(): void {
    if (this.rolloverTimer) {
      clearTimeout(this.rolloverTimer);
      this.rolloverTimer = null;
    }
    if (!this.isLiveSyncRunning) return;

    const nowMs = Date.now();
    const quotas = this.getCachedQuotas(nowMs);
    let earliestResetMs: number | null = null;
    let targetProvider: ProviderId | null = null;

    for (const p of ['antigravity', 'claude', 'codex'] as const) {
      const snap = quotas[p];
      const skew = snap.clockSkewMs ?? 0;
      for (const w of snap.windows) {
        if (w.resetAtMs === null) continue;
        const correctedNow = nowMs + skew;
        if (w.resetAtMs > correctedNow) {
          const waitUntilLocalMs = w.resetAtMs - skew;
          if (earliestResetMs === null || waitUntilLocalMs < earliestResetMs) {
            earliestResetMs = waitUntilLocalMs;
            targetProvider = p;
          }
        }
      }
    }

    if (earliestResetMs === null || targetProvider === null) return;

    // Rollover + small jitter (+2s to +5s) avoids thundering herd at exact window boundaries
    const jitterMs = 2000 + Math.floor(Math.random() * 3000);
    const delayMs = Math.min(2_147_483_000, Math.max(2000, earliestResetMs - nowMs + jitterMs));
    const providerToRefresh = targetProvider;

    this.rolloverTimer = setTimeout(() => {
      void this.refreshProvider(providerToRefresh, { force: true, reason: 'rollover' })
        .then(() => {
          this.onUpdate?.(this.getCachedQuotas(Date.now()), `quota-rollover:${providerToRefresh}`);
        })
        .catch(() => undefined);
    }, delayMs);
    this.rolloverTimer.unref?.();
  }

  public async collectDiagnostics(opts: { force?: boolean } = {}): Promise<QuotaDebugEntry[]> {
    const quotas = await this.refreshAll({ force: opts.force ?? true, reason: 'diagnostics' });
    const store = loadQuotaStore();
    const evalNowMs = Date.now();
    const providers: readonly ProviderId[] = ['antigravity', 'claude', 'codex'];

    return providers.map((provider) => {
      const snap = quotas[provider];
      const skew = snap.clockSkewMs ?? 0;
      const computedWindows: QuotaWindowDiagnostic[] = snap.windows.map((w: QuotaWindow) => {
        const cd = evaluateCountdown(w.resetAtMs, evalNowMs, skew);
        return {
          id: w.id,
          label: w.label,
          kind: w.kind,
          accuracy: w.accuracy,
          source: w.source,
          remainingPercent: w.remainingPercent,
          usedPercent: w.usedPercent,
          resetAtMs: w.resetAtMs,
          resetAtIsoLocal: formatResetIsoLocal(w.resetAtMs),
          remainingMs: cd.remainingMs,
          countdown: cd.formattedDetailed,
        };
      });

      return {
        provider,
        source: snap.windows[0]?.source || (snap.error?.code ?? 'none'),
        rawPayloadSanitized: store.rawPayloads?.[provider] ?? null,
        snapshot: snap,
        computedWindows,
      };
    });
  }
}

export const defaultQuotaEngine = new QuotaEngine();

export function recordHookQuotaPayload(
  payload: Record<string, unknown>,
  nowMs = Date.now()
): ProviderQuotaSnapshot | null {
  if (payload.product === 'antigravity' || (payload.quota && typeof payload.quota === 'object')) {
    const parsedAgy = parseAntigravityStatuslinePayload(payload, {
      fetchedAtMs: nowMs,
      serverNowMs: nowMs,
    });
    if (parsedAgy) {
      saveProviderQuotaSnapshot(parsedAgy, sanitizeRawPayload(payload));
      return parsedAgy;
    }
  }

  if (payload.rate_limits && typeof payload.rate_limits === 'object') {
    const capturedAtMs = normalizeEpochMs(payload.timestamp) ?? nowMs;
    const parsedClaude = parseClaudeStatuslinePayload(payload, {
      capturedAtMs,
      serverNowMs: nowMs,
    });
    if (parsedClaude) {
      saveProviderQuotaSnapshot(parsedClaude, sanitizeRawPayload(payload));
      return parsedClaude;
    }

    const parsedCodex = parseCodexRateLimitsEvent(payload, {
      eventTimestampMs: capturedAtMs,
      serverNowMs: nowMs,
      source: 'codex_hook',
    });
    if (parsedCodex) {
      const { _isPrimaryLimitId: _ignored, ...cleanCodex } = parsedCodex;
      saveProviderQuotaSnapshot(cleanCodex, sanitizeRawPayload(payload));
      return cleanCodex;
    }
  }

  return null;
}
