import { useMemo, useState } from 'react';
import { CalendarDays, FolderGit2 } from 'lucide-react';
import {
  formatMoney,
  type Currency,
  type HeatmapDay,
  type TopWorkspaceItem,
} from '../../core/analytics';
import type { ToolSource } from '../../core/types';

interface HeatmapAndWorkspacesProps {
  heatmapDays: HeatmapDay[];
  topWorkspaces: TopWorkspaceItem[];
  currency: Currency;
  onSelectWorkspace?: (workspaceName: string) => void;
}

const HEATMAP_LEVEL_CLASSES: Record<HeatmapDay['level'], string> = {
  0: 'heat-lvl-0',
  1: 'heat-lvl-1',
  2: 'heat-lvl-2',
  3: 'heat-lvl-3',
  4: 'heat-lvl-4',
};

const TOOL_DOT_VARS: Record<ToolSource, string> = {
  antigravity: 'var(--tool-antigravity)',
  claude: 'var(--tool-claude)',
  codex: 'var(--tool-codex)',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function HeatmapAndWorkspaces({
  heatmapDays,
  topWorkspaces,
  currency,
  onSelectWorkspace,
}: HeatmapAndWorkspacesProps) {
  const [selectedDay, setSelectedDay] = useState<HeatmapDay | null>(null);

  const weeks = useMemo(() => {
    const cols: Array<Array<HeatmapDay | null>> = [];
    for (const day of heatmapDays) {
      if (!cols[day.weekIndex]) {
        cols[day.weekIndex] = [null, null, null, null, null, null, null];
      }
      cols[day.weekIndex][day.dayOfWeek] = day;
    }
    return cols;
  }, [heatmapDays]);

  const monthLabels = useMemo(() => {
    const labels: Array<{ weekIndex: number; label: string }> = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks.length; w++) {
      const firstDay = weeks[w]?.find((d) => d !== null);
      if (!firstDay) continue;
      const month = Number(firstDay.date.slice(5, 7)) - 1;
      if (month !== lastMonth && month >= 0 && month < 12) {
        labels.push({ weekIndex: w, label: MONTH_NAMES[month] });
        lastMonth = month;
      }
    }
    return labels;
  }, [weeks]);

  const activeDaysCount = useMemo(
    () => heatmapDays.filter((d) => d.turns > 0).length,
    [heatmapDays]
  );

  const highlightedDay = useMemo(() => {
    if (selectedDay) return selectedDay;
    for (let i = heatmapDays.length - 1; i >= 0; i--) {
      if (heatmapDays[i].turns > 0) return heatmapDays[i];
    }
    return heatmapDays[heatmapDays.length - 1] || null;
  }, [selectedDay, heatmapDays]);

  const maxWorkspaceCost = topWorkspaces[0]?.costUSD || 1;

  return (
    <section
      className="grid grid-cols-1 lg:grid-cols-3 gap-5 animate-burn-fade-up"
      style={{ animationDelay: '75ms' }}
    >
      {/* Daily Activity Heatmap (2 cols) */}
      <div className="lg:col-span-2 glass-panel rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-[var(--accent-teal)]" />
              Activity Heatmap (Last 13 Weeks)
            </h2>
            <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
              Daily API equivalent burn intensity · {activeDaysCount} active {activeDaysCount === 1 ? 'day' : 'days'}
            </p>
          </div>

          {highlightedDay && (
            <div className="glass-control px-2.5 py-1.5 rounded-lg text-[11px] font-mono tabular flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <span className="text-[var(--ink-primary)] font-semibold">{highlightedDay.date}</span>
              <span className="text-[var(--accent-flame)] font-bold">
                {formatMoney(highlightedDay.costUSD, currency)}
              </span>
              <span className="text-[var(--ink-tertiary)]">·</span>
              <span className="text-[var(--ink-secondary)]">{fmtTokens(highlightedDay.tokens)} tok</span>
              <span className="text-[var(--ink-tertiary)]">·</span>
              <span className="text-[var(--ink-secondary)]">{highlightedDay.turns}t</span>
            </div>
          )}
        </div>

        <div className="table-scroll overflow-x-auto pb-1">
          <div className="inline-flex flex-col gap-1.5 min-w-full">
            <div className="flex items-center pl-8 text-[10px] font-mono text-[var(--ink-tertiary)] h-4 relative">
              {monthLabels.map((m) => (
                <span
                  key={`${m.weekIndex}-${m.label}`}
                  className="absolute"
                  style={{ left: `calc(2rem + ${m.weekIndex * 24}px)` }}
                >
                  {m.label}
                </span>
              ))}
            </div>

            <div className="flex items-start gap-2">
              <div className="grid grid-rows-7 gap-1.5 text-[10px] font-mono text-[var(--ink-tertiary)] w-6 shrink-0 pt-0.5">
                <span className="h-[18px] leading-[18px]">Mon</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Wed</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Fri</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Sun</span>
              </div>

              <div className="flex gap-1.5">
                {weeks.map((col, wIdx) => (
                  <div key={wIdx} className="grid grid-rows-7 gap-1.5">
                    {col.map((day, dIdx) =>
                      day ? (
                        <button
                          key={day.date}
                          type="button"
                          onMouseEnter={() => setSelectedDay(day)}
                          onFocus={() => setSelectedDay(day)}
                          onClick={() => setSelectedDay(day)}
                          aria-label={`${day.date}: ${formatMoney(day.costUSD, currency)}, ${day.turns} turns`}
                          title={`${day.date} · ${formatMoney(day.costUSD, currency)} · ${fmtTokens(day.tokens)} tokens · ${day.turns} turns`}
                          className={`w-[18px] h-[18px] rounded-[4px] border transition-transform duration-150 hover:scale-115 cursor-pointer ${
                            HEATMAP_LEVEL_CLASSES[day.level]
                          } ${
                            highlightedDay?.date === day.date
                              ? 'ring-2 ring-[var(--ink-primary)]/70 scale-110'
                              : ''
                          }`}
                        />
                      ) : (
                        <span key={`empty-${wIdx}-${dIdx}`} className="w-[18px] h-[18px]" />
                      )
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-[10px] font-mono text-[var(--ink-tertiary)] pt-2 border-t border-[var(--border-hairline)]">
          <span>Tap or hover any square to inspect daily spend</span>
          <div className="flex items-center gap-1.5">
            <span>Cool</span>
            {([0, 1, 2, 3, 4] as const).map((lvl) => (
              <span
                key={lvl}
                className={`w-3 h-3 rounded-[3px] border inline-block ${HEATMAP_LEVEL_CLASSES[lvl]}`}
              />
            ))}
            <span>Peak Burn</span>
          </div>
        </div>
      </div>

      {/* Top Workspaces by Spend (1 col) */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex flex-col">
        <div className="mb-3.5">
          <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
            <FolderGit2 className="w-4 h-4 text-[var(--tool-antigravity)]" />
            Top Workspaces ({currency})
          </h2>
          <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
            Highest API spend by project · click to filter
          </p>
        </div>

        {topWorkspaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-[var(--ink-tertiary)] font-mono py-8">
            No workspace data in this filter.
          </div>
        ) : (
          <div className="space-y-2 flex-1">
            {topWorkspaces.map((ws) => {
              const barPct = Math.max(5, (ws.costUSD / maxWorkspaceCost) * 100);
              return (
                <button
                  key={ws.workspaceKey}
                  type="button"
                  onClick={() => onSelectWorkspace?.(ws.workspaceName)}
                  title={`${ws.workspace} — Click to filter table`}
                  className="w-full text-left group rounded-xl p-2 -mx-2 hover:bg-[var(--table-hover)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono tabular">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="flex items-center gap-0.5 shrink-0">
                        {ws.sources.map((src) => (
                          <span
                            key={src}
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: TOOL_DOT_VARS[src] }}
                            title={src}
                          />
                        ))}
                      </span>
                      <span className="text-[var(--ink-primary)] truncate font-medium">
                        {ws.workspaceName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[var(--accent-teal)] font-semibold">
                        {formatMoney(ws.costUSD, currency)}
                      </span>
                      <span className="text-[10px] text-[var(--ink-tertiary)] w-9 text-right">
                        {ws.sharePct.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-[var(--track-bg)] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${barPct}%`,
                        background: 'linear-gradient(90deg, var(--accent-teal) 0%, var(--tool-antigravity) 65%, var(--accent-flame) 100%)',
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
