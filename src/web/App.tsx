import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  DollarSign,
  FolderGit2,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  TrendingUp,
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
import type { BurnrateSnapshot, ModelRate, SessionStats, ToolSource } from '../core/types';

type ToolFilter = 'all' | ToolSource;
type TimeRange = '24h' | '7d' | '30d' | 'all';
type Currency = 'USD' | 'EUR';

const EUR_RATE = 0.92;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatMoney(usdAmount: number, currency: Currency): string {
  const val = currency === 'EUR' ? usdAmount * EUR_RATE : usdAmount;
  const sym = currency === 'EUR' ? '€' : '$';
  if (val > 0 && val < 0.01) return `<${sym}0.01`;
  return `${sym}${val.toFixed(2)}`;
}

interface SessionModelItem {
  modelLabel: string;
  normalizedModel: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

function getSessionModelBreakdown(turnHistory: UsageTurn[]): SessionModelItem[] {
  const map = new Map<string, SessionModelItem>();
  for (const t of turnHistory) {
    const key = t.modelLabel || t.normalizedModel || 'Unknown';
    const entry = map.get(key) || {
      modelLabel: key,
      normalizedModel: t.normalizedModel,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      cacheSavingsUSD: 0,
    };
    entry.turns += 1;
    entry.inputTokens += t.inputTokens;
    entry.outputTokens += t.outputTokens;
    entry.cacheReadTokens += t.cacheReadTokens;
    entry.totalTokens += t.totalTokens;
    entry.costUSD += t.costUSD;
    entry.cacheSavingsUSD += t.cacheSavingsUSD;
    map.set(key, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.costUSD - a.costUSD);
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

export default function App() {
  const [snapshot, setSnapshot] = useState<BurnrateSnapshot | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<string>('');
  const [lastChangedFile, setLastChangedFile] = useState<string | null>(null);
  const [isRescanning, setIsRescanning] = useState<boolean>(false);

  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [currency, setCurrency] = useState<Currency>(() => {
    return (localStorage.getItem('burnrate_currency') as Currency) === 'EUR' ? 'EUR' : 'USD';
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const toggleExpandSession = (key: string) => {
    setExpandedSessions((prev) => {
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
    setCurrency(next);
    localStorage.setItem('burnrate_currency', next);
  };
  const currencySymbol = currency === 'EUR' ? '€' : '$';
  const rateMultiplier = currency === 'EUR' ? EUR_RATE : 1;

  useEffect(() => {
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

  // Filtered sessions & turns based on toolFilter and timeRange
  const analytics = useMemo(() => {
    if (!snapshot) return null;

    const now = Date.now();
    const cutoffMs =
      timeRange === '24h'
        ? now - 24 * 3600 * 1000
        : timeRange === '7d'
          ? now - 7 * 24 * 3600 * 1000
          : timeRange === '30d'
            ? now - 30 * 24 * 3600 * 1000
            : 0;

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
    const filteredSessions: SessionStats[] = [];
    const workspaceSet = new Set<string>();

    for (const session of snapshot.sessions) {
      if (toolFilter !== 'all' && session.source !== toolFilter) continue;

      const validTurns =
        cutoffMs > 0
          ? session.turnHistory.filter((t) => {
              const ts = new Date(t.timestamp).getTime();
              return !Number.isNaN(ts) && ts >= cutoffMs;
            })
          : session.turnHistory;

      if (validTurns.length === 0) continue;

      let sInput = 0;
      let sOutput = 0;
      let sCacheRead = 0;
      let sCacheWrite = 0;
      let sTotal = 0;
      let sCost = 0;
      let sSavings = 0;

      for (const t of validTurns) {
        sInput += t.inputTokens;
        sOutput += t.outputTokens;
        sCacheRead += t.cacheReadTokens;
        sCacheWrite += t.cacheWriteTokens;
        sTotal += t.totalTokens;
        sCost += t.costUSD;
        sSavings += t.cacheSavingsUSD;

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
          antigravityCost += t.costUSD;
        } else {
          dayEntry.claudeUSD += t.costUSD;
          claudeCost += t.costUSD;
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

      totalCostUSD += sCost;
      totalCacheSavingsUSD += sSavings;
      totalInputTokens += sInput;
      totalOutputTokens += sOutput;
      totalCacheReadTokens += sCacheRead;
      totalCacheWriteTokens += sCacheWrite;
      totalTokens += sTotal;
      totalTurns += validTurns.length;
      workspaceSet.add(session.workspaceName);

      filteredSessions.push({
        ...session,
        turns: validTurns.length,
        inputTokens: sInput,
        outputTokens: sOutput,
        cacheReadTokens: sCacheRead,
        cacheWriteTokens: sCacheWrite,
        totalTokens: sTotal,
        costUSD: sCost,
        cacheSavingsUSD: sSavings,
        turnHistory: validTurns,
      });
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

    const searchedSessions = filteredSessions.filter((s) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        s.workspaceName.toLowerCase().includes(q) ||
        s.workspace.toLowerCase().includes(q) ||
        s.primaryModelLabel.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
      );
    });

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
      sessions: searchedSessions,
      totalSessionsCount: filteredSessions.length,
    };
  }, [snapshot, toolFilter, timeRange, searchQuery]);

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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Subtle top glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-emerald-500/[0.05] via-cyan-500/[0.02] to-transparent" />

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
        <div className="max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] mx-auto px-3 sm:px-6 h-16 flex items-center justify-between gap-3 overflow-x-auto whitespace-nowrap">
          {/* Brand & Live Status */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner shrink-0">
              <Zap className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-zinc-100 text-sm sm:text-base">ai-burnrate</span>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
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
              <p className="text-[11px] text-zinc-500 font-mono hidden xl:block">
                Watching ~/.gemini & ~/.claude {lastSyncTime && `• Synced ${lastSyncTime}`}
              </p>
            </div>
          </div>

          {/* Controls: Tool Filter, Time Selector, Currency, Rescan */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {/* Tool Filter */}
            <div className="inline-flex rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs shrink-0">
              <button
                onClick={() => setToolFilter('all')}
                className={`px-2 sm:px-2.5 py-1 rounded-md font-medium transition ${
                  toolFilter === 'all'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setToolFilter('antigravity')}
                className={`px-2 sm:px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
                  toolFilter === 'antigravity'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0" />
                <span>Antigravity</span>
              </button>
              <button
                onClick={() => setToolFilter('claude')}
                className={`px-2 sm:px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
                  toolFilter === 'claude'
                    ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 shrink-0" />
                <span>Claude</span>
              </button>
            </div>

            {/* Time Range Selector */}
            <div className="inline-flex rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs font-mono shrink-0">
              {(['24h', '7d', '30d', 'all'] as TimeRange[]).map((range) => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-2 sm:px-2.5 py-1 rounded-md uppercase transition ${
                    timeRange === range
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>

            {/* Currency Toggle ($ USD / € EUR) */}
            <div className="inline-flex rounded-lg bg-zinc-900/90 p-1 border border-zinc-800/90 text-xs font-mono shrink-0">
              <button
                onClick={() => toggleCurrency('USD')}
                className={`px-2 py-1 rounded-md transition ${
                  currency === 'USD'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                $ USD
              </button>
              <button
                onClick={() => toggleCurrency('EUR')}
                className={`px-2 py-1 rounded-md transition ${
                  currency === 'EUR'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                € EUR
              </button>
            </div>

            {/* Manual Rescan */}
            <button
              onClick={triggerManualRescan}
              title="Force Rescan Logs"
              className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${isRescanning ? 'animate-spin text-emerald-400' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Live Event Banner if a file just updated */}
        {lastChangedFile && (
          <div className="rounded-lg bg-emerald-950/30 border border-emerald-500/30 px-3.5 py-2 flex items-center justify-between text-xs font-mono text-emerald-300">
            <span className="truncate">
              ● Live update received from: <span className="text-emerald-200">{lastChangedFile}</span>
            </span>
            <button
              onClick={() => setLastChangedFile(null)}
              className="text-emerald-400/70 hover:text-emerald-300 ml-4"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* 4 KPI Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Estimated API Spend & Subscription Comparison */}
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between relative overflow-hidden">
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
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between">
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
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between">
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
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col justify-between">
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
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Daily Burn Rate Timeline (2 cols) */}
          <div className="lg:col-span-2 rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col">
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
                      }}
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
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5 flex flex-col">
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
                      }}
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
        <section className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-emerald-400" />
                Total Token Usage by Model
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Complete token consumption breakdown (Input, Cache Read & Output) per AI model
              </p>
            </div>
            <div className="text-xs font-mono text-zinc-400">
              Total: <span className="text-zinc-100 font-semibold">{formatTokens(analytics.totalTokens)}</span> tokens
            </div>
          </div>

          {analytics.modelData.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500 font-mono">
              No model token data available.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {[...analytics.modelData]
                .sort((a, b) => b.tokens - a.tokens)
                .map((m, idx) => {
                  const sharePct =
                    analytics.totalTokens > 0 ? (m.tokens / analytics.totalTokens) * 100 : 0;
                  const barColor = MODEL_COLORS[idx % MODEL_COLORS.length];
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
                            {isPromoActive(m.rate) && (
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
                          <span className="text-xs font-mono text-zinc-400">
                            {sharePct.toFixed(1)}%
                          </span>
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

                      {m.rate && (() => {
                        const promoActive = isPromoActive(m.rate);
                        const curInput = promoActive ? m.rate.input : (m.rate.standardInput ?? m.rate.input);
                        const curCache = promoActive ? m.rate.cacheRead : (m.rate.standardCacheRead ?? m.rate.cacheRead);
                        const curOutput = promoActive ? m.rate.output : (m.rate.standardOutput ?? m.rate.output);

                        return (
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
                                      {formatMoney(m.rate.standardInput, currency)}
                                    </span>
                                  )}
                                  <span className="text-zinc-200 font-semibold">
                                    {formatMoney(curInput, currency)}
                                  </span>
                                </div>
                              </div>

                              <div>
                                <span className="text-zinc-500 block text-[9px] uppercase tracking-wider">Cached</span>
                                <span className="text-cyan-400 font-semibold">
                                  {formatMoney(curCache, currency)}
                                </span>
                              </div>

                              <div>
                                <span className="text-zinc-500 block text-[9px] uppercase tracking-wider">Output</span>
                                <div className="flex items-baseline gap-1">
                                  {promoActive && m.rate.standardOutput && (
                                    <span className="line-through text-zinc-600 text-[9px]">
                                      {formatMoney(m.rate.standardOutput, currency)}
                                    </span>
                                  )}
                                  <span className="text-amber-300 font-semibold">
                                    {formatMoney(curOutput, currency)}
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
                        );
                      })()}
                    </div>
                  );
                })}
            </div>
          )}
        </section>

        {/* Live Sessions / Workspaces Table */}
        <section className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                Live Sessions & Workspaces
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Real-time telemetry streamed from local JSONL transcripts ({analytics.sessions.length} shown)
              </p>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter workspace, model, session..."
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[940px] xl:min-w-0">
              <thead>
                <tr className="border-b border-zinc-800/80 text-[10px] xl:text-[11px] font-mono uppercase text-zinc-400 bg-zinc-950/40">
                  <th className="py-2.5 px-2 w-7 sm:w-8 text-center"></th>
                  <th className="py-2.5 px-2 xl:px-3">Tool</th>
                  <th className="py-2.5 px-2 xl:px-3">Workspace / Session</th>
                  <th className="py-2.5 px-2 xl:px-3">Primary Model</th>
                  <th className="py-2.5 px-2 xl:px-2.5 text-right">Turns</th>
                  <th className="py-2.5 px-2 xl:px-2.5 text-right">Input / Output</th>
                  <th className="py-2.5 px-2 xl:px-2.5 text-right">Cache Read</th>
                  <th className="py-2.5 px-2 xl:px-2.5 text-right">Cache Saved</th>
                  <th className="py-2.5 px-2 xl:px-3 text-right">API Cost</th>
                  <th className="py-2.5 px-2 xl:px-2.5 text-right">Created</th>
                  <th className="py-2.5 px-2 xl:px-3 text-right">Last Modified</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-xs">
                {analytics.sessions.slice(0, 60).map((s) => {
                  const rowKey = `${s.source}-${s.filePath}`;
                  const isExpanded = expandedSessions.has(rowKey);
                  const sessionModels = isExpanded ? getSessionModelBreakdown(s.turnHistory) : [];

                  return (
                    <React.Fragment key={rowKey}>
                      <tr
                        onClick={() => toggleExpandSession(rowKey)}
                        className={`hover:bg-zinc-800/30 transition-colors group cursor-pointer ${
                          isExpanded ? 'bg-zinc-900/40' : ''
                        }`}
                      >
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandSession(rowKey);
                            }}
                            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition"
                            title={isExpanded ? 'Collapse models' : 'Expand models involved'}
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </td>

                        <td className="py-2 px-2 xl:px-3 whitespace-nowrap">
                          {s.source === 'antigravity' ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-mono font-medium bg-cyan-500/10 text-cyan-300 border border-cyan-500/25">
                              <Terminal className="w-3 h-3" />
                              Antigravity
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-mono font-medium bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/25">
                              <Sparkles className="w-3 h-3" />
                              Claude Code
                            </span>
                          )}
                        </td>

                        <td className="py-2 px-2 xl:px-3">
                          <div className="flex items-center gap-1.5 font-medium text-zinc-200">
                            <FolderGit2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            <span className="truncate max-w-[120px] sm:max-w-[150px] lg:max-w-[180px] xl:max-w-[220px]" title={s.workspace}>
                              {s.workspaceName}
                            </span>
                          </div>
                          <div className="text-[10.5px] text-zinc-500 font-mono truncate max-w-[120px] sm:max-w-[150px] lg:max-w-[180px] xl:max-w-[220px]" title={s.sessionId}>
                            {s.sessionId}
                          </div>
                        </td>

                        <td className="py-2 px-2 xl:px-3 whitespace-nowrap font-mono text-[11px] xl:text-xs text-zinc-300">
                          {s.primaryModelLabel}
                        </td>

                        <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-zinc-300 text-[11px] xl:text-xs">
                          {s.turns}
                        </td>

                        <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-zinc-400 text-[11px] xl:text-xs">
                          <span className="text-zinc-200">{formatTokens(s.inputTokens)}</span>
                          <span className="text-zinc-600 mx-0.5">/</span>
                          <span className="text-zinc-300">{formatTokens(s.outputTokens)}</span>
                        </td>

                        <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-cyan-400 text-[11px] xl:text-xs">
                          {formatTokens(s.cacheReadTokens)}
                        </td>

                        <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-fuchsia-400 text-[11px] xl:text-xs">
                          {formatMoney(s.cacheSavingsUSD, currency)}
                        </td>

                        <td className="py-2 px-2 xl:px-3 whitespace-nowrap text-right font-mono font-semibold text-emerald-400 text-[11px] xl:text-xs">
                          {formatMoney(s.costUSD, currency)}
                        </td>

                        <td className="py-2 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono text-[11px] xl:text-xs">
                          <div className="text-zinc-200">{formatPreciseDateTime(s.startedAt).date}</div>
                          <div className="text-[10px] text-zinc-500">{formatPreciseDateTime(s.startedAt).time}</div>
                        </td>

                        <td className="py-2 px-2 xl:px-3 whitespace-nowrap text-right font-mono text-[11px] xl:text-xs">
                          <div className="text-zinc-200">{formatPreciseDateTime(s.lastActiveAt).date}</div>
                          <div className="text-[10px] text-emerald-400/90 flex items-center justify-end gap-1" title={formatRelativeTime(s.lastActiveAt)}>
                            <span>{formatPreciseDateTime(s.lastActiveAt).time}</span>
                            <span className="text-zinc-500 hidden xl:inline">({formatRelativeTime(s.lastActiveAt)})</span>
                          </div>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-zinc-950/80 border-b border-zinc-800/80">
                          <td colSpan={11} className="px-3 py-3 sm:px-4 sm:py-3.5">
                            <div className="rounded-lg bg-zinc-900/60 border border-zinc-800/90 p-3 sm:p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-zinc-200 flex items-center gap-2">
                                  <Cpu className="w-4 h-4 text-emerald-400" />
                                  Models Involved in this Project ({sessionModels.length})
                                </span>
                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400">
                                  <span>
                                    Creato: <span className="text-zinc-200">{formatPreciseDateTime(s.startedAt).date} {formatPreciseDateTime(s.startedAt).time}</span>
                                  </span>
                                  <span>•</span>
                                  <span>
                                    Ultima modifica: <span className="text-emerald-400">{formatPreciseDateTime(s.lastActiveAt).date} {formatPreciseDateTime(s.lastActiveAt).time}</span>
                                  </span>
                                </div>
                              </div>

                              <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse text-xs min-w-[620px] lg:min-w-0">
                                  <thead>
                                    <tr className="border-b border-zinc-800/80 text-[10px] font-mono uppercase text-zinc-400">
                                      <th className="py-2 px-2.5">Model</th>
                                      <th className="py-2 px-2 text-right">Turns</th>
                                      <th className="py-2 px-2 text-right">Input</th>
                                      <th className="py-2 px-2 text-right">Cache Read</th>
                                      <th className="py-2 px-2 text-right">Output</th>
                                      <th className="py-2 px-2 text-right">Total Tokens</th>
                                      <th className="py-2 px-2 text-right">Cache Saved</th>
                                      <th className="py-2 px-2.5 text-right">API Cost</th>
                                      <th className="py-2 px-2 text-right">Cost Share</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-zinc-800/50">
                                    {sessionModels.map((m) => {
                                      const costShare =
                                        s.costUSD > 0 ? (m.costUSD / s.costUSD) * 100 : 0;
                                      const modelRate =
                                        (m.normalizedModel ? snapshot?.pricing?.models?.[m.normalizedModel] : undefined) ||
                                        Object.values(snapshot?.pricing?.models || {}).find(
                                          (r) => r.label === m.modelLabel
                                        );
                                      return (
                                        <tr key={m.modelLabel} className="hover:bg-zinc-800/20">
                                          <td className="py-2 px-2.5 font-mono font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                                            <span>{m.modelLabel}</span>
                                            {isPromoActive(modelRate) && (
                                              <span
                                                className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                                title={modelRate?.promoNote || 'Tariffa promozionale attiva'}
                                              >
                                                PROMO
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-zinc-300 text-[11px]">
                                            {m.turns}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-zinc-400 text-[11px]">
                                            {formatTokens(m.inputTokens)}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-cyan-400 text-[11px]">
                                            {formatTokens(m.cacheReadTokens)}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-zinc-300 text-[11px]">
                                            {formatTokens(m.outputTokens)}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-zinc-200 font-medium text-[11px]">
                                            {formatTokens(m.totalTokens)}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-fuchsia-400 text-[11px]">
                                            {formatMoney(m.cacheSavingsUSD, currency)}
                                          </td>
                                          <td className="py-2 px-2.5 text-right font-mono font-semibold text-emerald-400 text-[11px]">
                                            {formatMoney(m.costUSD, currency)}
                                          </td>
                                          <td className="py-2 px-2 text-right font-mono text-zinc-400 text-[11px]">
                                            {costShare.toFixed(1)}%
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {analytics.sessions.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-10 text-center text-zinc-500 font-mono">
                      No matching sessions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
