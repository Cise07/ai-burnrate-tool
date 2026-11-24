import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  DEMO_DAYS,
  DEMO_SESSIONS,
  DEMO_SUBSCRIPTIONS,
  EUR_RATE,
  formatApiMoney,
  formatSubMoney,
  formatTokens,
  isWithinTimeRange,
  type Currency,
  type TimeRange,
  type ToolFilter,
  type ToolKey,
} from '../data/siteData';

interface HeroSandboxProps {
  currency: Currency;
  resolvedScheme: 'light' | 'dark';
}

const TOOL_TABS: Array<{ id: ToolFilter; label: string; dotVar?: string; accentVar: string }> = [
  { id: 'all', label: 'All tools', accentVar: 'var(--accent-teal)' },
  { id: 'antigravity', label: 'Antigravity', dotVar: 'var(--tool-antigravity)', accentVar: 'var(--tool-antigravity)' },
  { id: 'claude', label: 'Claude Code', dotVar: 'var(--tool-claude)', accentVar: 'var(--tool-claude)' },
  { id: 'codex', label: 'Codex CLI', dotVar: 'var(--tool-codex)', accentVar: 'var(--tool-codex)' },
];

const TIME_RANGES: Array<{ id: TimeRange; label: string }> = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'ALL' },
];

function useAnimatedNumber(target: number, durationMs = 220): number {
  const [value, setValue] = useState<number>(target);
  const prevRef = useRef<number>(target);

  useEffect(() => {
    const startVal = prevRef.current;
    if (Math.abs(target - startVal) < 0.0001) {
      setValue(target);
      return;
    }
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      prevRef.current = target;
      setValue(target);
      return;
    }

    let raf = 0;
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(startVal + (target - startVal) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
        setValue(target);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}

export function HeroSandbox({ currency, resolvedScheme }: HeroSandboxProps) {
  const baseId = useId();
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [expandedBtw, setExpandedBtw] = useState<boolean>(false);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );
  const tabRefs = useRef<Partial<Record<ToolFilter, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setPrefersReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
      void import('@microsoft/focusgroup-polyfill').then((mod) => {
        if (typeof mod.polyfillBodyAndObserve === 'function') {
          mod.polyfillBodyAndObserve();
        } else if (typeof mod.polyfill === 'function') {
          mod.polyfill(document.body);
        }
      });
    }
  }, []);

  const selectTab = (next: ToolFilter) => {
    if (next !== toolFilter) setHasInteracted(true);
    setToolFilter(next);
    const el = tabRefs.current[next];
    if (el) {
      el.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        ...({ container: 'nearest' } as Record<string, string>),
      });
    }
  };

  const telemetry = useMemo(() => {
    let totalCostUSD = 0;
    let totalSavingsUSD = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCache = 0;
    let totalTurns = 0;
    const perToolCost: Record<ToolKey, number> = { antigravity: 0, claude: 0, codex: 0 };

    const daily = DEMO_DAYS.map((day) => ({
      day,
      antigravity: 0,
      claude: 0,
      codex: 0,
    }));

    const scopedSessions = DEMO_SESSIONS.filter(
      (s) => toolFilter === 'all' || s.source === toolFilter
    )
      .map((session) => {
        const turns = session.turns.filter((t) => isWithinTimeRange(t.daysAgo, timeRange));
        const costUSD = turns.reduce((a, t) => a + t.costUSD, 0);
        const cacheSavingsUSD = turns.reduce((a, t) => a + t.cacheSavingsUSD, 0);
        const tokens = turns.reduce(
          (a, t) => a + t.inputTokens + t.outputTokens + t.cacheReadTokens,
          0
        );
        return { ...session, turns, costUSD, cacheSavingsUSD, tokens };
      })
      .filter((s) => s.turns.length > 0);

    for (const s of scopedSessions) {
      for (const t of s.turns) {
        totalCostUSD += t.costUSD;
        totalSavingsUSD += t.cacheSavingsUSD;
        totalInput += t.inputTokens;
        totalOutput += t.outputTokens;
        totalCache += t.cacheReadTokens;
        totalTurns += 1;
        perToolCost[s.source] += t.costUSD;
        daily[t.dayIndex][s.source] = Number((daily[t.dayIndex][s.source] + t.costUSD).toFixed(2));
      }
    }

    const totalTokens = totalInput + totalOutput + totalCache;
    const cacheHitPct =
      totalInput + totalCache > 0 ? (totalCache / (totalInput + totalCache)) * 100 : 0;

    const subUsdNet =
      toolFilter === 'all'
        ? DEMO_SUBSCRIPTIONS.antigravity + DEMO_SUBSCRIPTIONS.claude + DEMO_SUBSCRIPTIONS.codex
        : DEMO_SUBSCRIPTIONS[toolFilter];

    const subTaxed = currency === 'EUR' ? subUsdNet * EUR_RATE * 1.22 : subUsdNet * 1.075;
    const apiDisplay = currency === 'EUR' ? totalCostUSD * EUR_RATE : totalCostUSD;
    const roiMultiple = subTaxed > 0 ? apiDisplay / subTaxed : 0;
    const roiRatioClamped = Math.min(1, Math.max(0.05, roiMultiple / 2));

    const chartData = daily.map((d) => ({
      day: d.day,
      antigravity: Number((currency === 'EUR' ? d.antigravity * EUR_RATE : d.antigravity).toFixed(2)),
      claude: Number((currency === 'EUR' ? d.claude * EUR_RATE : d.claude).toFixed(2)),
      codex: Number((currency === 'EUR' ? d.codex * EUR_RATE : d.codex).toFixed(2)),
    }));

    return {
      totalCostUSD,
      totalSavingsUSD,
      totalTokens,
      totalTurns,
      cacheHitPct,
      perToolCost,
      subUsdNet,
      roiMultiple,
      roiRatioClamped,
      chartData,
      scopedSessions,
    };
  }, [toolFilter, timeRange, currency]);

  const animatedCostUSD = useAnimatedNumber(telemetry.totalCostUSD);
  const animatedSavingsUSD = useAnimatedNumber(telemetry.totalSavingsUSD);
  const animatedTokens = useAnimatedNumber(telemetry.totalTokens);

  const activeTabMeta = TOOL_TABS.find((t) => t.id === toolFilter) ?? TOOL_TABS[0];
  const flagshipClaude = telemetry.scopedSessions.find((s) => s.id === 'demo-claude-billing');
  const flagshipBtwTurns = flagshipClaude
    ? flagshipClaude.turns.filter((t) => t.subagentName === '/btw')
    : [];
  const flagshipOtherSubagents = flagshipClaude
    ? flagshipClaude.turns.filter((t) => t.subagentName && t.subagentName !== '/btw')
    : [];
  const sym = currency === 'EUR' ? '€' : '$';
  const taxNote = currency === 'EUR' ? 'incl. IVA 22%' : 'incl. 7.5% tax';

  const isDark = resolvedScheme === 'dark';
  const chartColors = {
    antigravity: isDark ? '#38bdf8' : '#036fa1',
    claude: isDark ? '#c084fc' : '#6d28d9',
    codex: isDark ? '#fbbf24' : '#d97706',
    grid: isDark ? 'rgba(168,206,224,0.14)' : 'rgba(15,34,48,0.1)',
    axis: isDark ? '#8fa9be' : '#54687a',
    tooltipBg: isDark ? 'rgba(18, 33, 45, 0.94)' : 'rgba(255, 255, 255, 0.94)',
    tooltipBorder: isDark ? 'rgba(168,206,224,0.28)' : 'rgba(15,34,48,0.18)',
    tooltipText: isDark ? '#f0f7fa' : '#0e1c26',
  };

  return (
    <div className="hero-instrument glass-sheen rounded-2xl glass-panel overflow-hidden">
      <div className="brand-accent-bar" aria-hidden="true" />

      {/* Authentic local telemetry instrument header (zero fake macOS traffic dots) */}
      <div className="px-4 sm:px-5 py-2.5 border-b border-hairline bg-elevated flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 font-mono text-[11.5px] min-w-0">
          <img
            src="./logo.svg"
            alt=""
            width={18}
            height={18}
            className="w-4 h-4 rounded border border-hairline shrink-0"
          />
          <span className="text-ink font-semibold truncate">localhost:4321</span>
          <span className="text-subtle">·</span>
          <span className="inline-flex items-center gap-1.5 text-brand font-medium shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />
            SSE Live
          </span>
          <span className="text-subtle hidden sm:inline">· Sample dataset</span>
        </div>

        <div
          role="group"
          aria-label="Filter telemetry time window"
          className="inline-flex items-center rounded-lg border border-hairline bg-surface p-0.5 font-mono text-[11px]"
        >
          {TIME_RANGES.map((range) => {
            const active = timeRange === range.id;
            return (
              <button
                key={range.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setHasInteracted(true);
                  setTimeRange(range.id);
                }}
                className={`min-h-[26px] px-2.5 rounded-md transition-colors cursor-pointer ${
                  active
                    ? 'bg-elevated text-ink font-semibold shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                {range.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tool filter tabs + inline per-tool totals */}
      <div className="border-b border-hairline flex flex-col md:flex-row md:items-center justify-between gap-2 px-2.5 sm:px-4">
        <div
          role="tablist"
          aria-label="Filter telemetry by AI CLI"
          style={{ '--active-tab-accent': activeTabMeta.accentVar } as React.CSSProperties}
          className="burn-tablist burn-tablist-hero border-b-0"
          {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
        >
          {TOOL_TABS.map((tab) => {
            const selected = toolFilter === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                id={`${baseId}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => selectTab(tab.id)}
                onFocus={() => selectTab(tab.id)}
                style={{ '--tab-accent': tab.accentVar } as React.CSSProperties}
                className="burn-tab"
                {...(selected ? ({ focusgroupstart: '' } as Record<string, string>) : {})}
              >
                {tab.dotVar && (
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: tab.dotVar }}
                    aria-hidden="true"
                  />
                )}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="hidden lg:flex items-center gap-3.5 font-mono text-[11px] text-muted py-1.5 tabular">
          {(toolFilter === 'all' || toolFilter === 'antigravity') && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyanTool" aria-hidden="true" />
              AGY sample {formatApiMoney(telemetry.perToolCost.antigravity, currency)}
            </span>
          )}
          {(toolFilter === 'all' || toolFilter === 'claude') && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-claudeTool" aria-hidden="true" />
              Claude sample {formatApiMoney(telemetry.perToolCost.claude, currency)}
            </span>
          )}
          {(toolFilter === 'all' || toolFilter === 'codex') && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-codexTool" aria-hidden="true" />
              Codex sample {formatApiMoney(telemetry.perToolCost.codex, currency)}
            </span>
          )}
        </div>
      </div>

      {/* Main Workbench Panel */}
      <div role="tabpanel" aria-labelledby={`${baseId}-tab-${toolFilter}`}>
        {/* Clean 3-metric KPI ribbon — crisp hairline dividers, zero pastel pill clutter */}
        <div className="grid grid-cols-2 sm:grid-cols-3 border-b border-hairline divide-y sm:divide-y-0 sm:divide-x divide-hairline">
          <div className="p-3.5 sm:px-5 sm:py-4 border-r sm:border-r-0 border-hairline">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-muted">Sample API spend (net)</span>
              <span className="font-mono text-[11px] text-flame font-semibold tabular">
                {telemetry.roiMultiple.toFixed(1)}x ROI
              </span>
            </div>
            <div className="mt-1 font-mono text-xl sm:text-[1.65rem] font-semibold text-ink tabular">
              {formatApiMoney(animatedCostUSD, currency)}
            </div>
            <div className="mt-2 h-1 w-full rounded-full bg-elevated overflow-hidden" aria-hidden="true">
              <div
                className="roi-bar-fill h-full w-full rounded-full bg-flame"
                style={{ transform: `scaleX(${telemetry.roiRatioClamped})` }}
              />
            </div>
            <div className="mt-1.5 font-mono text-[10.5px] text-subtle tabular">
              vs {formatSubMoney(telemetry.subUsdNet, currency)}/mo plan ({taxNote})
            </div>
          </div>

          <div className="p-3.5 sm:px-5 sm:py-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-muted">Sample cache savings</span>
              <span className="font-mono text-[11px] text-brand font-semibold tabular">
                {telemetry.cacheHitPct.toFixed(1)}% hit
              </span>
            </div>
            <div className="mt-1 font-mono text-xl sm:text-[1.65rem] font-semibold text-brand tabular">
              {formatApiMoney(animatedSavingsUSD, currency)}
            </div>
            <div className="mt-2 h-1 w-full rounded-full bg-elevated overflow-hidden" aria-hidden="true">
              <div
                className="roi-bar-fill h-full w-full rounded-full bg-brand"
                style={{ transform: `scaleX(${Math.min(1, telemetry.cacheHitPct / 100)})` }}
              />
            </div>
            <div className="mt-1.5 font-mono text-[10.5px] text-subtle tabular">
              Prompt context served from cache
            </div>
          </div>

          <div className="col-span-2 sm:col-span-1 p-3.5 sm:px-5 sm:py-4 flex sm:block items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium text-muted">Sample tokens processed</div>
              <div className="mt-1 font-mono text-xl sm:text-[1.65rem] font-semibold text-ink tabular">
                {formatTokens(Math.round(animatedTokens))}
              </div>
            </div>
            <div className="text-right sm:text-left sm:mt-2.5 font-mono text-[11px] text-subtle tabular">
              <span className="text-ink font-semibold mr-1.5">{timeRange.toUpperCase()}</span>
              {telemetry.totalTurns} turns · {telemetry.scopedSessions.length} chats
            </div>
          </div>
        </div>

        {/* Wide Split Interior: 8-col Burn Chart + 4-col Session & /btw Inspector */}
        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-hairline">
          <div className="lg:col-span-8 p-4 sm:p-5">
            <figure className="m-0">
              <figcaption className="text-xs font-medium text-muted mb-2.5">
                Daily API equivalent burn curve — sample ({currency})
              </figcaption>
              <div className="h-44 sm:h-52 w-full" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={telemetry.chartData} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
                    <defs>
                      <linearGradient id="wbAgy" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartColors.antigravity} stopOpacity={isDark ? 0.28 : 0.24} />
                        <stop offset="95%" stopColor={chartColors.antigravity} stopOpacity={0.01} />
                      </linearGradient>
                      <linearGradient id="wbClaude" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartColors.claude} stopOpacity={isDark ? 0.28 : 0.22} />
                        <stop offset="95%" stopColor={chartColors.claude} stopOpacity={0.01} />
                      </linearGradient>
                      <linearGradient id="wbCodex" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartColors.codex} stopOpacity={isDark ? 0.26 : 0.24} />
                        <stop offset="95%" stopColor={chartColors.codex} stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 4" stroke={chartColors.grid} vertical={false} />
                    <XAxis
                      dataKey="day"
                      stroke={chartColors.axis}
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      interval={2}
                    />
                    <YAxis
                      stroke={chartColors.axis}
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => String(v)}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: chartColors.tooltipBg,
                        borderColor: chartColors.tooltipBorder,
                        color: chartColors.tooltipText,
                        borderRadius: '0.5rem',
                        fontSize: '11px',
                        fontFamily: '"JetBrains Mono", monospace',
                      }}
                      formatter={(value: number, name: string) => [
                        `${sym}${Number(value).toFixed(2)}`,
                        name === 'antigravity'
                          ? 'Antigravity'
                          : name === 'claude'
                            ? 'Claude Code'
                            : 'Codex CLI',
                      ]}
                    />
                    {(toolFilter === 'all' || toolFilter === 'claude') && (
                      <Area
                        type="monotone"
                        dataKey="claude"
                        stroke={chartColors.claude}
                        strokeWidth={2}
                        fill="url(#wbClaude)"
                        isAnimationActive={hasInteracted && !prefersReducedMotion}
                        animationDuration={240}
                      />
                    )}
                    {(toolFilter === 'all' || toolFilter === 'antigravity') && (
                      <Area
                        type="monotone"
                        dataKey="antigravity"
                        stroke={chartColors.antigravity}
                        strokeWidth={2}
                        fill="url(#wbAgy)"
                        isAnimationActive={hasInteracted && !prefersReducedMotion}
                        animationDuration={240}
                      />
                    )}
                    {(toolFilter === 'all' || toolFilter === 'codex') && (
                      <Area
                        type="monotone"
                        dataKey="codex"
                        stroke={chartColors.codex}
                        strokeWidth={2}
                        fill="url(#wbCodex)"
                        isAnimationActive={hasInteracted && !prefersReducedMotion}
                        animationDuration={240}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </figure>
          </div>

          {/* Right 4-col live Session & /btw Inspector */}
          <div className="lg:col-span-4 p-4 sm:p-5 bg-elevated flex flex-col justify-between gap-3">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-hairline font-mono text-xs">
                <div className="min-w-0">
                  <div className="font-semibold text-ink truncate">saas-billing-engine</div>
                  <div className="text-[10.5px] text-subtle">
                    {telemetry.scopedSessions.length} sample chats rolled up
                  </div>
                </div>
                <div className="text-right shrink-0 tabular">
                  <div className="font-semibold text-ink">
                    <span className="text-subtle font-normal text-[10px] mr-1">sample</span>
                    {formatApiMoney(telemetry.totalCostUSD, currency)}
                  </div>
                </div>
              </div>

              {flagshipClaude ? (
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-semibold text-claudeTool">
                        <span className="h-1.5 w-1.5 rounded-full bg-claudeTool" aria-hidden="true" />
                        Claude Code
                      </span>
                      <div className="mt-0.5 text-ink font-medium leading-snug">
                        {flagshipClaude.title}
                      </div>
                    </div>
                    <span className="font-mono text-xs font-semibold text-ink tabular shrink-0">
                      <span className="text-subtle font-normal text-[10px] mr-1">sample</span>
                      {formatApiMoney(flagshipClaude.costUSD, currency)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-0.5 font-mono text-[10.5px] tabular">
                    {flagshipOtherSubagents.length > 0 && (
                      <span className="text-muted">
                        Explore sample · {flagshipOtherSubagents.length}t ·{' '}
                        {formatApiMoney(
                          flagshipOtherSubagents.reduce((a, t) => a + t.costUSD, 0),
                          currency
                        )}
                      </span>
                    )}
                    {flagshipBtwTurns.length > 0 && (
                      <button
                        type="button"
                        aria-expanded={expandedBtw}
                        onClick={() => setExpandedBtw((v) => !v)}
                        className="inline-flex items-center gap-1 min-h-[28px] px-2.5 py-0.5 rounded-md border border-hairlineStrong bg-surface hover:border-flame text-flame font-semibold cursor-pointer transition-colors"
                      >
                        <span>
                          +{flagshipBtwTurns.length} /btw sample ·{' '}
                          {formatApiMoney(
                            flagshipBtwTurns.reduce((a, t) => a + t.costUSD, 0),
                            currency
                          )}
                        </span>
                        {expandedBtw ? (
                          <ChevronDown className="w-3 h-3" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="w-3 h-3" aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </div>

                  {expandedBtw && flagshipBtwTurns.length > 0 && (
                    <ul className="panel-swap-enter space-y-1.5 pt-1 list-none pl-0 m-0">
                      {flagshipBtwTurns.map((turn) => (
                        <li
                          key={turn.id}
                          className="flex flex-col gap-0.5 text-[11px] font-mono bg-surface px-2.5 py-1.5 rounded-md border border-hairline"
                        >
                          <span className="text-ink truncate">{turn.subagentTitle}</span>
                          <span className="text-[10px] text-muted tabular">
                            {formatTokens(turn.inputTokens + turn.outputTokens + turn.cacheReadTokens)}{' '}
                            · sample{' '}
                            <span className="text-ink font-semibold">
                              {formatApiMoney(turn.costUSD, currency)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="space-y-1 text-xs font-mono">
                  <div className="text-ink font-medium">
                    {telemetry.scopedSessions[0]?.title || 'No sessions match current filter'}
                  </div>
                  <div className="text-muted tabular">
                    sample {formatApiMoney(telemetry.scopedSessions[0]?.costUSD || 0, currency)}
                  </div>
                </div>
              )}
            </div>

            <div className="pt-2.5 border-t border-hairline font-mono text-[10.5px] text-subtle flex items-center justify-between gap-2">
              <span>Subagents &amp; /btw attributed</span>
              <span className="text-brand font-medium">Read-only scan</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
