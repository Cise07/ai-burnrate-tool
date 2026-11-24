import { useMemo, useState } from 'react';
import {
  SAMPLE_HEATMAP_DAYS,
  SAMPLE_TOP_WORKSPACES,
  formatApiMoney,
  formatTokens,
  type Currency,
  type SampleHeatmapDay,
  type ToolKey,
} from '../data/siteData';

interface HeatmapShowcaseProps {
  currency: Currency;
}

const HEATMAP_LEVEL_CLASSES: Record<SampleHeatmapDay['level'], string> = {
  0: 'heat-lvl-0',
  1: 'heat-lvl-1',
  2: 'heat-lvl-2',
  3: 'heat-lvl-3',
  4: 'heat-lvl-4',
};

const TOOL_DOTS: Record<ToolKey, { label: string; color: string }> = {
  antigravity: { label: 'Antigravity', color: 'bg-cyanTool' },
  claude: { label: 'Claude Code', color: 'bg-claudeTool' },
  codex: { label: 'Codex CLI', color: 'bg-codexTool' },
};

export function HeatmapShowcase({ currency }: HeatmapShowcaseProps) {
  const [selectedDay, setSelectedDay] = useState<SampleHeatmapDay>(
    () => SAMPLE_HEATMAP_DAYS.find((d) => d.level === 4) ?? SAMPLE_HEATMAP_DAYS[SAMPLE_HEATMAP_DAYS.length - 1]
  );

  const weeks = useMemo(() => {
    const cols: SampleHeatmapDay[][] = [];
    for (const day of SAMPLE_HEATMAP_DAYS) {
      if (!cols[day.weekIndex]) cols[day.weekIndex] = [];
      cols[day.weekIndex][day.dayOfWeek] = day;
    }
    return cols;
  }, []);

  const activeDays = useMemo(
    () => SAMPLE_HEATMAP_DAYS.filter((d) => d.turns > 0).length,
    []
  );

  const maxWorkspaceCost = SAMPLE_TOP_WORKSPACES[0]?.costUSD || 1;

  return (
    <section id="activity" className="py-16 sm:py-20 border-t border-hairline">
      <div className="max-w-[74rem] mx-auto px-4 sm:px-8">
        <div className="scroll-arrive flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
          <div className="max-w-xl">
            <h2 className="text-2xl sm:text-[2rem] font-bold tracking-[-0.03em] text-ink">
              Thermal burn calendar and workspace attribution
            </h2>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Sessions and subagents resolve automatically to their repository path across Antigravity, Claude Code, and Codex CLI. Peak burn days shift from cool teal into warm flame amber.
            </p>
          </div>
          <span className="font-mono text-xs text-subtle">
            CSV &amp; JSON export · 13-week rolling window
          </span>
        </div>

        {/* Unified translucent glass deck with scroll tilt & light reflection */}
        <div className="scroll-glass-card glass-sheen rounded-2xl glass-panel grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-hairline overflow-hidden">
          <div className="lg:col-span-7 p-5 sm:p-6 flex flex-col justify-between gap-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink">
                  Daily intensity — {activeDays} active days (sample)
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Hover or select any tile to inspect daily cost and token volume.
                </p>
              </div>

              <div className="glass-control px-2.5 py-1 rounded-md font-mono text-[11.5px] flex flex-wrap items-center gap-x-2.5 gap-y-0.5 tabular">
                <span className="text-ink font-semibold">{selectedDay.date}</span>
                <span className={selectedDay.level >= 3 ? 'text-flame font-semibold' : 'text-brand font-semibold'}>
                  {formatApiMoney(selectedDay.costUSD, currency)}
                </span>
                <span className="text-muted">{formatTokens(selectedDay.tokens)}</span>
                <span className="text-subtle">{selectedDay.turns}t</span>
              </div>
            </div>

            <div className="overflow-x-auto pb-1">
              <div className="inline-flex items-start gap-2.5 min-w-max">
                <div
                  className="grid grid-rows-7 gap-1.5 font-mono text-[10px] text-subtle pt-0.5 select-none"
                  aria-hidden="true"
                >
                  <span className="h-[18px] leading-[18px]">Mon</span>
                  <span className="h-[18px]" />
                  <span className="h-[18px] leading-[18px]">Wed</span>
                  <span className="h-[18px]" />
                  <span className="h-[18px] leading-[18px]">Fri</span>
                  <span className="h-[18px]" />
                  <span className="h-[18px] leading-[18px]">Sun</span>
                </div>

                <div className="grid grid-flow-col gap-1.5">
                  {weeks.map((week, wIdx) => (
                    <div
                      key={wIdx}
                      style={{ '--col-i': wIdx } as React.CSSProperties}
                      className="scroll-heat-col grid grid-rows-7 gap-1.5"
                    >
                      {week.map((day) => {
                        const isSelected = selectedDay.date === day.date;
                        return (
                          <button
                            key={day.date}
                            type="button"
                            onMouseEnter={() => setSelectedDay(day)}
                            onFocus={() => setSelectedDay(day)}
                            onClick={() => setSelectedDay(day)}
                            aria-label={`${day.date}: ${formatApiMoney(day.costUSD, currency)}, ${day.turns} turns`}
                            aria-pressed={isSelected}
                            className={`heatmap-cell w-[18px] h-[18px] rounded-[4px] border cursor-pointer ${
                              HEATMAP_LEVEL_CLASSES[day.level]
                            } ${isSelected ? 'ring-2 ring-ink ring-offset-1 ring-offset-canvas' : ''}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-hairline text-[11px] font-mono text-subtle">
              <span>Sep · Oct · Nov (sample dataset)</span>
              <div className="inline-flex items-center gap-1.5" aria-hidden="true">
                <span>Cool</span>
                {([0, 1, 2, 3, 4] as const).map((lvl) => (
                  <span
                    key={lvl}
                    className={`w-3 h-3 rounded-[3px] border ${HEATMAP_LEVEL_CLASSES[lvl]}`}
                  />
                ))}
                <span>Peak burn</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 flex flex-col bg-elevated">
            <div className="px-5 py-4 border-b border-hairline">
              <h3 className="text-sm font-semibold text-ink">Top workspaces (sample)</h3>
              <p className="mt-0.5 text-xs text-muted">
                Aggregated by working directory across all three tools
              </p>
            </div>

            <ul className="divide-y divide-hairline list-none p-0 m-0 flex-1">
              {SAMPLE_TOP_WORKSPACES.map((ws, idx) => {
                const ratio = Math.max(0.08, ws.costUSD / maxWorkspaceCost);
                return (
                  <li key={ws.name} className="px-5 py-3.5 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-xs font-mono">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-ink font-semibold truncate">{ws.name}</span>
                        <span className="inline-flex items-center gap-1 shrink-0">
                          {ws.sources.map((src) => (
                            <span
                              key={src}
                              title={TOOL_DOTS[src].label}
                              className={`h-2 w-2 rounded-full ${TOOL_DOTS[src].color}`}
                              aria-label={TOOL_DOTS[src].label}
                            />
                          ))}
                        </span>
                      </div>
                      <span className="text-ink font-semibold tabular shrink-0">
                        {formatApiMoney(ws.costUSD, currency)}
                      </span>
                    </div>

                    <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden" aria-hidden="true">
                      <div
                        className={`scroll-fill-bar roi-bar-fill h-full w-full rounded-full ${
                          idx === 0 ? 'bg-flame' : 'bg-brand'
                        }`}
                        style={
                          {
                            '--bar-ratio': ratio,
                            transform: `scaleX(${ratio})`,
                          } as React.CSSProperties
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-subtle tabular">
                      <span className="truncate">{ws.path}</span>
                      <span className="shrink-0">
                        {ws.chats} chats · {formatTokens(ws.tokens)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
