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
  0: 'bg-zinc-900/90 border-zinc-800/70',
  1: 'bg-emerald-950/90 border-emerald-800/60',
  2: 'bg-emerald-700/75 border-emerald-500/50',
  3: 'bg-emerald-500/85 border-emerald-400/70',
  4: 'bg-cyan-400 border-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.45)]',
};

const TOOL_DOT_COLORS: Record<ToolSource, string> = {
  antigravity: 'bg-cyan-400',
  claude: 'bg-fuchsia-400',
  codex: 'bg-amber-400',
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
      className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-burn-fade-up"
      style={{ animationDelay: '75ms' }}
    >
      {/* Daily Activity Heatmap (2 cols) */}
      <div className="lg:col-span-2 rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-4 sm:p-5 flex flex-col justify-between gap-4 transition-colors duration-200 hover:border-zinc-700/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-emerald-400" />
              Activity Heatmap (Last 13 Weeks)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Daily API equivalent burn intensity · {activeDaysCount} active {activeDaysCount === 1 ? 'day' : 'days'}
            </p>
          </div>

          {highlightedDay && (
            <div className="px-2.5 py-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800/90 text-[11px] font-mono flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <span className="text-zinc-300 font-semibold">{highlightedDay.date}</span>
              <span className="text-emerald-400 font-bold">
                {formatMoney(highlightedDay.costUSD, currency)}
              </span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-400">{fmtTokens(highlightedDay.tokens)} tok</span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-400">{highlightedDay.turns}t</span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="inline-flex flex-col gap-1.5 min-w-full">
            {/* Month labels */}
            <div className="flex items-center pl-8 text-[10px] font-mono text-zinc-500 h-4 relative">
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
              {/* Day-of-week column */}
              <div className="grid grid-rows-7 gap-1.5 text-[10px] font-mono text-zinc-500 w-6 shrink-0 pt-0.5">
                <span className="h-[18px] leading-[18px]">Mon</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Wed</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Fri</span>
                <span className="h-[18px]" />
                <span className="h-[18px] leading-[18px]">Sun</span>
              </div>

              {/* 13-week grid */}
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
                          className={`w-[18px] h-[18px] rounded-[4px] border transition-transform duration-150 hover:scale-115 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
                            HEATMAP_LEVEL_CLASSES[day.level]
                          } ${
                            highlightedDay?.date === day.date ? 'ring-1 ring-white/70 scale-110' : ''
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

        {/* Legend */}
        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pt-1 border-t border-zinc-800/60">
          <span>Tap or hover any square to inspect daily spend</span>
          <div className="flex items-center gap-1.5">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map((lvl) => (
              <span
                key={lvl}
                className={`w-3 h-3 rounded-[3px] border inline-block ${HEATMAP_LEVEL_CLASSES[lvl]}`}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>

      {/* Top Workspaces by Spend (1 col) */}
      <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-4 sm:p-5 flex flex-col transition-colors duration-200 hover:border-zinc-700/80">
        <div className="mb-3.5">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <FolderGit2 className="w-4 h-4 text-cyan-400" />
            Top Workspaces ({currency})
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Highest API spend by project · click to filter
          </p>
        </div>

        {topWorkspaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-zinc-500 font-mono py-8">
            No workspace data in this filter.
          </div>
        ) : (
          <div className="space-y-2.5 flex-1">
            {topWorkspaces.map((ws) => {
              const barPct = Math.max(5, (ws.costUSD / maxWorkspaceCost) * 100);
              return (
                <button
                  key={ws.workspaceKey}
                  type="button"
                  onClick={() => onSelectWorkspace?.(ws.workspaceName)}
                  title={`${ws.workspace} — Click to filter table`}
                  className="w-full text-left group rounded-lg p-2 -mx-2 hover:bg-zinc-800/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="flex items-center gap-0.5 shrink-0">
                        {ws.sources.map((src) => (
                          <span
                            key={src}
                            className={`h-1.5 w-1.5 rounded-full ${TOOL_DOT_COLORS[src]}`}
                            title={src}
                          />
                        ))}
                      </span>
                      <span className="text-zinc-200 group-hover:text-white truncate font-medium">
                        {ws.workspaceName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-emerald-400 font-semibold">
                        {formatMoney(ws.costUSD, currency)}
                      </span>
                      <span className="text-[10px] text-zinc-500 w-9 text-right">
                        {ws.sharePct.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-zinc-800/90 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-500"
                      style={{ width: `${barPct}%` }}
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
