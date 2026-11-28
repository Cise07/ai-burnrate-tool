import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  ChevronDown,
  Clock,
  Gauge,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { ToolFilter } from '../../core/analytics';
import {
  evaluateCountdown,
  formatDisplayPercent,
  formatMinutesAgo,
  formatResetLocalTime,
  msUntilNextAlignedTick,
} from '../../core/quota/time';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaDebugEntry,
  QuotaStatus,
  QuotaWindow,
} from '../../core/quota/types';
import type { BurnrateSnapshot } from '../../core/types';

interface QuotaEstimateSectionProps {
  quotas?: Record<ProviderId, ProviderQuotaSnapshot>;
  serverNowMs?: number;
  toolFilter: ToolFilter;
  onSnapshotUpdated: (snapshot: BurnrateSnapshot) => void;
  onOpenSettings?: () => void;
}

const PROVIDER_ORDER: readonly ProviderId[] = ['antigravity', 'claude', 'codex'];

const PROVIDER_META: Record<
  ProviderId,
  { label: string; shortCode: string; accent: string; awaitingHint: string }
> = {
  antigravity: {
    label: 'Antigravity',
    shortCode: 'AGY',
    accent: 'var(--tool-antigravity)',
    awaitingHint:
      'Synced live from official `agy -p /usage` telemetry (independent Gemini & Claude/GPT pools).',
  },
  claude: {
    label: 'Claude Code',
    shortCode: 'CLD',
    accent: 'var(--tool-claude)',
    awaitingHint:
      'Send any prompt in Claude Code to capture exact rate_limits via the `--claude-statusline` hook.',
  },
  codex: {
    label: 'Codex CLI',
    shortCode: 'CDX',
    accent: 'var(--tool-codex)',
    awaitingHint:
      'Send any prompt in Codex CLI to record official `rate_limits` events in local rollout JSONL logs.',
  },
};

function getBarColor(provider: ProviderId, remainingPct: number | null): string {
  if (remainingPct === null) return 'var(--ink-tertiary)';
  if (remainingPct <= 0 || remainingPct < 15) return '#f43f5e';
  if (remainingPct < 40) return 'var(--accent-amber)';
  return PROVIDER_META[provider].accent;
}

function getStatusBadge(
  status: QuotaStatus,
  fetchedAtMs: number,
  nowMs: number,
  hasWindows: boolean
): { label: string; className: string } {
  if (status === 'auth_error') {
    return {
      label: 'AUTH ERR',
      className:
        'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border-[var(--accent-rose-border)]',
    };
  }
  if (!hasWindows || status === 'unavailable') {
    return {
      label: 'SYNC',
      className:
        'bg-[var(--bg-subcard)] text-[var(--ink-secondary)] border-[var(--border-hairline)]',
    };
  }
  if (status === 'exhausted') {
    return {
      label: 'EXHAUSTED',
      className:
        'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border-[var(--accent-rose-border)]',
    };
  }
  if (status === 'stale') {
    return {
      label: `STALE · ${formatMinutesAgo(fetchedAtMs, nowMs)}`,
      className:
        'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border-[var(--accent-amber-border)]',
    };
  }
  return {
    label: 'LIVE',
    className:
      'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border-[var(--accent-teal-border)]',
  };
}

function pickBottleneckWindow(snap: ProviderQuotaSnapshot): QuotaWindow | null {
  if (!snap.windows || snap.windows.length === 0) return null;
  const scoped =
    snap.provider === 'antigravity'
      ? snap.windows.filter((w) => w.groupId === 'gemini')
      : snap.windows;
  const candidates = scoped.length > 0 ? scoped : snap.windows;
  let worst: QuotaWindow | null = null;
  for (const w of candidates) {
    if (w.remainingPercent === null) continue;
    if (!worst || worst.remainingPercent === null || w.remainingPercent < worst.remainingPercent) {
      worst = w;
    }
  }
  return worst ?? candidates[0];
}

function windowPreviewRank(win: QuotaWindow): number {
  if (win.kind === 'weekly_7d' || win.kind === 'secondary') return 0;
  if (win.kind === 'daily') return 1;
  if (win.kind === 'rolling_5h' || win.kind === 'primary') return 2;
  return 3;
}

function formatCompactPoolName(groupLabel: string): string {
  if (/gemini/i.test(groupLabel)) return 'Gemini';
  if (/claude/i.test(groupLabel) && /gpt/i.test(groupLabel)) return 'Claude/GPT';
  return groupLabel.replace(/\s*Models$/i, '').trim() || groupLabel;
}

function formatShortWindowTag(win: QuotaWindow): string {
  if (win.kind === 'weekly_7d' || win.kind === 'secondary') return '7d';
  if (win.kind === 'rolling_5h' || win.kind === 'primary') return '5h';
  if (win.kind === 'daily') return '24h';
  return win.label;
}

function selectCardPreviewWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const rank = (win: QuotaWindow): number => {
    if (win.id.endsWith(':7d') || win.id.endsWith(':secondary')) return 0;
    if (win.kind === 'weekly_7d' || win.kind === 'secondary') return 1;
    if (win.kind === 'daily') return 2;
    if (win.id.endsWith(':5h') || win.id.endsWith(':primary') || win.kind === 'rolling_5h' || win.kind === 'primary') {
      return 3;
    }
    return 4;
  };
  return [...windows].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

function groupAntigravityPools(windows: QuotaWindow[]): Array<{
  groupId: string;
  groupLabel: string;
  models: string[];
  windows: QuotaWindow[];
  tightest: QuotaWindow;
}> {
  const map = new Map<
    string,
    { groupId: string; groupLabel: string; models: Set<string>; windows: QuotaWindow[] }
  >();
  for (const w of windows) {
    const gid = w.groupId || w.id;
    const glabel = w.groupLabel || w.label;
    let entry = map.get(gid);
    if (!entry) {
      entry = { groupId: gid, groupLabel: glabel, models: new Set<string>(), windows: [] };
      map.set(gid, entry);
    }
    for (const m of w.models || []) entry.models.add(m);
    entry.windows.push(w);
  }

  return Array.from(map.values()).map((g) => {
    const sortedWindows = [...g.windows].sort((a, b) => windowPreviewRank(a) - windowPreviewRank(b));
    const tightest = sortedWindows.reduce((best, cur) => {
      if (best.remainingPercent === null) return cur;
      if (cur.remainingPercent === null) return best;
      return cur.remainingPercent < best.remainingPercent ? cur : best;
    }, sortedWindows[0]);
    return {
      groupId: g.groupId,
      groupLabel: g.groupLabel,
      models: Array.from(g.models),
      windows: sortedWindows,
      tightest,
    };
  });
}

function buildEmptyFallback(provider: ProviderId, nowMs: number): ProviderQuotaSnapshot {
  return {
    provider,
    planLabel: null,
    creditsBalance: null,
    status: 'unavailable',
    windows: [],
    fetchedAtMs: nowMs,
    sourceUpdatedAtMs: null,
    serverNowMs: nowMs,
    error: { code: 'AWAITING_SYNC', message: PROVIDER_META[provider].awaitingHint },
  };
}

export function QuotaEstimateSection({
  quotas,
  serverNowMs,
  toolFilter,
  onSnapshotUpdated,
  onOpenSettings,
}: QuotaEstimateSectionProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number>(0);
  const [selectedCardTool, setSelectedCardTool] = useState<ProviderId>('antigravity');
  const [modalTool, setModalTool] = useState<ProviderId>('antigravity');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagEntries, setDiagEntries] = useState<QuotaDebugEntry[] | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const rolloverFiredRef = useRef<Set<string>>(new Set());

  // Re-anchor client clock offset whenever backend emits a fresh serverNowMs
  useEffect(() => {
    if (typeof serverNowMs === 'number' && Number.isFinite(serverNowMs)) {
      const rxNow = Date.now();
      setServerClockOffsetMs(Math.round(serverNowMs - rxNow));
      setNowMs(rxNow);
      rolloverFiredRef.current.clear();
    }
  }, [serverNowMs, quotas]);

  const effectiveQuotas = useMemo<Record<ProviderId, ProviderQuotaSnapshot>>(() => {
    const fallbackNow = nowMs + serverClockOffsetMs;
    return {
      antigravity: quotas?.antigravity ?? buildEmptyFallback('antigravity', fallbackNow),
      claude: quotas?.claude ?? buildEmptyFallback('claude', fallbackNow),
      codex: quotas?.codex ?? buildEmptyFallback('codex', fallbackNow),
    };
  }, [quotas, nowMs, serverClockOffsetMs]);

  const triggerRefresh = useCallback(
    async (provider?: ProviderId) => {
      setIsRefreshing(true);
      setRefreshError(null);
      try {
        const res = await fetch('/api/quota/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Burnrate-Client': '1' },
          body: JSON.stringify(provider ? { provider } : {}),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(errBody?.error || 'Failed to refresh provider quotas');
        }
        const data = (await res.json()) as { snapshot?: BurnrateSnapshot };
        if (data.snapshot) {
          onSnapshotUpdated(data.snapshot);
        }
      } catch (err) {
        setRefreshError(err instanceof Error ? err.message : 'Failed to refresh quotas');
      } finally {
        setIsRefreshing(false);
      }
    },
    [onSnapshotUpdated]
  );

  // Aligned, drift-free tick: aligns to exact minute rollovers (or 1s when < 90s remaining),
  // wakes cleanly after PC standby / background tab switch, and triggers single-flight rollover sync.
  useEffect(() => {
    let timerId: number | null = null;
    let rolloverTimerId: number | null = null;
    let cancelled = false;

    const scheduleTick = () => {
      if (cancelled) return;
      const curNow = Date.now();
      const correctedBaseNow = curNow + serverClockOffsetMs;
      let hasNearExpiry = false;

      for (const p of PROVIDER_ORDER) {
        const snap = effectiveQuotas[p];
        const skew = serverClockOffsetMs + (snap.clockSkewMs ?? 0);
        for (const w of snap.windows) {
          if (w.resetAtMs === null) continue;
          const diff = w.resetAtMs - (curNow + skew);
          if (diff > 0 && diff <= 90_000) {
            hasNearExpiry = true;
          } else if (diff <= 0 && w.source && !w.source.endsWith(':post_reset')) {
            const key = `${p}:${w.id}:${w.resetAtMs}`;
            if (!rolloverFiredRef.current.has(key) && rolloverTimerId === null) {
              rolloverFiredRef.current.add(key);
              const jitter = 2000 + Math.floor(Math.random() * 2000);
              rolloverTimerId = window.setTimeout(() => {
                rolloverTimerId = null;
                void triggerRefresh(p);
              }, jitter);
            }
          }
        }
      }

      const delay = msUntilNextAlignedTick(correctedBaseNow, 0, hasNearExpiry);
      timerId = window.setTimeout(() => {
        setNowMs(Date.now());
        scheduleTick();
      }, delay);
    };

    const handleWake = () => {
      if (document.visibilityState === 'hidden') return;
      if (timerId !== null) window.clearTimeout(timerId);
      setNowMs(Date.now());
      scheduleTick();
    };

    scheduleTick();
    document.addEventListener('visibilitychange', handleWake);
    window.addEventListener('focus', handleWake);

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (rolloverTimerId !== null) window.clearTimeout(rolloverTimerId);
      document.removeEventListener('visibilitychange', handleWake);
      window.removeEventListener('focus', handleWake);
    };
  }, [effectiveQuotas, serverClockOffsetMs, triggerRefresh]);

  const effectiveCardTool: ProviderId =
    toolFilter !== 'all' ? toolFilter : selectedCardTool;
  const activeSnap = effectiveQuotas[effectiveCardTool];
  const activeSkew = serverClockOffsetMs + (activeSnap.clockSkewMs ?? 0);
  const activeBadge = getStatusBadge(
    activeSnap.status,
    activeSnap.fetchedAtMs,
    nowMs + serverClockOffsetMs,
    activeSnap.windows.length > 0
  );

  const loadDiagnostics = async (force = false) => {
    setDiagLoading(true);
    try {
      const res = await fetch(`/api/quota/debug${force ? '?force=1' : ''}`);
      if (res.ok) {
        const data = (await res.json()) as { entries?: QuotaDebugEntry[] };
        if (Array.isArray(data.entries)) setDiagEntries(data.entries);
      }
    } catch {
      // ignore
    } finally {
      setDiagLoading(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isModalOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isModalOpen]);

  const openModal = (initialProvider: ProviderId = effectiveCardTool) => {
    setRefreshError(null);
    setModalTool(initialProvider);
    setIsModalOpen(true);
    if (showDiagnostics) {
      void loadDiagnostics(false);
    }
  };

  const modalSnap = effectiveQuotas[modalTool];
  const modalSkew = serverClockOffsetMs + (modalSnap.clockSkewMs ?? 0);
  const modalBadge = getStatusBadge(
    modalSnap.status,
    modalSnap.fetchedAtMs,
    nowMs + serverClockOffsetMs,
    modalSnap.windows.length > 0
  );
  const agyPools =
    modalTool === 'antigravity' ? groupAntigravityPools(modalSnap.windows) : [];
  const cardAgyPools =
    effectiveCardTool === 'antigravity' ? groupAntigravityPools(activeSnap.windows) : [];
  const primaryAgyPool =
    cardAgyPools.find((p) => p.groupId === 'gemini') ?? cardAgyPools[0] ?? null;
  const secondaryAgyPools = primaryAgyPool
    ? cardAgyPools.filter((p) => p.groupId !== primaryAgyPool.groupId)
    : [];
  const cardHeroWindows: QuotaWindow[] =
    effectiveCardTool === 'antigravity'
      ? primaryAgyPool?.windows ?? []
      : selectCardPreviewWindows(activeSnap.windows).slice(0, 2);
  const cardExtraWindows: QuotaWindow[] =
    effectiveCardTool === 'antigravity'
      ? []
      : selectCardPreviewWindows(activeSnap.windows).slice(2);

  const renderAccuracyChip = (win: QuotaWindow) => {
    if (win.accuracy === 'exact') {
      return (
        <span className="px-1 py-0 rounded text-[8.5px] font-mono font-semibold bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-border)]">
          EXACT
        </span>
      );
    }
    if (win.accuracy === 'derived') {
      return (
        <span className="px-1 py-0 rounded text-[8.5px] font-mono font-semibold bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)]">
          POST-RESET
        </span>
      );
    }
    return (
      <span className="px-1 py-0 rounded text-[8.5px] font-mono bg-[var(--bg-elevated)] text-[var(--ink-tertiary)] border border-[var(--border-hairline)]">
        UNAVAIL
      </span>
    );
  };

  return (
    <>
      {/* KPI Card 4: Live Remaining Quota */}
      <div className="glass-panel glass-interactive rounded-2xl p-5 flex flex-col">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-tertiary)] truncate">
              Remaining Quota
            </span>
            <span
              className={`px-1 py-0 rounded text-[9px] font-mono font-semibold border shrink-0 whitespace-nowrap ${activeBadge.className}`}
              title={`Last fetched ${formatMinutesAgo(activeSnap.fetchedAtMs, nowMs + serverClockOffsetMs)}`}
            >
              {activeBadge.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {toolFilter === 'all' && (
              <div
                className="inline-flex items-center rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-hairline)] p-0.5"
                role="group"
                aria-label="Switch quota provider"
              >
                {PROVIDER_ORDER.map((p) => {
                  const selected = effectiveCardTool === p;
                  const headline = pickBottleneckWindow(effectiveQuotas[p]);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setSelectedCardTool(p)}
                      className={`px-1.5 py-0.5 rounded-md text-[9.5px] font-mono font-semibold transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[var(--table-hover)] text-[var(--ink-primary)]'
                          : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]'
                      }`}
                      style={selected ? { color: PROVIDER_META[p].accent } : undefined}
                      title={`${PROVIDER_META[p].label}: ${
                        headline?.remainingPercent != null
                          ? `${formatDisplayPercent(headline.remainingPercent)} left`
                          : effectiveQuotas[p].status
                      }`}
                    >
                      {PROVIDER_META[p].shortCode}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              onClick={() => openModal(effectiveCardTool)}
              className="p-2 rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[var(--accent-amber)] hover:brightness-110 active:scale-95 transition shrink-0 cursor-pointer"
              title="Inspect live provider windows & diagnostics"
            >
              <Gauge className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="mb-3">
          {cardHeroWindows.length > 0 ? (
            <div className="space-y-1.5">
              {cardHeroWindows.map((win) => {
                const cd = evaluateCountdown(win.resetAtMs, nowMs, activeSkew);
                const localClk = formatResetLocalTime(
                  win.resetAtMs,
                  nowMs + serverClockOffsetMs
                );
                const shortTag = formatShortWindowTag(win);
                const color = getBarColor(effectiveCardTool, win.remainingPercent);
                return (
                  <div key={win.id} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[10px] font-mono font-semibold uppercase text-[var(--ink-secondary)] w-7 text-center shrink-0">
                        {shortTag}
                      </span>
                      <button
                        type="button"
                        onClick={() => openModal(effectiveCardTool)}
                        className="text-2xl font-bold font-mono tabular tracking-tight leading-none hover:opacity-85 transition-opacity cursor-pointer text-left"
                        style={{ color }}
                        title={
                          win.remainingPercent != null
                            ? `Exact: ${win.remainingPercent}% remaining (${win.label} via ${win.source})`
                            : 'Click to inspect provider status'
                        }
                      >
                        {formatDisplayPercent(win.remainingPercent)}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => openModal(effectiveCardTool)}
                      title={
                        localClk
                          ? `Exact local reset time: ${localClk}`
                          : 'Click to view full reset details'
                      }
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--bg-subcard)] border border-[var(--border-hairline)] hover:border-[var(--border-strong)] text-[10px] font-mono tabular text-[var(--ink-secondary)] cursor-pointer transition-colors shrink-0"
                    >
                      <Clock className="w-2.5 h-2.5 shrink-0 text-[var(--ink-tertiary)]" />
                      <span>
                        {cd.state === 'idle'
                          ? 'Ready'
                          : cd.state === 'refreshing'
                            ? 'Updating...'
                            : `in ${cd.formatted}${localClk ? ` · ${localClk}` : ''}`}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-wrap items-baseline gap-2">
              <button
                type="button"
                onClick={() => openModal(effectiveCardTool)}
                className="text-3xl font-bold font-mono tabular tracking-tight text-[var(--ink-tertiary)] hover:opacity-85 transition-opacity cursor-pointer text-left"
                title="Click to inspect provider status"
              >
                —
              </button>
              <button
                type="button"
                onClick={() => openModal(effectiveCardTool)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--bg-subcard)] border border-[var(--border-hairline)] hover:border-[var(--border-strong)] text-[10.5px] font-mono tabular text-[var(--ink-secondary)] cursor-pointer transition-colors"
              >
                <Clock className="w-2.5 h-2.5 shrink-0 text-[var(--ink-tertiary)]" />
                <span>
                  {activeSnap.status === 'auth_error' ? 'Sign in required' : 'Awaiting telemetry'}
                </span>
              </button>
            </div>
          )}

          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span className="text-[var(--ink-tertiary)] truncate">
              <span className="text-[var(--ink-secondary)] font-medium">
                {PROVIDER_META[effectiveCardTool].label}
              </span>
              {activeSnap.planLabel ? ` (${activeSnap.planLabel})` : ''}
              {effectiveCardTool === 'antigravity' && primaryAgyPool
                ? ` · ${formatCompactPoolName(primaryAgyPool.groupLabel)}`
                : ''}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {effectiveCardTool === 'antigravity' && (
                <button
                  type="button"
                  disabled={isRefreshing}
                  onClick={() => void triggerRefresh('antigravity')}
                  className="inline-flex items-center gap-1 text-[10.5px] font-mono text-[var(--ink-secondary)] hover:text-[var(--accent-teal)] cursor-pointer disabled:opacity-50"
                  title="Sync now from Antigravity CLI"
                >
                  <RefreshCw className={`w-2.5 h-2.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              )}
              <button
                type="button"
                onClick={() => openModal(effectiveCardTool)}
                className="text-[10.5px] font-mono text-[var(--ink-secondary)] hover:text-[var(--accent-teal)] underline decoration-dotted underline-offset-2 cursor-pointer transition-colors"
              >
                Details
              </button>
            </div>
          </div>
        </div>

        {/* Card Footer: small rows for secondary pools (Claude & GPT on Antigravity; extra model pools on Claude/Codex) */}
        {(() => {
          const footerRows =
            effectiveCardTool === 'antigravity'
              ? secondaryAgyPools.flatMap((pool) =>
                  pool.windows.map((win) => ({
                    win,
                    labelText: `${formatCompactPoolName(pool.groupLabel)} · ${formatShortWindowTag(win)}`,
                    titlePrefix: `${pool.groupLabel} · ${win.label}`,
                  }))
                )
              : cardExtraWindows.map((win) => ({
                  win,
                  labelText: win.label,
                  titlePrefix: win.label,
                }));

          if (footerRows.length > 0) {
            return (
              <div className="mt-auto space-y-1.5 pt-3 border-t border-[var(--border-hairline)] min-h-[68px] flex flex-col justify-center">
                {footerRows.map(({ win, labelText, titlePrefix }) => {
                  const cd = evaluateCountdown(win.resetAtMs, nowMs, activeSkew);
                  const localClk = formatResetLocalTime(
                    win.resetAtMs,
                    nowMs + serverClockOffsetMs
                  );
                  const color = getBarColor(effectiveCardTool, win.remainingPercent);
                  return (
                    <button
                      key={win.id}
                      type="button"
                      onClick={() => openModal(effectiveCardTool)}
                      className="w-full grid grid-cols-[5.75rem_minmax(2rem,1fr)_auto] items-center gap-2 text-left group cursor-pointer"
                      title={`${titlePrefix}: ${win.remainingPercent ?? '—'}% left${
                        cd.state === 'idle'
                          ? ' · Ready'
                          : cd.state === 'refreshing'
                            ? ' · Updating...'
                            : ` · ${cd.formattedDetailed}${localClk ? ` (${localClk})` : ''}`
                      }`}
                    >
                      <span className="text-[10px] font-mono text-[var(--ink-secondary)] group-hover:text-[var(--ink-primary)] truncate transition-colors">
                        {labelText}
                      </span>
                      <div className="h-1.5 w-full rounded-full bg-[var(--track-bg)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-[width,background-color] duration-300 ease-burn-out"
                          style={{
                            width:
                              win.remainingPercent !== null && win.remainingPercent > 0
                                ? `${Math.min(100, Math.max(3, win.remainingPercent))}%`
                                : '0%',
                            backgroundColor: color,
                          }}
                        />
                      </div>
                      <span className="text-[10px] font-mono tabular text-right whitespace-nowrap min-w-[5.25rem]">
                        <span className="font-semibold" style={{ color }}>
                          {formatDisplayPercent(win.remainingPercent)}
                        </span>
                        <span className="text-[var(--ink-tertiary)]">
                          {cd.state === 'idle'
                            ? ' · Ready'
                            : cd.state === 'refreshing'
                              ? ' · …'
                              : ` · ${cd.formatted}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          }

          if (cardHeroWindows.length > 0) {
            return (
              <div className="mt-auto pt-3 border-t border-[var(--border-hairline)] min-h-[68px] flex items-center justify-between gap-2 text-[10.5px] font-mono text-[var(--ink-tertiary)]">
                <span className="truncate">
                  {`Source: ${cardHeroWindows[0]?.source || 'live'} · ${formatMinutesAgo(
                    activeSnap.fetchedAtMs,
                    nowMs + serverClockOffsetMs
                  )}`}
                </span>
                {renderAccuracyChip(cardHeroWindows[0])}
              </div>
            );
          }

          return (
            <div className="mt-auto pt-3 border-t border-[var(--border-hairline)] min-h-[68px] flex items-center justify-between gap-2 text-[11px] font-mono text-[var(--ink-tertiary)]">
              <span className="truncate">
                {activeSnap.error?.message || PROVIDER_META[effectiveCardTool].awaitingHint}
              </span>
            </div>
          );
        })()}
      </div>

      {/* Live Quota & Diagnostics Modal */}
      <dialog
        ref={dialogRef}
        {...({ closedby: 'any' } as Record<string, string>)}
        onClose={() => setIsModalOpen(false)}
        aria-labelledby="quota-modal-title"
        className="dash-dialog w-[min(calc(100vw-1rem),44rem)]"
      >
        <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--border-hairline)] flex items-start justify-between gap-3 bg-[var(--bg-modal-band)] shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2 rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[var(--accent-amber)] mt-0.5 shrink-0">
              <Gauge className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 id="quota-modal-title" className="text-sm font-semibold text-[var(--ink-primary)]">
                  Live Provider Quotas
                </h1>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase tracking-wider bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)]">
                  Experimental
                </span>
              </div>
              <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
                Authoritative quota percentages &amp; drift-free local reset schedules per provider.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={isRefreshing}
              onClick={() => void triggerRefresh()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--accent-teal-soft)] border border-[var(--accent-teal-border)] text-[10px] font-mono font-semibold text-[var(--accent-teal)] hover:brightness-110 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span>{isRefreshing ? 'Syncing...' : 'Sync Now'}</span>
            </button>
            {onOpenSettings && (
              <button
                type="button"
                onClick={() => {
                  setIsModalOpen(false);
                  onOpenSettings();
                }}
                className="px-2 py-1 rounded-lg border border-[var(--border-hairline)] text-[10px] font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:border-[var(--border-strong)] transition-colors cursor-pointer"
              >
                Disable
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              aria-label="Close quota details"
              className="group p-1.5 rounded-lg text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] hover:bg-[var(--table-hover)] transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4 transition-transform duration-200 group-hover:rotate-90" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 space-y-4">
          {/* Provider Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center rounded-xl bg-[var(--bg-subcard)] border border-[var(--border-hairline)] p-1 gap-1">
              {PROVIDER_ORDER.map((p) => {
                const snap = effectiveQuotas[p];
                const isSelected = modalTool === p;
                const headline = pickBottleneckWindow(snap);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setModalTool(p)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--bg-elevated)] text-[var(--ink-primary)] font-semibold border border-[var(--border-hairline)]'
                        : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                    }`}
                  >
                    <span
                      className="size-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: PROVIDER_META[p].accent }}
                    />
                    <span>{PROVIDER_META[p].label}</span>
                    <span
                      className="font-semibold"
                      style={{
                        color: getBarColor(p, headline?.remainingPercent ?? null),
                      }}
                    >
                      {headline ? formatDisplayPercent(headline.remainingPercent) : '—'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono">
              <span className={`px-2 py-0.5 rounded-md border font-semibold ${modalBadge.className}`}>
                {modalBadge.label}
              </span>
              {typeof modalSnap.creditsBalance === 'number' && (
                <span className="px-2 py-0.5 rounded-md bg-[var(--bg-subcard)] border border-[var(--border-hairline)] text-[var(--ink-secondary)]">
                  Credits: {modalSnap.creditsBalance}
                </span>
              )}
            </div>
          </div>

          {refreshError && (
            <div className="px-3 py-2 rounded-lg bg-[var(--accent-rose-soft)] border border-[var(--accent-rose-border)] text-xs font-mono text-[var(--accent-rose)] flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{refreshError}</span>
            </div>
          )}

          {modalSnap.error && (
            <div
              className={`px-3 py-2 rounded-lg border text-xs font-mono flex items-center gap-2 ${
                modalSnap.status === 'auth_error'
                  ? 'bg-[var(--accent-rose-soft)] border-[var(--accent-rose-border)] text-[var(--accent-rose)]'
                  : 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber)]'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>
                [{modalSnap.error.code}] {modalSnap.error.message}
              </span>
            </div>
          )}

          {/* Windows Display: Grouped Pools for Antigravity, Flat Official Windows for Claude / Codex */}
          {modalTool === 'antigravity' && agyPools.length > 0 ? (
            <div className="space-y-3">
              {agyPools.map((pool) => (
                <div key={pool.groupId} className="glass-subcard rounded-xl p-3.5 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-[var(--ink-primary)]">
                        {pool.groupLabel}
                      </div>
                      {pool.models.length > 0 && (
                        <div className="text-[10.5px] font-mono text-[var(--ink-tertiary)] mt-0.5">
                          {pool.models.join(' · ')}
                        </div>
                      )}
                    </div>
                    <span
                      className="text-base font-bold font-mono tabular shrink-0"
                      style={{ color: getBarColor('antigravity', pool.tightest.remainingPercent) }}
                    >
                      {formatDisplayPercent(pool.tightest.remainingPercent)} left
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {pool.windows.map((win) => {
                      const cd = evaluateCountdown(win.resetAtMs, nowMs, modalSkew);
                      const localClk = formatResetLocalTime(
                        win.resetAtMs,
                        nowMs + serverClockOffsetMs
                      );
                      const color = getBarColor('antigravity', win.remainingPercent);
                      return (
                        <div key={win.id} className="space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular">
                            <span className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
                              <span>{win.label}</span>
                              {renderAccuracyChip(win)}
                            </span>
                            <span className="text-[var(--ink-tertiary)]">
                              <span className="font-semibold" style={{ color }}>
                                {formatDisplayPercent(win.remainingPercent)}
                              </span>
                              {' · '}
                              {cd.state === 'idle'
                                ? 'Ready · Window not started'
                                : cd.state === 'refreshing'
                                  ? 'Updating...'
                                  : `Resets in ${cd.formattedDetailed}${localClk ? ` · ${localClk}` : ''}`}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-[width,background-color] duration-300"
                              style={{
                                width:
                                  win.remainingPercent !== null
                                    ? `${Math.max(0, Math.min(100, win.remainingPercent))}%`
                                    : '0%',
                                backgroundColor: color,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : modalSnap.windows.length > 0 ? (
            <div className="glass-subcard rounded-xl p-4 space-y-3.5">
              {modalSnap.windows.map((win) => {
                const cd = evaluateCountdown(win.resetAtMs, nowMs, modalSkew);
                const localClk = formatResetLocalTime(win.resetAtMs, nowMs + serverClockOffsetMs);
                const color = getBarColor(modalTool, win.remainingPercent);
                return (
                  <div key={win.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular">
                      <span className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
                        <span>{win.label}</span>
                        {renderAccuracyChip(win)}
                      </span>
                      <span className="text-[var(--ink-tertiary)]">
                        <span className="font-semibold" style={{ color }}>
                          {formatDisplayPercent(win.remainingPercent)} left
                        </span>
                        {' · '}
                        {cd.state === 'idle'
                          ? 'Ready · Window inactive'
                          : cd.state === 'refreshing'
                            ? 'Updating...'
                            : `Resets in ${cd.formattedDetailed}${localClk ? ` · ${localClk}` : ''}`}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-[width,background-color] duration-300"
                        style={{
                          width:
                            win.remainingPercent !== null
                              ? `${Math.max(0, Math.min(100, win.remainingPercent))}%`
                              : '0%',
                          backgroundColor: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="glass-subcard rounded-xl p-4 text-xs font-mono text-[var(--ink-secondary)] leading-relaxed">
              {PROVIDER_META[modalTool].awaitingHint}
            </div>
          )}

          {/* Source & Freshness Metadata + Collapsible Diagnostics */}
          <div className="pt-2 border-t border-[var(--border-hairline)] flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono text-[var(--ink-tertiary)]">
            <span>
              Source: {modalSnap.windows[0]?.source || 'none'} · Fetched{' '}
              {formatMinutesAgo(modalSnap.fetchedAtMs, nowMs + serverClockOffsetMs)}
            </span>
            <button
              type="button"
              onClick={() => {
                const next = !showDiagnostics;
                setShowDiagnostics(next);
                if (next) void loadDiagnostics(false);
              }}
              className="inline-flex items-center gap-1 text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <Bug className="w-3 h-3" />
              <span>Diagnostics</span>
              <ChevronDown
                className={`w-3 h-3 transition-transform ${showDiagnostics ? 'rotate-180' : ''}`}
              />
            </button>
          </div>

          {showDiagnostics && (
            <div className="glass-subcard rounded-xl p-3 space-y-2 text-[10.5px] font-mono">
              <div className="flex items-center justify-between">
                <span className="text-[var(--ink-secondary)] font-semibold">
                  Sanitized Quota Diagnostics
                </span>
                <button
                  type="button"
                  disabled={diagLoading}
                  onClick={() => void loadDiagnostics(true)}
                  className="text-[var(--accent-teal)] hover:underline cursor-pointer disabled:opacity-50"
                >
                  {diagLoading ? 'Refreshing...' : 'Force Re-collect'}
                </button>
              </div>
              <pre className="max-h-60 overflow-auto p-2.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[10px] text-[var(--ink-secondary)] whitespace-pre-wrap break-all">
                {diagEntries
                  ? JSON.stringify(
                      diagEntries.find((e) => e.provider === modalTool) ?? diagEntries,
                      null,
                      2
                    )
                  : diagLoading
                    ? 'Loading diagnostics...'
                    : 'Click Force Re-collect to inspect sanitized payload.'}
              </pre>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
