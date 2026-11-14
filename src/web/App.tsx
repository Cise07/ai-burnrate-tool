import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Cpu,
  Database,
  DollarSign,
  Download,
  FolderGit2,
  Layers,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  EUR_RATE,
  buildWorkspaceGroups,
  filterSessions,
  formatMoney,
  getSessionModelBreakdown,
  normalizeWorkspaceKey,
  sortWorkspaceGroups,
  workspacesToCsv,
  workspacesToJson,
  type Currency,
  type SortDirection,
  type TimeRange,
  type ToolFilter,
  type WorkspaceSortField,
} from '../core/analytics';
import type { BurnrateSnapshot, ModelRate, SessionStats, ToolSource } from '../core/types';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatRateMoney(usdAmount: number, currency: Currency): string {
  const val = currency === 'EUR' ? usdAmount * EUR_RATE : usdAmount;
  const sym = currency === 'EUR' ? '€' : '$';
  if (val === 0) return `${sym}0.00`;
  if (val < 1) {
    return `${sym}${val.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}`;
  }
  return `${sym}${val.toFixed(2)}`;
}

function findModelRate(
  normalizedModel: string | undefined,
  modelLabel: string,
  pricing: BurnrateSnapshot['pricing'] | undefined
): ModelRate | undefined {
  if (!pricing?.models) return undefined;
    return (
    (normalizedModel ? pricing.models[normalizedModel] : undefined) ||
    Object.values(pricing.models).find((r) => r.label === modelLabel)
  );
}

function ToolBadge({ source, compact = false }: { source: ToolSource; compact?: boolean }) {
  const pad = compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[10.5px]';
  if (source === 'antigravity') {
      return (
      <span
        className={`inline-flex items-center gap-1 ${pad} rounded-md font-mono font-medium bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 whitespace-nowrap`}
      >
        <Terminal className="w-3 h-3 shrink-0" />
        Antigravity
      </span>
    );
  }
    return (
    <span
      className={`inline-flex items-center gap-1 ${pad} rounded-md font-mono font-medium bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/25 whitespace-nowrap`}
    >
      <Sparkles className="w-3 h-3 shrink-0" />
      Claude Code
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return iso.slice(0, 10);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function formatPreciseDateTime(iso: string | undefined): { date: string; time: string } {
  if (!iso) return { date: '—', time: '—' };
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: iso.slice(0, 10), time: '' };
    const date = d.toLocaleDateString('it-IT', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return { date, time };
  } catch {
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }
}

function isPromoActive(rate: ModelRate | undefined, targetDate?: string | number): boolean {
  if (!rate || !rate.isPromo) return false;
  const now = targetDate ? new Date(targetDate).getTime() : Date.now();
  if (Number.isNaN(now)) return false;
  const start = rate.promoStart ? new Date(rate.promoStart).getTime() : null;
  const end = rate.promoEnd ? new Date(rate.promoEnd).getTime() : null;
  if (start !== null && !Number.isNaN(start) && now < start) return false;
  if (end !== null && !Number.isNaN(end) && now > end) return false;
  return true;
}

const MODEL_COLORS = ['#10b981', '#06b6d4', '#a855f7', '#ec4899', '#f59e0b', '#3b82f6'];

const SORT_OPTIONS: Array<{ value: WorkspaceSortField; label: string }> = [
  { value: 'lastActiveAt', label: 'Last Modified' },
  { value: 'startedAt', label: 'Created' },
  { value: 'totalTokens', label: 'Total Tokens' },
  { value: 'costUSD', label: 'API Cost' },
  { value: 'turns', label: 'Turns' },
  { value: 'ioTokens', label: 'Input / Output' },
  { value: 'cacheReadTokens', label: 'Cache Read' },
  { value: 'cacheSavingsUSD', label: 'Cache Saved' },
  { value: 'chats', label: 'Chats' },
  { value: 'workspaceName', label: 'Workspace' },
  { value: 'primaryModelLabel', label: 'Model' },
  { value: 'tool', label: 'Tool' },
];

const TEXT_SORT_FIELDS: ReadonlySet<WorkspaceSortField> = new Set([
  'workspaceName',
  'primaryModelLabel',
  'tool',
]);

function readUrlLaunchOverrides(): {
  currency?: Currency;
  toolFilter?: ToolFilter;
  timeRange?: TimeRange;
} {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const rawCur = params.get('currency')?.toUpperCase();
  const rawTool = params.get('tool')?.toLowerCase();
  const rawRange = params.get('range')?.toLowerCase();
  return {
    currency: rawCur === 'EUR' || rawCur === 'USD' ? rawCur : undefined,
    toolFilter:
      rawTool === 'all' || rawTool === 'antigravity' || rawTool === 'claude' ? rawTool : undefined,
    timeRange:
      rawRange === '24h' || rawRange === '7d' || rawRange === '30d' || rawRange === 'all'
        ? rawRange
        : undefined,
  };
}

export default function App() {
  const urlOverrides = useMemo(() => readUrlLaunchOverrides(), []);
  const userTouchedCurrencyRef = useRef<boolean>(false);
  const userTouchedToolRef = useRef<boolean>(false);
  const userTouchedRangeRef = useRef<boolean>(false);

  const [snapshot, setSnapshot] = useState<BurnrateSnapshot | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<string>('');
  const [lastChangedFile, setLastChangedFile] = useState<string | null>(null);
  const [isRescanning, setIsRescanning] = useState<boolean>(false);

  const [toolFilter, setToolFilter] = useState<ToolFilter>(urlOverrides.toolFilter || 'all');
  const [timeRange, setTimeRange] = useState<TimeRange>(urlOverrides.timeRange || 'all');
  const [currency, setCurrency] = useState<Currency>(() => {
    if (urlOverrides.currency) return urlOverrides.currency;
      return (localStorage.getItem('burnrate_currency') as Currency) === 'EUR' ? 'EUR' : 'USD';
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [tableModelFilter, setTableModelFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<WorkspaceSortField>('lastActiveAt');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [isModelUsageExpanded, setIsModelUsageExpanded] = useState<boolean>(() => {
    return localStorage.getItem('burnrate_models_expanded') === 'true';
  });

  const handleSortField = (field: WorkspaceSortField) => {
    if (sortBy === field) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDir(TEXT_SORT_FIELDS.has(field) ? 'asc' : 'desc');
    }
  };

  const resetAllFilters = () => {
    userTouchedToolRef.current = true;
    userTouchedRangeRef.current = true;
    setToolFilter('all');
    setTimeRange('all');
    setTableModelFilter('all');
    setSearchQuery('');
  };

  const toggleModelUsageExpanded = () => {
    setIsModelUsageExpanded((prev) => {
      const next = !prev;
      localStorage.setItem('burnrate_models_expanded', String(next));
      return next;
    });
  };

  const toggleSetKey = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleCurrency = (next: Currency) => {
    userTouchedCurrencyRef.current = true;
    setCurrency(next);
    localStorage.setItem('burnrate_currency', next);
  };
  const selectToolFilter = (next: ToolFilter) => {
    userTouchedToolRef.current = true;
    setToolFilter(next);
  };
  const selectTimeRange = (next: TimeRange) => {
    userTouchedRangeRef.current = true;
    setTimeRange(next);
  };
  const currencySymbol = currency === 'EUR' ? '€' : '$';
  const rateMultiplier = currency === 'EUR' ? EUR_RATE : 1;

  const toolGroupRef = useRef<HTMLDivElement | null>(null);
  const toolBtnRefs = useRef<Record<ToolFilter, HTMLButtonElement | null>>({
    all: null,
    antigravity: null,
    claude: null,
  });
  const [toolPill, setToolPill] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const updatePill = () => {
      const btn = toolBtnRefs.current[toolFilter];
      if (!btn) return;
      setToolPill({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
    };
    updatePill();

    const groupEl = toolGroupRef.current;
    if (!groupEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updatePill);
    ro.observe(groupEl);
      return () => ro.disconnect();
  }, [toolFilter, snapshot !== null]);

  useEffect(() => {
    // Apply CLI launch flags even if user refreshes manually without query string
    fetch('/api/defaults')
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          defaults: {
            currency?: Currency;
            toolFilter?: ToolFilter;
            timeRange?: TimeRange;
          } | null
        ) => {
          if (!defaults) return;
          if (!urlOverrides.currency && !userTouchedCurrencyRef.current && defaults.currency) {
            setCurrency(defaults.currency);
          }
          if (!urlOverrides.toolFilter && !userTouchedToolRef.current && defaults.toolFilter) {
            setToolFilter(defaults.toolFilter);
          }
          if (!urlOverrides.timeRange && !userTouchedRangeRef.current && defaults.timeRange) {
            setTimeRange(defaults.timeRange);
          }
        }
      )
      .catch(() => {});

    // Initial fetch fallback
    fetch('/api/stats')
      .then((res) => res.json())
      .then((data: BurnrateSnapshot) => {
        setSnapshot(data);
        setLastSyncTime(new Date().toLocaleTimeString());
      })
      .catch(() => {});

    // Real-Time Server-Sent Events connection
    const es = new EventSource('/api/events');

    es.onopen = () => {
      setSseConnected(true);
    };

    const handlePayload = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.snapshot) {
          setSnapshot(parsed.snapshot);
          setLastSyncTime(new Date().toLocaleTimeString());
          if (parsed.changedPath) {
            setLastChangedFile(parsed.changedPath);
          }
        }
      } catch {
        // ignore malformed event
      }
    };

    es.addEventListener('init', handlePayload);
    es.addEventListener('update', handlePayload);

    es.onerror = () => {
      setSseConnected(false);
    };

      return () => {
      es.close();
    };
  }, []);

  const triggerManualRescan = async () => {
    setIsRescanning(true);
    try {
      const res = await fetch('/api/rescan', { method: 'POST' });
      const data = await res.json();
      setSnapshot(data);
      setLastSyncTime(new Date().toLocaleTimeString());
    } finally {
      setTimeout(() => setIsRescanning(false), 300);
    }
  };

  // Global KPIs & charts scoped to topbar toolFilter and timeRange
  const analytics = useMemo(() => {
    if (!snapshot) return null;

    const filteredSessions: SessionStats[] = filterSessions(snapshot.sessions, {
      toolFilter,
      timeRange,
    });

    let totalCostUSD = 0;
    let totalCacheSavingsUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalTokens = 0;
    let totalTurns = 0;

    let antigravityCost = 0;
    let claudeCost = 0;

    const dailyMap = new Map<
      string,
      { date: string; antigravityUSD: number; claudeUSD: number; totalUSD: number; tokens: number }
    >();
    const modelMap = new Map<
      string,
      {
        model: string;
        normalizedModel?: string;
        costUSD: number;
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        turns: number;
        source: ToolSource;
        rate?: ModelRate;
      }
    >();
    const workspaceSet = new Set<string>();

    for (const session of filteredSessions) {
      totalCostUSD += session.costUSD;
      totalCacheSavingsUSD += session.cacheSavingsUSD;
      totalInputTokens += session.inputTokens;
      totalOutputTokens += session.outputTokens;
      totalCacheReadTokens += session.cacheReadTokens;
      totalCacheWriteTokens += session.cacheWriteTokens;
      totalTokens += session.totalTokens;
      totalTurns += session.turns;
      workspaceSet.add(normalizeWorkspaceKey(session.workspace));

      if (session.source === 'antigravity') {
        antigravityCost += session.costUSD;
      } else {
        claudeCost += session.costUSD;
      }

      for (const t of session.turnHistory) {
        const dayKey = (t.timestamp || session.lastActiveAt).slice(0, 10);
        const dayEntry = dailyMap.get(dayKey) || {
          date: dayKey,
          antigravityUSD: 0,
          claudeUSD: 0,
          totalUSD: 0,
          tokens: 0,
        };
        if (session.source === 'antigravity') {
          dayEntry.antigravityUSD += t.costUSD;
        } else {
          dayEntry.claudeUSD += t.costUSD;
        }
        dayEntry.totalUSD += t.costUSD;
        dayEntry.tokens += t.totalTokens;
        dailyMap.set(dayKey, dayEntry);

        let modEntry = modelMap.get(t.modelLabel);
        if (!modEntry) {
          const matchedRate =
            (t.normalizedModel ? snapshot.pricing?.models?.[t.normalizedModel] : undefined) ||
            Object.values(snapshot.pricing?.models || {}).find(
              (r) => r.label === t.modelLabel || r.label.toLowerCase() === t.model.toLowerCase()
            );
          modEntry = {
            model: t.modelLabel,
            normalizedModel: t.normalizedModel,
            costUSD: 0,
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            turns: 0,
            source: session.source,
            rate: matchedRate,
          };
          modelMap.set(t.modelLabel, modEntry);
        }
        modEntry.costUSD += t.costUSD;
        modEntry.tokens += t.totalTokens;
        modEntry.inputTokens += t.inputTokens;
        modEntry.outputTokens += t.outputTokens;
        modEntry.cacheReadTokens += t.cacheReadTokens;
        modEntry.turns += 1;
        if (!modEntry.rate && t.normalizedModel && snapshot.pricing?.models?.[t.normalizedModel]) {
          modEntry.rate = snapshot.pricing.models[t.normalizedModel];
        }
      }
    }

    const timelineData = Array.from(dailyMap.values())
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .map((d) => ({
        ...d,
        antigravityUSD: Number(d.antigravityUSD.toFixed(3)),
        claudeUSD: Number(d.claudeUSD.toFixed(3)),
        totalUSD: Number(d.totalUSD.toFixed(3)),
      }));

    const modelData = Array.from(modelMap.values())
      .sort((a, b) => b.costUSD - a.costUSD)
      .slice(0, 6)
      .map((m) => ({
        ...m,
        costUSD: Number(m.costUSD.toFixed(2)),
      }));

    const availableModels = Array.from(modelMap.values())
      .sort((a, b) => b.costUSD - a.costUSD)
      .map((m) => m.model);

    const promptPool = totalInputTokens + totalCacheReadTokens;
    const cacheHitRate = promptPool > 0 ? (totalCacheReadTokens / promptPool) * 100 : 0;

    const referenceSubUSD =
      toolFilter === 'all'
        ? snapshot.pricing.subscriptions.combinedMonthlyUSD
        : toolFilter === 'antigravity'
          ? snapshot.pricing.subscriptions.antigravity_pro.monthlyUSD
          : snapshot.pricing.subscriptions.claude_max.monthlyUSD;

    return {
      totalCostUSD,
      totalCacheSavingsUSD,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalTokens,
      totalTurns,
      antigravityCost,
      claudeCost,
      cacheHitRate,
      referenceSubUSD,
      workspacesCount: workspaceSet.size,
      timelineData,
      modelData,
      availableModels,
      filteredSessions,
      totalSessionsCount: filteredSessions.length,
    };
  }, [snapshot, toolFilter, timeRange]);

  const activeModelFilter =
    analytics && analytics.availableModels.includes(tableModelFilter) ? tableModelFilter : 'all';

  const tableData = useMemo(() => {
    if (!analytics) return { workspaces: [], chatsCount: 0 };
    const tableSessions = filterSessions(analytics.filteredSessions, {
      searchQuery,
      modelFilter: activeModelFilter,
    });
    const grouped = buildWorkspaceGroups(tableSessions);
    return {
      workspaces: sortWorkspaceGroups(grouped, sortBy, sortDir),
      chatsCount: tableSessions.length,
    };
  }, [analytics, searchQuery, activeModelFilter, sortBy, sortDir]);

  if (!snapshot || !analytics) {
      return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
          <p className="text-sm text-zinc-400 font-mono">Scanning ~/.gemini & ~/.claude logs...</p>
        </div>
      </div>
    );
  }

  const subPercentage =
    analytics.referenceSubUSD > 0 ? Math.min(100, (analytics.totalCostUSD / analytics.referenceSubUSD) * 100) : 0;
  const subMultiplier =
    analytics.referenceSubUSD > 0 ? (analytics.totalCostUSD / analytics.referenceSubUSD).toFixed(1) : '0.0';

  const hasActiveFilters =
    toolFilter !== 'all' ||
    timeRange !== 'all' ||
    activeModelFilter !== 'all' ||
    searchQuery.trim().length > 0;

  const exportReport = (format: 'csv' | 'json') => {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `burnrate-${toolFilter}-${timeRange}-${dateStamp}.${format}`;
    const content =
      format === 'csv'
        ? workspacesToCsv(tableData.workspaces, currency)
        : workspacesToJson(tableData.workspaces, currency, {
            toolFilter,
            timeRange,
            modelFilter: activeModelFilter,
            searchQuery,
            sortBy,
            sortDir,
          });
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const sortedModels = [...analytics.modelData].sort((a, b) => b.tokens - a.tokens);
  const canCollapseModels = sortedModels.length > 2;
  const topModels = canCollapseModels ? sortedModels.slice(0, 2) : sortedModels;
  const extraModels = canCollapseModels ? sortedModels.slice(2) : [];

  const renderModelCard = (m: (typeof analytics.modelData)[number], idx: number) => {
    const sharePct = analytics.totalTokens > 0 ? (m.tokens / analytics.totalTokens) * 100 : 0;
    const barColor = MODEL_COLORS[idx % MODEL_COLORS.length];
    const promoActive = Boolean(m.rate && isPromoActive(m.rate));
    const curInput = m.rate ? (promoActive ? m.rate.input : (m.rate.standardInput ?? m.rate.input)) : 0;
    const curCache = m.rate
      ? promoActive
        ? m.rate.cacheRead
        : (m.rate.standardCacheRead ?? m.rate.cacheRead)
      : 0;
    const curOutput = m.rate ? (promoActive ? m.rate.output : (m.rate.standardOutput ?? m.rate.output)) : 0;

      return (
      <div
        key={m.model}
        className="rounded-lg bg-zinc-950/70 border border-zinc-800/80 p-4 flex flex-col justify-between gap-3"
      >
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-100 truncate" title={m.model}>
              {m.model}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {promoActive && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1"
                  title={m.rate?.promoNote || 'Tariffa promozionale attiva'}
                >
                  <Sparkles className="w-2.5 h-2.5 text-amber-400" />
                  PROMO
                </span>
              )}
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                  m.source === 'antigravity'
                    ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                    : 'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20'
                }`}
              >
                {m.source === 'antigravity' ? 'AGY' : 'Claude'}
              </span>
            </div>
          </div>

          <div className="mt-2 flex items-baseline justify-between">
            <div>
              <span className="text-2xl font-bold font-mono text-white">
                {formatTokens(m.tokens)}
              </span>
              <span className="text-[11px] text-zinc-500 font-mono ml-1">tokens</span>
            </div>
            <span className="text-xs font-mono text-zinc-400">{sharePct.toFixed(1)}%</span>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-400">Total Spend:</span>
            <span className="font-semibold text-emerald-400">
              {formatMoney(m.costUSD, currency)}
            </span>
          </div>

          <div className="mt-2 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.max(4, sharePct)}%`,
                backgroundColor: barColor,
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-zinc-800/70 text-[11px] font-mono">
          <div>
            <span className="text-zinc-500 block">Input</span>
            <span className="text-zinc-200">{formatTokens(m.inputTokens)}</span>
          </div>
          <div>
            <span className="text-zinc-500 block">Cached</span>
            <span className="text-cyan-400">{formatTokens(m.cacheReadTokens)}</span>
          </div>
          <div>
            <span className="text-zinc-500 block">Output</span>
            <span className="text-amber-300">{formatTokens(m.outputTokens)}</span>
          </div>
        </div>

        {m.rate && (
          <div className="pt-2.5 border-t border-zinc-800/70 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-zinc-400">Tariffa per 1M tok:</span>
              {promoActive && (
                <span className="text-[10px] font-semibold text-amber-400 flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5 text-amber-400" />
                  In Promozione
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-1.5 bg-zinc-900/90 p-2 rounded border border-zinc-800/80 text-[10px] font-mono">
              <div>
                <span className="text-zinc-500 block text-[9px] uppercase tracking-wider">Input</span>
                <div className="flex items-baseline gap-1">
                  {promoActive && m.rate.standardInput && (
                    <span className="line-through text-zinc-600 text-[9px]">
                      {formatRateMoney(m.rate.standardInput, currency)}
                    </span>
                  )}
                  <span className="text-zinc-200 font-semibold">
                    {formatRateMoney(curInput, currency)}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-zinc-500 block text-[9px] uppercase tracking-wider">Cached</span>
                <span className="text-cyan-400 font-semibold">
                  {formatRateMoney(curCache, currency)}
                </span>
              </div>

              <div>
                <span className="text-zinc-500 block text-[9px] uppercase tracking-wider">Output</span>
                <div className="flex items-baseline gap-1">
                  {promoActive && m.rate.standardOutput && (
                    <span className="line-through text-zinc-600 text-[9px]">
                      {formatRateMoney(m.rate.standardOutput, currency)}
                    </span>
                  )}
                  <span className="text-amber-300 font-semibold">
                    {formatRateMoney(curOutput, currency)}
                  </span>
                </div>
              </div>
            </div>

            {promoActive && m.rate.promoNote && (
              <div className="text-[10px] text-amber-400/90 font-mono flex items-center gap-1">
                <span className="text-amber-400">●</span>
                <span className="truncate" title={m.rate.promoNote}>
                  {m.rate.promoNote}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const modelUsageHeaderContent = (
    <>
      <div className="flex items-start gap-2.5">
        {canCollapseModels && (
          <span className="mt-0.5 p-1 rounded group-hover:bg-zinc-800 text-zinc-500 group-hover:text-zinc-200 transition shrink-0">
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                isModelUsageExpanded ? 'rotate-90 text-emerald-400' : ''
              }`}
            />
          </span>
        )}
        <div>
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-emerald-400" />
            Total Token Usage by Model
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Complete token consumption breakdown (Input, Cache Read & Output) per AI model
          </p>
        </div>
      </div>
      <div className={`text-xs font-mono text-zinc-400 ${canCollapseModels ? 'pl-7 sm:pl-0' : ''}`}>
        Total: <span className="text-zinc-100 font-semibold">{formatTokens(analytics.totalTokens)}</span> tokens
      </div>
    </>
  );

  const renderSortTh = (
    label: string,
    field: WorkspaceSortField,
    align: 'left' | 'right' = 'right',
    className = 'py-2.5 px-2 xl:px-2.5'
  ) => {
    const isActive = sortBy === field;
    return (
      <th className={`${className} ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          type="button"
          onClick={() => handleSortField(field)}
          title={`Sort by ${label} (${isActive ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'click to sort'})`}
          className={`inline-flex items-center gap-1 uppercase font-mono transition-colors cursor-pointer select-none hover:text-zinc-100 ${
            align === 'right' ? 'justify-end ml-auto' : ''
          } ${isActive ? 'text-emerald-400' : 'text-zinc-400'}`}
        >
          <span>{label}</span>
          {isActive ? (
            sortDir === 'asc' ? (
              <ArrowUp className="w-3 h-3 shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 opacity-45 shrink-0" />
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Subtle top glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-emerald-500/[0.05] via-cyan-500/[0.02] to-transparent" />

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md animate-burn-header">
        <div className="max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] mx-auto px-3 sm:px-6 h-16 flex items-center justify-between gap-3 overflow-x-auto whitespace-nowrap">
          {/* Brand & Live Status */}
          <div className="flex items-center gap-2.5 shrink-0 group">
            <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner shrink-0 transition-all duration-200 group-hover:border-emerald-500/40 group-hover:shadow-[0_0_16px_-4px_rgba(16,185,129,0.45)]">
              <Zap className="w-4 h-4 text-emerald-400 transition-transform duration-200 group-hover:scale-110" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-zinc-100 text-sm sm:text-base transition-colors duration-200 group-hover:text-white">ai-burnrate</span>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 transition-colors duration-200">
                  <span className="relative flex h-2 w-2">
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                        sseConnected ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                    />
                    <span
                      className={`relative inline-flex rounded-full h-2 w-2 ${
                        sseConnected ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                    />
                  </span>
                  {sseConnected ? 'LIVE' : 'SYNC'}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 font-mono hidden xl:block transition-colors duration-200">
                Watching ~/.gemini & ~/.claude {lastSyncTime && `• Synced ${lastSyncTime}`}
              </p>
            </div>
          </div>

          {/* Controls: Tool Filter, Time Selector, Currency, Rescan */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {/* Tool Filter (with smooth sliding indicator) */}
            <div
              ref={toolGroupRef}
              className="relative inline-flex items-center gap-0.5 rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs shrink-0 select-none"
            >
              {toolPill.ready && (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-1 bottom-1 left-0 rounded-md border transition-[transform,width,background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${
                    toolFilter === 'antigravity'
                      ? 'bg-cyan-500/20 border-cyan-500/30'
                      : toolFilter === 'claude'
                        ? 'bg-fuchsia-500/20 border-fuchsia-500/30'
                        : 'bg-zinc-800 border-zinc-700/70 shadow-sm'
                  }`}
                  style={{
                    width: `${toolPill.width}px`,
                    transform: `translateX(${toolPill.left}px)`,
                  }}
                />
              )}
              <button
                ref={(el) => {
                  toolBtnRefs.current.all = el;
                }}
                type="button"
                onClick={() => selectToolFilter('all')}
                className={`relative z-10 px-2 sm:px-2.5 py-1 rounded-md font-medium border border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/50 ${
                  toolFilter === 'all' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All
              </button>
              <button
                ref={(el) => {
                  toolBtnRefs.current.antigravity = el;
                }}
                type="button"
                onClick={() => selectToolFilter('antigravity')}
                className={`relative z-10 px-2 sm:px-2.5 py-1 rounded-md font-medium border border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50 flex items-center gap-1.5 ${
                  toolFilter === 'antigravity' ? 'text-cyan-300' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0" />
                <span>Antigravity</span>
              </button>
              <button
                ref={(el) => {
                  toolBtnRefs.current.claude = el;
                }}
                type="button"
                onClick={() => selectToolFilter('claude')}
                className={`relative z-10 px-2 sm:px-2.5 py-1 rounded-md font-medium border border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-fuchsia-500/50 flex items-center gap-1.5 ${
                  toolFilter === 'claude' ? 'text-fuchsia-300' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 shrink-0" />
                <span>Claude</span>
              </button>
            </div>

            {/* Time Range Selector (with smooth sliding indicator) */}
            <div className="relative inline-grid grid-cols-4 rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs font-mono shrink-0 select-none">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/4)] rounded-md bg-emerald-500/20 border border-emerald-500/30 transition-transform duration-200 ease-out motion-reduce:transition-none"
                style={{
                  transform: `translateX(${(['24h', '7d', '30d', 'all'] as TimeRange[]).indexOf(timeRange) * 100}%)`,
                }}
              />
              {(['24h', '7d', '30d', 'all'] as TimeRange[]).map((range) => (
                <button
                  type="button"
                  key={range}
                  onClick={() => selectTimeRange(range)}
                  className={`relative z-10 px-2 sm:px-2.5 py-1 rounded-md uppercase font-medium text-center transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/50 ${
                    timeRange === range
                      ? 'text-emerald-300'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>

            {/* Currency Toggle ($ USD / € EUR with smooth sliding indicator) */}
            <div className="relative inline-grid grid-cols-2 rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs font-mono shrink-0 select-none">
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/2)] rounded-md bg-emerald-500/20 border border-emerald-500/30 transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  currency === 'EUR' ? 'translate-x-full' : 'translate-x-0'
                }`}
              />
              <button
                type="button"
                onClick={() => toggleCurrency('USD')}
                className={`relative z-10 px-2 py-1 min-w-[56px] text-center rounded-md font-medium transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/50 ${
                  currency === 'USD'
                    ? 'text-emerald-300'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                $ USD
              </button>
              <button
                type="button"
                onClick={() => toggleCurrency('EUR')}
                className={`relative z-10 px-2 py-1 min-w-[56px] text-center rounded-md font-medium transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/50 ${
                  currency === 'EUR'
                    ? 'text-emerald-300'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                € EUR
              </button>
            </div>

            {/* Manual Rescan */}
            <button
              type="button"
              onClick={triggerManualRescan}
              title="Force Rescan Logs"
              className="group p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/40 text-zinc-300 hover:text-emerald-300 transition-colors duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/50 select-none shrink-0"
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  isRescanning
                    ? 'animate-spin text-emerald-400'
                    : 'transition-transform duration-300 group-hover:rotate-90 motion-reduce:transition-none'
                }`}
              />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Live Event Banner if a file just updated */}
        {lastChangedFile && (
          <div className="rounded-lg bg-emerald-950/30 border border-emerald-500/30 px-3.5 py-2 flex items-center justify-between text-xs font-mono text-emerald-300 animate-burn-expand">
            <span className="truncate">
              ● Live update received from: <span className="text-emerald-200">{lastChangedFile}</span>
            </span>
            <button
              onClick={() => setLastChangedFile(null)}
              className="text-emerald-400/70 hover:text-emerald-300 ml-4 transition-colors"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* 4 KPI Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-burn-fade-up">
          {/* Card 1: Estimated API Spend & Subscription Comparison */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between relative overflow-hidden transition-colors duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/75">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                API Equivalent Spend
              </span>
              <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>

            <div className="my-3">
              <div className="text-3xl font-bold font-mono tracking-tight text-white">
                {formatMoney(analytics.totalCostUSD, currency)}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                <span className="text-cyan-400 font-mono">
                  AGY: {formatMoney(analytics.antigravityCost, currency)}
                </span>
                <span>•</span>
                <span className="text-fuchsia-400 font-mono">
                  Claude: {formatMoney(analytics.claudeCost, currency)}
                </span>
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-zinc-800/80">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">
                  vs {formatMoney(analytics.referenceSubUSD, currency)}/mo Plan
                </span>
                <span className="font-mono font-semibold text-emerald-400">{subMultiplier}x value</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-500"
                  style={{ width: `${Math.max(4, subPercentage)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Card 2: Total Tokens */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between transition-colors duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/75">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Total Tokens
              </span>
              <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                <Cpu className="w-4 h-4" />
              </div>
            </div>

            <div className="my-3">
              <div className="text-3xl font-bold font-mono tracking-tight text-white">
                {formatTokens(analytics.totalTokens)}
              </div>
              <div className="mt-1 text-xs text-zinc-400 font-mono">
                Across {analytics.totalTurns.toLocaleString()} LLM turns
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-800/80 text-[11px] font-mono">
              <div>
                <span className="text-zinc-500 block">Input</span>
                <span className="text-zinc-200 font-medium">{formatTokens(analytics.totalInputTokens)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Output</span>
                <span className="text-zinc-200 font-medium">{formatTokens(analytics.totalOutputTokens)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Cached</span>
                <span className="text-cyan-400 font-medium">{formatTokens(analytics.totalCacheReadTokens)}</span>
              </div>
            </div>
          </div>

          {/* Card 3: Prompt Cache Savings */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between transition-colors duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/75">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Cache Savings
              </span>
              <div className="p-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-400">
                <Sparkles className="w-4 h-4" />
              </div>
            </div>

            <div className="my-3">
              <div className="text-3xl font-bold font-mono tracking-tight text-fuchsia-400">
                {formatMoney(analytics.totalCacheSavingsUSD, currency)}
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Saved via context caching
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-zinc-800/80">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Cache Hit Ratio</span>
                <span className="font-mono font-semibold text-fuchsia-300">
                  {analytics.cacheHitRate.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-purple-400 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(3, analytics.cacheHitRate))}%` }}
                />
              </div>
            </div>
          </div>

          {/* Card 4: Active Sessions & Workspaces */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between transition-colors duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/75">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Sessions & Projects
              </span>
              <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Layers className="w-4 h-4" />
              </div>
            </div>

            <div className="my-3">
              <div className="text-3xl font-bold font-mono tracking-tight text-white">
                {analytics.totalSessionsCount}
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Active in {analytics.workspacesCount} distinct workspaces
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-xs font-mono">
              <span className="text-zinc-400">Avg Cost / Session</span>
              <span className="text-amber-300 font-semibold">
                {formatMoney(
                  analytics.totalSessionsCount > 0
                    ? analytics.totalCostUSD / analytics.totalSessionsCount
                    : 0,
                  currency
                )}
              </span>
            </div>
          </div>
        </section>

        {/* Charts Row */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-burn-fade-up" style={{ animationDelay: '50ms' }}>
          {/* Daily Burn Rate Timeline (2 cols) */}
          <div className="lg:col-span-2 rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col transition-colors duration-200 hover:border-zinc-700/80">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  Daily API Burn Rate ({currency})
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Equivalent API spend over time across Antigravity CLI and Claude Code
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono">
                <span className="flex items-center gap-1.5 text-cyan-300">
                  <span className="h-2 w-2 rounded-full bg-cyan-400" /> Antigravity
                </span>
                <span className="flex items-center gap-1.5 text-fuchsia-300">
                  <span className="h-2 w-2 rounded-full bg-fuchsia-400" /> Claude Code
                </span>
              </div>
            </div>

            <div className="h-64 w-full">
              {analytics.timelineData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
                  No activity recorded for this filter window.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.timelineData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorAgy" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                      </linearGradient>
                      <linearGradient id="colorClaude" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#d946ef" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#d946ef" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="#71717a"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${currencySymbol}${(Number(v) * rateMultiplier).toFixed(0)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#09090b',
                        borderColor: '#27272a',
                        borderRadius: '0.5rem',
                        fontSize: '12px',
                        fontFamily: 'JetBrains Mono, monospace',
                        color: '#f4f4f5',
                      }}
                      labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: '2px' }}
                      formatter={(val: number, name: string) => [
                        formatMoney(Number(val), currency),
                        name === 'antigravityUSD' ? 'Antigravity CLI' : 'Claude Code',
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="antigravityUSD"
                      stackId="1"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#colorAgy)"
                    />
                    <Area
                      type="monotone"
                      dataKey="claudeUSD"
                      stackId="1"
                      stroke="#d946ef"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#colorClaude)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Model Spend Breakdown (1 col) */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col transition-colors duration-200 hover:border-zinc-700/80">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Database className="w-4 h-4 text-cyan-400" />
                Cost by Model ({currency})
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Distribution across Gemini & Claude models
              </p>
            </div>

            <div className="h-64 w-full">
              {analytics.modelData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
                  No model usage data available.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analytics.modelData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                    <XAxis
                      type="number"
                      stroke="#71717a"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${currencySymbol}${(Number(v) * rateMultiplier).toFixed(0)}`}
                    />
                    <YAxis
                      type="category"
                      dataKey="model"
                      stroke="#a1a1aa"
                      fontSize={11}
                      width={115}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: '#18181b' }}
                      contentStyle={{
                        backgroundColor: '#09090b',
                        borderColor: '#27272a',
                        borderRadius: '0.5rem',
                        fontSize: '12px',
                        fontFamily: 'JetBrains Mono, monospace',
                        color: '#f4f4f5',
                      }}
                      labelStyle={{ color: '#f4f4f5', fontWeight: 600, marginBottom: '2px' }}
                      itemStyle={{ color: '#34d399' }}
                      formatter={(val: number) => [formatMoney(Number(val), currency), 'API Spend']}
                    />
                    <Bar dataKey="costUSD" radius={[0, 6, 6, 0]} barSize={20}>
                      {analytics.modelData.map((_, idx) => (
                        <Cell key={idx} fill={MODEL_COLORS[idx % MODEL_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </section>

        {/* Central Widget: Total Token Usage per Model */}
        <section
          className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 overflow-hidden animate-burn-fade-up transition-colors duration-200 hover:border-zinc-700/80"
          style={{ animationDelay: '90ms' }}
        >
          {canCollapseModels ? (
            <button
              type="button"
              onClick={toggleModelUsageExpanded}
              aria-expanded={isModelUsageExpanded}
              title={isModelUsageExpanded ? 'Collapse extra models' : `Show all ${sortedModels.length} models`}
              className={`w-full px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-left hover:bg-zinc-800/30 transition-colors cursor-pointer select-none group ${
                isModelUsageExpanded ? 'bg-zinc-900/40' : ''
              }`}
            >
              {modelUsageHeaderContent}
            </button>
          ) : (
            <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              {modelUsageHeaderContent}
            </div>
          )}

          <div className="px-5 pb-5 pt-4 border-t border-zinc-800/70">
            {sortedModels.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500 font-mono">
                No model token data available.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {topModels.map((m, idx) => renderModelCard(m, idx))}
                </div>

                {canCollapseModels && (
                  <>
                    <div
                      aria-hidden={isModelUsageExpanded}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isModelUsageExpanded
                          ? 'grid-rows-[0fr] opacity-0 pointer-events-none'
                          : 'grid-rows-[1fr] opacity-100'
                      }`}
                    >
                      <div className="overflow-hidden min-h-0">
                        <button
                          type="button"
                          onClick={toggleModelUsageExpanded}
                          className="mt-3 w-full py-2 px-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 hover:bg-zinc-800/40 hover:border-zinc-700 text-xs font-mono text-zinc-400 hover:text-zinc-200 flex items-center justify-center gap-2 transition-colors cursor-pointer select-none"
                        >
                          <span>
                            +{extraModels.length} more {extraModels.length === 1 ? 'model' : 'models'} collapsed · Click to view all {sortedModels.length}
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                        </button>
                      </div>
                    </div>

                    <div
                      aria-hidden={!isModelUsageExpanded}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isModelUsageExpanded
                          ? 'grid-rows-[1fr] opacity-100'
                          : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                      }`}
                    >
                      <div className="overflow-hidden min-h-0">
                        <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          {extraModels.map((m, idx) => renderModelCard(m, idx + 2))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* Live Sessions / Workspaces Table */}
        <section className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 overflow-hidden animate-burn-fade-up" style={{ animationDelay: '130ms' }}>
          <div className="p-4 sm:p-5 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                Live Sessions & Workspaces
              </h2>
              <div className="text-xs text-zinc-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                <span>
                  Real-time telemetry grouped by workspace ({tableData.workspaces.length} workspaces · {tableData.chatsCount} chats)
                </span>
                {hasActiveFilters && (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">
                      filtered
                    </span>
                    <button
                      type="button"
                      onClick={resetAllFilters}
                      className="text-[10px] font-mono text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
                    >
                      Reset filters
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Search, Model Filter, Sort & Export */}
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 min-w-[180px] sm:w-56">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter workspace, chat, model..."
                  className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50 font-mono"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <select
                value={activeModelFilter}
                onChange={(e) => setTableModelFilter(e.target.value)}
                aria-label="Filter by model"
                title="Filter workspaces and chats by model"
                className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-emerald-500/50 max-w-[170px] cursor-pointer"
              >
                <option value="all">All models</option>
                {analytics.availableModels.map((modelName) => (
                  <option key={modelName} value={modelName}>
                    {modelName}
                  </option>
                ))}
              </select>

              <div className="flex items-center shrink-0">
                <select
                  value={sortBy}
                  onChange={(e) => {
                    const nextField = e.target.value as WorkspaceSortField;
                    setSortBy(nextField);
                    setSortDir(TEXT_SORT_FIELDS.has(nextField) ? 'asc' : 'desc');
                  }}
                  aria-label="Sort workspaces by"
                  title="Sort workspaces and chats"
                  className="px-2.5 py-1.5 rounded-l-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-emerald-500/50 cursor-pointer"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      Sort: {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                  aria-label={`Sort direction ${sortDir === 'desc' ? 'descending' : 'ascending'}`}
                  title={sortDir === 'desc' ? 'Descending (click for ascending)' : 'Ascending (click for descending)'}
                  className="px-2 py-1.5 rounded-r-lg bg-zinc-950 border border-l-0 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/80 text-xs font-mono text-emerald-400 flex items-center gap-1 transition-colors cursor-pointer select-none"
                >
                  {sortDir === 'asc' ? (
                    <ArrowUp className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {(['csv', 'json'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    disabled={tableData.workspaces.length === 0}
                    onClick={() => exportReport(fmt)}
                    title={`Export ${hasActiveFilters ? 'filtered & sorted' : 'sorted'} report (${tableData.workspaces.length} workspaces, ${currency}) as ${fmt.toUpperCase()}`}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/80 text-xs font-mono text-zinc-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{fmt.toUpperCase()}</span>
                    {hasActiveFilters && (
                      <span className="text-[10px] text-emerald-400">
                        ({tableData.workspaces.length})
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[1020px] xl:min-w-0">
              <thead>
                <tr className="border-b border-zinc-800/80 text-[10px] xl:text-[11px] font-mono uppercase text-zinc-400 bg-zinc-950/40">
                  <th className="py-2.5 px-2 w-7 sm:w-8 text-center"></th>
                  {renderSortTh('Tool', 'tool', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Workspace Folder', 'workspaceName', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Primary Model', 'primaryModelLabel', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Turns', 'turns', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Input / Output', 'ioTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Cache Read', 'cacheReadTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Total Tokens', 'totalTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Cache Saved', 'cacheSavingsUSD', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('API Cost', 'costUSD', 'right', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Created', 'startedAt', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Last Modified', 'lastActiveAt', 'right', 'py-2.5 px-2 xl:px-3')}
                </tr>
              </thead>
              {tableData.workspaces.slice(0, 60).map((ws) => {
                const isExpanded = expandedWorkspaces.has(ws.workspaceKey);

                  return (
                  <tbody
                    key={ws.workspaceKey}
                    className="text-xs border-b border-zinc-800/60 last:border-b-0"
                  >
                    <tr
                      onClick={() => toggleSetKey(setExpandedWorkspaces, ws.workspaceKey)}
                      className={`hover:bg-zinc-800/30 transition-colors group cursor-pointer ${
                        isExpanded ? 'bg-zinc-900/40' : ''
                      }`}
                    >
                      <td className="py-2 px-2 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSetKey(setExpandedWorkspaces, ws.workspaceKey);
                          }}
                          className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition select-none"
                          title={isExpanded ? 'Collapse workspace chats' : 'Expand workspace chats'}
                        >
                          <ChevronRight
                            className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                              isExpanded ? 'rotate-90 text-emerald-400' : ''
                            }`}
                          />
                        </button>
                      </td>

                      <td className="py-2 px-2 xl:px-3 whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1">
                          {ws.sources.map((src) => (
                            <ToolBadge key={src} source={src} compact={ws.sources.length > 1} />
                          ))}
                        </div>
                      </td>

                      <td className="py-2 px-2 xl:px-3">
                        <div className="flex items-center gap-1.5 font-medium text-zinc-200">
                          <FolderGit2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          <span
                            className="truncate max-w-[120px] sm:max-w-[150px] lg:max-w-[180px] xl:max-w-[220px]"
                            title={ws.workspace}
                          >
                            {ws.workspaceName}
                          </span>
                        </div>
                        <div className="text-[10.5px] text-zinc-400 font-mono flex items-center gap-1.5 mt-0.5">
                          <span>
                            {ws.chats.length} {ws.chats.length === 1 ? 'chat' : 'chats'}
                          </span>
                          <span className="text-zinc-600 hidden xl:inline truncate max-w-[160px]" title={ws.workspace}>
                            · {ws.workspace}
                          </span>
                        </div>
                      </td>

                      <td className="py-2 px-2 xl:px-3 whitespace-nowrap font-mono text-[11px] xl:text-xs text-zinc-300">
                        <div className="inline-flex items-center gap-1.5">
                          <span>{ws.primaryModelLabel}</span>
                          {ws.distinctModels.length > 1 && (
                            <span
                              className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/80 text-[10px]"
                              title={ws.distinctModels.join(', ')}
                            >
                              +{ws.distinctModels.length - 1}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-zinc-300 text-[11px] xl:text-xs">
                        {ws.turns}
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-zinc-400 text-[11px] xl:text-xs">
                        <span className="text-zinc-200">{formatTokens(ws.inputTokens)}</span>
                        <span className="text-zinc-600 mx-0.5">/</span>
                        <span className="text-zinc-300">{formatTokens(ws.outputTokens)}</span>
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-cyan-400 text-[11px] xl:text-xs">
                        {formatTokens(ws.cacheReadTokens)}
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono font-medium text-zinc-200 text-[11px] xl:text-xs">
                        {formatTokens(ws.totalTokens)}
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-fuchsia-400 text-[11px] xl:text-xs">
                        {formatMoney(ws.cacheSavingsUSD, currency)}
                      </td>

                      <td className="py-2 px-2 xl:px-3 whitespace-nowrap text-right font-mono font-semibold text-emerald-400 text-[11px] xl:text-xs">
                        {formatMoney(ws.costUSD, currency)}
                      </td>

                      <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-[11px] xl:text-xs">
                        <div className="text-zinc-200">{formatPreciseDateTime(ws.startedAt).date}</div>
                        <div className="text-[10px] text-zinc-500">{formatPreciseDateTime(ws.startedAt).time}</div>
                      </td>

                      <td className="py-2 px-2 xl:px-3 whitespace-nowrap text-right font-mono text-[11px] xl:text-xs">
                        <div className="text-zinc-200">{formatPreciseDateTime(ws.lastActiveAt).date}</div>
                        <div
                          className="text-[10px] text-emerald-400/90 flex items-center justify-end gap-1"
                          title={formatRelativeTime(ws.lastActiveAt)}
                        >
                          <span>{formatPreciseDateTime(ws.lastActiveAt).time}</span>
                          <span className="text-zinc-500 hidden xl:inline">
                            ({formatRelativeTime(ws.lastActiveAt)})
                          </span>
                        </div>
                      </td>
                    </tr>

                    <tr
                      aria-hidden={!isExpanded}
                      className={
                        isExpanded
                          ? 'bg-zinc-950/80 border-t border-zinc-800/60'
                          : 'pointer-events-none'
                      }
                    >
                      <td
                        colSpan={12}
                        className={`transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
                          isExpanded ? 'px-3 py-3 sm:px-4 sm:py-3.5' : 'p-0 text-[0px] leading-[0]'
                        }`}
                      >
                        <div
                          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                          }`}
                        >
                          <div className="overflow-hidden min-h-0 text-xs leading-normal">
                            <div className="rounded-lg bg-zinc-900/60 border border-zinc-800/90 p-3 sm:p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-zinc-200 flex items-center gap-2">
                                    <MessageSquare className="w-4 h-4 text-emerald-400" />
                                    Workspace Chats ({ws.chats.length})
                                  </span>
                                  <span className="text-[11px] font-mono text-zinc-500">{ws.workspace}</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400">
                                  <span>
                                    Creato:{' '}
                                    <span className="text-zinc-200">
                                      {formatPreciseDateTime(ws.startedAt).date}{' '}
                                      {formatPreciseDateTime(ws.startedAt).time}
                                    </span>
                                  </span>
                                  <span>•</span>
                                  <span>
                                    Ultima modifica:{' '}
                                    <span className="text-emerald-400">
                                      {formatPreciseDateTime(ws.lastActiveAt).date}{' '}
                                      {formatPreciseDateTime(ws.lastActiveAt).time}
                                    </span>
                                  </span>
                                </div>
                              </div>

                              <div className="space-y-2.5">
                                {ws.chats.map((chat) => {
                                  const chatKey = `${chat.source}-${chat.filePath}`;
                                  const isChatExpanded = expandedChats.has(chatKey);
                                  const chatModels = getSessionModelBreakdown(chat.turnHistory);
                                  const created = formatPreciseDateTime(chat.startedAt);
                                  const modified = formatPreciseDateTime(chat.lastActiveAt);

                                    return (
                                    <div
                                      key={chatKey}
                                      className="rounded-lg bg-zinc-950/75 border border-zinc-800/80 overflow-hidden transition-colors duration-150 hover:border-zinc-700/80"
                                    >
                                      <div
                                        onClick={() => toggleSetKey(setExpandedChats, chatKey)}
                                        className="p-3 hover:bg-zinc-900/50 transition-colors cursor-pointer space-y-2"
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleSetKey(setExpandedChats, chatKey);
                                              }}
                                              className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition shrink-0 select-none"
                                              title={
                                                isChatExpanded
                                                  ? 'Hide detailed model metrics'
                                                  : 'Show detailed model metrics'
                                              }
                                            >
                                              <ChevronRight
                                                className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                                                  isChatExpanded ? 'rotate-90 text-emerald-400' : ''
                                                }`}
                                              />
                                            </button>

                                            <ToolBadge source={chat.source} compact />

                                            <span
                                              className="text-xs font-medium text-zinc-100 truncate max-w-[240px] sm:max-w-[380px] lg:max-w-[480px]"
                                              title={`${chat.sessionTitle || chat.sessionId} (${chat.sessionId})`}
                                            >
                                              {chat.sessionTitle || chat.sessionId}
                                            </span>

                                            <span className="text-[10.5px] font-mono text-zinc-500">
                                              {created.date} {created.time} →{' '}
                                              <span className="text-emerald-400/90">
                                                {modified.date} {modified.time}
                                              </span>{' '}
                                              <span>({formatRelativeTime(chat.lastActiveAt)})</span>
                                            </span>
                                          </div>

                                          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
                                            <span className="text-zinc-400">
                                              Turns <strong className="text-zinc-200">{chat.turns}</strong>
                                            </span>
                                            <span className="text-zinc-400">
                                              In/Out{' '}
                                              <span className="text-zinc-200">{formatTokens(chat.inputTokens)}</span>
                                              <span className="text-zinc-600 mx-0.5">/</span>
                                              <span className="text-zinc-300">{formatTokens(chat.outputTokens)}</span>
                                            </span>
                                            <span className="text-cyan-400">
                                              Cache {formatTokens(chat.cacheReadTokens)}
                                            </span>
                                            <span className="text-zinc-200">
                                              Total {formatTokens(chat.totalTokens)}
                                            </span>
                                            <span className="text-fuchsia-400">
                                              Saved {formatMoney(chat.cacheSavingsUSD, currency)}
                                            </span>
                                            <span className="text-emerald-400 font-semibold">
                                              {formatMoney(chat.costUSD, currency)}
                                            </span>
                                          </div>
                                        </div>

                                        {/* Models used in this chat (always visible per chat) */}
                                        <div className="flex flex-wrap items-center gap-1.5 pl-6">
                                          <span className="inline-flex items-center gap-1 text-[10.5px] font-mono text-zinc-400 mr-1">
                                            <Cpu className="w-3 h-3 text-emerald-400" />
                                            Models ({chatModels.length}):
                                          </span>
                                          {chatModels.map((m) => {
                                            const costShare =
                                              chat.costUSD > 0 ? (m.costUSD / chat.costUSD) * 100 : 0;
                                            const modelRate = findModelRate(
                                              m.normalizedModel,
                                              m.modelLabel,
                                              snapshot?.pricing
                                            );
                                              return (
                                              <span
                                                key={m.modelLabel}
                                                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[10.5px] font-mono text-zinc-300"
                                                title={`Input: ${formatTokens(m.inputTokens)} · Cache Read: ${formatTokens(m.cacheReadTokens)} · Output: ${formatTokens(m.outputTokens)} · Saved: ${formatMoney(m.cacheSavingsUSD, currency)}`}
                                              >
                                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                                                <span className="text-zinc-200 font-medium">{m.modelLabel}</span>
                                                {isPromoActive(modelRate) && (
                                                  <span
                                                    className="px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                                    title={modelRate?.promoNote || 'Tariffa promozionale attiva'}
                                                  >
                                                    PROMO
                                                  </span>
                                                )}
                                                <span className="text-zinc-500">· {m.turns}t</span>
                                                <span className="text-zinc-400">· {formatTokens(m.totalTokens)}</span>
                                                <span className="text-emerald-400 font-semibold">
                                                  · {formatMoney(m.costUSD, currency)}
                                                </span>
                                                <span className="text-zinc-500">({costShare.toFixed(0)}%)</span>
                                              </span>
                                            );
                                          })}
                                        </div>
                                      </div>

                                      <div
                                        aria-hidden={!isChatExpanded}
                                        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                                          isChatExpanded
                                            ? 'grid-rows-[1fr] opacity-100'
                                            : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                                        }`}
                                      >
                                        <div className="overflow-hidden min-h-0">
                                          <div className="border-t border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5 overflow-x-auto">
                                            <table className="w-full text-left border-collapse text-xs min-w-[620px] lg:min-w-0">
                                              <thead>
                                                <tr className="border-b border-zinc-800/80 text-[10px] font-mono uppercase text-zinc-400">
                                                  <th className="py-1.5 px-2">Model</th>
                                                  <th className="py-1.5 px-2 text-right">Turns</th>
                                                  <th className="py-1.5 px-2 text-right">Input</th>
                                                  <th className="py-1.5 px-2 text-right">Cache Read</th>
                                                  <th className="py-1.5 px-2 text-right">Output</th>
                                                  <th className="py-1.5 px-2 text-right">Total Tokens</th>
                                                  <th className="py-1.5 px-2 text-right">Cache Saved</th>
                                                  <th className="py-1.5 px-2 text-right">API Cost</th>
                                                  <th className="py-1.5 px-2 text-right">Cost Share</th>
                                                </tr>
                                              </thead>
                                              <tbody className="divide-y divide-zinc-800/50">
                                                {chatModels.map((m) => {
                                                  const costShare =
                                                    chat.costUSD > 0 ? (m.costUSD / chat.costUSD) * 100 : 0;
                                                  const modelRate = findModelRate(
                                                    m.normalizedModel,
                                                    m.modelLabel,
                                                    snapshot?.pricing
                                                  );
                                                    return (
                                                    <tr key={m.modelLabel} className="hover:bg-zinc-800/20">
                                                      <td className="py-1.5 px-2 font-mono font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                                                        <span>{m.modelLabel}</span>
                                                        {isPromoActive(modelRate) && (
                                                          <span
                                                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                                            title={
                                                              modelRate?.promoNote || 'Tariffa promozionale attiva'
                                                            }
                                                          >
                                                            PROMO
                                                          </span>
                                                        )}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-zinc-300 text-[11px]">
                                                        {m.turns}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-zinc-400 text-[11px]">
                                                        {formatTokens(m.inputTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-cyan-400 text-[11px]">
                                                        {formatTokens(m.cacheReadTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-zinc-300 text-[11px]">
                                                        {formatTokens(m.outputTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-zinc-200 font-medium text-[11px]">
                                                        {formatTokens(m.totalTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-fuchsia-400 text-[11px]">
                                                        {formatMoney(m.cacheSavingsUSD, currency)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-400 text-[11px]">
                                                        {formatMoney(m.costUSD, currency)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-zinc-400 text-[11px]">
                                                        {costShare.toFixed(1)}%
                                                      </td>
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                );
              })}

              {tableData.workspaces.length === 0 && (
                <tbody className="text-xs">
                  <tr>
                    <td colSpan={12} className="py-10 text-center text-zinc-500 font-mono">
                      No matching workspaces or chats found.
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
