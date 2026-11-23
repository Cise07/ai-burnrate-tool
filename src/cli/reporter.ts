import pc from 'picocolors';
import {
  buildWorkspaceGroups,
  convertMoney,
  convertSubscriptionMoney,
  filterSessions,
  formatMoney,
  formatSubscriptionMoney,
  getSessionModelBreakdown,
  getSessionSubagentBreakdown,
  getTaxLabel,
  workspacesToJson,
  type Currency,
  type TimeRange,
  type ToolFilter,
} from '../core/analytics.js';
import { isPromoActive } from '../core/pricing.js';
import type { BurnrateSnapshot } from '../core/types.js';

export interface CliReportOptions {
  currency?: Currency;
  toolFilter?: ToolFilter;
  timeRange?: TimeRange;
  json?: boolean;
}

function truncateLabel(text: string, maxLen: number, fromEnd = false): string {
  if (text.length <= maxLen) return text;
  if (fromEnd) return `…${text.slice(-(maxLen - 1))}`;
  return `${text.slice(0, maxLen - 1)}…`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function padRight(str: string, width: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= width) return str;
  return str + ' '.repeat(width - visible.length);
}

function padLeft(str: string, width: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= width) return str;
  return ' '.repeat(width - visible.length) + str;
}

export function printCliReport(snapshot: BurnrateSnapshot, options: CliReportOptions = {}): void {
  const currency: Currency = options.currency || 'USD';
  const toolFilter: ToolFilter = options.toolFilter || 'all';
  const timeRange: TimeRange = options.timeRange || 'all';
  const includeDeleted = snapshot.settings?.includeDeletedInTotals ?? true;
  const trackingStartAt = snapshot.settings?.trackingStartAt;

  const activeSessions = filterSessions(snapshot.sessions, { toolFilter, timeRange, trackingStartAt });
  const deletedSessions = filterSessions(snapshot.deletedSessions || [], {
    toolFilter,
    timeRange,
    trackingStartAt,
  });
  const trackedDeletedSessions = deletedSessions.filter((s) => !s.untrackedHistory);
  const allSessions = includeDeleted ? [...activeSessions, ...trackedDeletedSessions] : [...activeSessions];
  const workspaceGroups = buildWorkspaceGroups(activeSessions);

  if (options.json) {
    console.log(
      workspacesToJson(
        workspaceGroups,
        currency,
        { toolFilter, timeRange },
        includeDeleted ? deletedSessions : []
      )
    );
    return;
  }

  let totalCost = 0;
  let totalCacheSavings = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalTokens = 0;
  let deletedCost = 0;

  const byTool = {
    antigravity: { sessions: 0, turns: 0, input: 0, cache: 0, output: 0, tokens: 0, cost: 0, savings: 0 },
    claude: { sessions: 0, turns: 0, input: 0, cache: 0, output: 0, tokens: 0, cost: 0, savings: 0 },
    codex: { sessions: 0, turns: 0, input: 0, cache: 0, output: 0, tokens: 0, cost: 0, savings: 0 },
  };

  const byModel = new Map<
    string,
    { label: string; normalizedModel: string; turns: number; input: number; cache: number; output: number; tokens: number; cost: number; savings: number }
  >();

  for (const s of allSessions) {
    totalCost += s.costUSD;
    totalCacheSavings += s.cacheSavingsUSD;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    totalTokens += s.totalTokens;
    if (s.deleted) deletedCost += s.costUSD;

    const bucket = byTool[s.source];
    bucket.sessions += 1;
    bucket.turns += s.turns;
    bucket.input += s.inputTokens;
    bucket.cache += s.cacheReadTokens;
    bucket.output += s.outputTokens;
    bucket.tokens += s.totalTokens;
    bucket.cost += s.costUSD;
    bucket.savings += s.cacheSavingsUSD;

    for (const t of s.turnHistory) {
      const m = byModel.get(t.modelLabel) || {
        label: t.modelLabel,
        normalizedModel: t.normalizedModel,
        turns: 0,
        input: 0,
        cache: 0,
        output: 0,
        tokens: 0,
        cost: 0,
        savings: 0,
      };
      m.turns += 1;
      m.input += t.inputTokens;
      m.cache += t.cacheReadTokens;
      m.output += t.outputTokens;
      m.tokens += t.totalTokens;
      m.cost += t.costUSD;
      m.savings += t.cacheSavingsUSD;
      byModel.set(t.modelLabel, m);
    }
  }

  const subMonthly = snapshot.pricing.subscriptions.combinedMonthlyUSD || 40;
  const displayedCost = convertMoney(totalCost, currency);
  const displayedSub = convertSubscriptionMoney(subMonthly, currency);
  const subRatio = displayedSub > 0 ? ((displayedCost / displayedSub) * 100).toFixed(0) : '0';
  const activeFilters: string[] = [];
  if (toolFilter !== 'all') activeFilters.push(`Tool: ${toolFilter}`);
  if (timeRange !== 'all') activeFilters.push(`Range: ${timeRange}`);
  if (currency !== 'USD') activeFilters.push(`Currency: ${currency}`);

  console.log('');
  console.log(
    `${pc.bgGreen(pc.black(pc.bold(' AI-BURNRATE-TOOL ')))} ${pc.bold('Local Token & API Equivalent Cost Report')}${
      activeFilters.length > 0 ? `  ${pc.dim(`[${activeFilters.join(' • ')}]`)}` : ''
    }`
  );
  console.log(pc.dim(`Scanned: ${snapshot.watchedPaths.join('  •  ')}`));
  if (trackingStartAt) {
    const toolNames: Array<{ key: 'antigravity' | 'claude' | 'codex'; label: string }> = [
      { key: 'antigravity', label: 'Antigravity' },
      { key: 'claude', label: 'Claude Code' },
      { key: 'codex', label: 'Codex CLI' },
    ];
    const activeCutoffs = toolNames
      .filter((t) => (toolFilter === 'all' || toolFilter === t.key) && Boolean(trackingStartAt[t.key]))
      .map((t) => {
        const d = new Date(trackingStartAt[t.key]!);
        const formatted = Number.isNaN(d.getTime())
          ? trackingStartAt[t.key]!
          : d.toLocaleString(undefined, {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            });
        return `${t.label} >= ${formatted}`;
      });
    if (activeCutoffs.length > 0) {
      console.log(pc.yellow(`Tracking reset active: ${activeCutoffs.join('  •  ')}`));
    }
  }
  console.log(pc.dim('─'.repeat(104)));

  console.log(
    `  ${pc.bold('API Equiv. Spend:')} ${pc.green(pc.bold(formatMoney(totalCost, currency)))} ${pc.dim(`(${subRatio}% of ${formatSubscriptionMoney(subMonthly, currency)}/mo sub incl. ${getTaxLabel(currency)})`)}   ` +
      `${pc.bold('Cache Saved:')} ${pc.cyan(pc.bold(formatMoney(totalCacheSavings, currency)))}   ` +
      `${pc.bold('Total Tokens:')} ${pc.yellow(pc.bold(fmtTokens(totalTokens)))}   ` +
      `${pc.bold('Workspaces:')} ${pc.white(pc.bold(String(workspaceGroups.length)))}   ` +
      `${pc.bold('Chats:')} ${pc.white(pc.bold(String(activeSessions.length)))}${
        deletedSessions.length > 0
          ? pc.dim(
              deletedCost > 0
                ? ` (+${deletedSessions.length} deleted: ${formatMoney(deletedCost, currency)})`
                : ` (+${deletedSessions.length} deleted)`
            )
          : ''
      }`
  );
  console.log(
    `  ${pc.dim(`Input (Uncached): ${fmtTokens(totalInput)}  •  Cache Read (Context): ${fmtTokens(totalCacheRead)}  •  Output (Think+Resp): ${fmtTokens(totalOutput)}`)}`
  );
  console.log(pc.dim('─'.repeat(104)));

  // Tool Summary Table
  console.log(`\n${pc.bold(pc.white('  TOOL BREAKDOWN'))}`);
  console.log(
    `  ${padRight(pc.dim('Tool'), 18)} ${padLeft(pc.dim('Chats'), 6)} ${padLeft(pc.dim('Turns'), 7)} ${padLeft(pc.dim('Input'), 10)} ${padLeft(pc.dim('Cache Read'), 12)} ${padLeft(pc.dim('Output'), 10)} ${padLeft(pc.dim('Total Tok'), 11)} ${padLeft(pc.dim('Cache Saved'), 12)} ${padLeft(pc.dim('API Cost'), 10)}`
  );
  console.log(`  ${pc.dim('─'.repeat(102))}`);

  const toolRows: Array<{ label: string; data: typeof byTool.antigravity }> = [
    { label: pc.cyan('Antigravity CLI'), data: byTool.antigravity },
    { label: pc.magenta('Claude Code'), data: byTool.claude },
    { label: pc.yellow('Codex CLI'), data: byTool.codex },
  ];

  for (const row of toolRows) {
    console.log(
      `  ${padRight(row.label, 18)} ${padLeft(String(row.data.sessions), 6)} ${padLeft(String(row.data.turns), 7)} ${padLeft(fmtTokens(row.data.input), 10)} ${padLeft(pc.cyan(fmtTokens(row.data.cache)), 12)} ${padLeft(pc.yellow(fmtTokens(row.data.output)), 10)} ${padLeft(fmtTokens(row.data.tokens), 11)} ${padLeft(pc.cyan(formatMoney(row.data.savings, currency)), 12)} ${padLeft(pc.green(pc.bold(formatMoney(row.data.cost, currency))), 10)}`
    );
  }

  // Model Breakdown Table
  if (byModel.size > 0) {
    console.log(`\n${pc.bold(pc.white('  MODEL BREAKDOWN'))}`);
    console.log(
      `  ${padRight(pc.dim('Model'), 32)} ${padLeft(pc.dim('Turns'), 7)} ${padLeft(pc.dim('Input'), 10)} ${padLeft(pc.dim('Cache Read'), 12)} ${padLeft(pc.dim('Output'), 10)} ${padLeft(pc.dim('Total Tok'), 11)} ${padLeft(pc.dim('Cache Saved'), 12)} ${padLeft(pc.dim('API Cost'), 10)}`
    );
    console.log(`  ${pc.dim('─'.repeat(109))}`);

    const sortedModels = Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);
    let hasPromo = false;
    for (const m of sortedModels) {
      const rate =
        snapshot.pricing.models[m.normalizedModel] ||
        Object.values(snapshot.pricing.models).find(
          (r) => r.label === m.label || m.label.startsWith(r.label)
        );
      const isPromo = isPromoActive(rate);
      if (isPromo) hasPromo = true;
      const displayLabel = isPromo ? `${m.label} ${pc.yellow('★PROMO')}` : m.label;
      console.log(
        `  ${padRight(displayLabel, 32)} ${padLeft(String(m.turns), 7)} ${padLeft(fmtTokens(m.input), 10)} ${padLeft(pc.cyan(fmtTokens(m.cache)), 12)} ${padLeft(pc.yellow(fmtTokens(m.output)), 10)} ${padLeft(fmtTokens(m.tokens), 11)} ${padLeft(pc.cyan(formatMoney(m.savings, currency)), 12)} ${padLeft(pc.green(formatMoney(m.cost, currency)), 10)}`
      );
    }
    if (hasPromo) {
      console.log(`  ${pc.yellow('★')} ${pc.dim('Models with active Google AI Studio promotional rates.')}`);
    }
  }

  // Grouped Workspaces & Recent Chats Table
  console.log(`\n${pc.bold(pc.white('  WORKSPACES & RECENT CHATS'))}`);
  console.log(
    `  ${padRight(pc.dim('Tool'), 13)} ${padRight(pc.dim('Workspace / Chat'), 30)} ${padRight(pc.dim('Model(s)'), 18)} ${padLeft(pc.dim('Turns'), 6)} ${padLeft(pc.dim('Cache'), 8)} ${padLeft(pc.dim('Output'), 8)} ${padLeft(pc.dim('Cost'), 8)} ${padLeft(pc.dim('Modified'), 11)}`
  );
  console.log(`  ${pc.dim('─'.repeat(108))}`);

  const maxWorkspaces = 10;
  const maxChatsPerWorkspace = 4;

  for (const ws of workspaceGroups.slice(0, maxWorkspaces)) {
    const formatToolShort = (src: string) =>
      src === 'antigravity'
        ? pc.cyan('AGY')
        : src === 'claude'
          ? pc.magenta('CLD')
          : pc.yellow('CDX');
    const formatToolLong = (src: string) =>
      src === 'antigravity'
        ? pc.cyan('Antigravity')
        : src === 'claude'
          ? pc.magenta('Claude Code')
          : pc.yellow('Codex CLI');
    const wsToolLabel =
      ws.sources.length > 1
        ? ws.sources.map(formatToolShort).join(pc.dim('+'))
        : formatToolLong(ws.sources[0]);
    const wsLabel = `${truncateLabel(ws.workspaceName, 21, true)} ${pc.dim(`(${ws.chats.length})`)}`;
    const extraModelCount = Math.max(0, ws.distinctModels.length - 1);
    const wsModel = truncateLabel(
      extraModelCount > 0 ? `${ws.primaryModelLabel} +${extraModelCount}` : ws.primaryModelLabel,
      17
    );
    const modDate = ws.lastActiveAt ? ws.lastActiveAt.slice(0, 10) : '-';

    console.log(
      `  ${padRight(wsToolLabel, 13)} ${padRight(pc.bold(wsLabel), 30)} ${padRight(wsModel, 18)} ${padLeft(String(ws.turns), 6)} ${padLeft(pc.cyan(fmtTokens(ws.cacheReadTokens)), 8)} ${padLeft(pc.yellow(fmtTokens(ws.outputTokens)), 8)} ${padLeft(pc.green(pc.bold(formatMoney(ws.costUSD, currency))), 8)} ${padLeft(pc.dim(modDate), 11)}`
    );

    const shownChats = ws.chats.slice(0, maxChatsPerWorkspace);
    const hiddenChats = ws.chats.length - shownChats.length;

    for (let i = 0; i < shownChats.length; i++) {
      const chat = shownChats[i];
      const isLastLine = i === shownChats.length - 1 && hiddenChats === 0;
      const branch = pc.dim(isLastLine ? '└─' : '├─');
      const chatSourceTag =
        ws.sources.length > 1
          ? chat.source === 'antigravity'
            ? pc.cyan('[AGY]')
            : chat.source === 'claude'
              ? pc.magenta('[CLD]')
              : pc.yellow('[CDX]')
          : '';
      const rawTitle = chat.sessionTitle || chat.sessionId;
      const subSummary = getSessionSubagentBreakdown(chat.turnHistory);
      const subTag =
        subSummary.subagents.length > 0
          ? ` ${pc.magenta(`+${subSummary.subagents.length}sub`)}`
          : '';
      const chatTitle = `${branch} ${truncateLabel(rawTitle, subSummary.subagents.length > 0 ? 20 : 26)}${subTag}`;
      const chatModels = getSessionModelBreakdown(chat.turnHistory);
      const chatModelStr = truncateLabel(
        chatModels.length > 1
          ? `${chatModels[0].modelLabel} +${chatModels.length - 1}`
          : chat.primaryModelLabel,
        17
      );
      const chatDate = chat.lastActiveAt ? chat.lastActiveAt.slice(0, 10) : '-';

      console.log(
        `  ${padRight(chatSourceTag, 13)} ${padRight(chatTitle, 30)} ${padRight(pc.dim(chatModelStr), 18)} ${padLeft(pc.dim(String(chat.turns)), 6)} ${padLeft(pc.dim(fmtTokens(chat.cacheReadTokens)), 8)} ${padLeft(pc.dim(fmtTokens(chat.outputTokens)), 8)} ${padLeft(pc.dim(formatMoney(chat.costUSD, currency)), 8)} ${padLeft(pc.dim(chatDate), 11)}`
      );

      if (subSummary.subagents.length > 0) {
        const subPrefix = isLastLine ? '   ' : `${pc.dim('│')}  `;
        for (let j = 0; j < subSummary.subagents.length; j++) {
          const sub = subSummary.subagents[j];
          const subBranch = pc.dim(j === subSummary.subagents.length - 1 ? '└─' : '├─');
          const isBtw = sub.subagentName === '/btw';
          const subTagCol = isBtw ? pc.cyan('[BTW]') : pc.magenta('[SUB]');
          const singleBtwTitle =
            isBtw && sub.runs && sub.runs.length === 1 && sub.runs[0].title !== '/btw'
              ? `/btw: ${sub.runs[0].title}`
              : isBtw && sub.runs && sub.runs.length > 1
                ? `/btw (${sub.runs.length})`
                : sub.subagentName;
          const subLabel = `${subPrefix}${subBranch} ${(isBtw ? pc.cyan : pc.magenta)(truncateLabel(singleBtwTitle, 21))}`;
          const subModelStr = truncateLabel(
            sub.models.length > 1
              ? `${sub.models[0].modelLabel} +${sub.models.length - 1}`
              : sub.models[0]?.modelLabel || '-',
            17
          );
          console.log(
            `  ${padRight(subTagCol, 13)} ${padRight(subLabel, 30)} ${padRight(pc.dim(subModelStr), 18)} ${padLeft(pc.dim(String(sub.turns)), 6)} ${padLeft(pc.dim(fmtTokens(sub.cacheReadTokens)), 8)} ${padLeft(pc.dim(fmtTokens(sub.outputTokens)), 8)} ${padLeft(pc.dim(formatMoney(sub.costUSD, currency)), 8)} ${padLeft(pc.dim(''), 11)}`
          );
          if (isBtw && sub.runs && sub.runs.length > 1) {
            const runPrefix = `${subPrefix}${j === subSummary.subagents.length - 1 ? '   ' : `${pc.dim('│')}  `}`;
            for (let rIdx = 0; rIdx < sub.runs.length; rIdx++) {
              const run = sub.runs[rIdx];
              const runBranch = pc.dim(rIdx === sub.runs.length - 1 ? '└─' : '├─');
              const runLabel = `${runPrefix}${runBranch} ${pc.dim(truncateLabel(run.title, 18))}`;
              const runModelStr = truncateLabel(run.models[0]?.modelLabel || '-', 17);
              console.log(
                `  ${padRight('', 13)} ${padRight(runLabel, 30)} ${padRight(pc.dim(runModelStr), 18)} ${padLeft(pc.dim(String(run.turns)), 6)} ${padLeft(pc.dim(fmtTokens(run.cacheReadTokens)), 8)} ${padLeft(pc.dim(fmtTokens(run.outputTokens)), 8)} ${padLeft(pc.dim(formatMoney(run.costUSD, currency)), 8)} ${padLeft(pc.dim(''), 11)}`
              );
            }
          }
        }
      }
    }

    if (hiddenChats > 0) {
      console.log(`  ${padRight('', 13)} ${pc.dim(`└─ +${hiddenChats} more chat(s)`)}`);
    }
  }

  if (workspaceGroups.length > maxWorkspaces) {
    console.log(
      `\n  ${pc.dim(`Showing ${maxWorkspaces} of ${workspaceGroups.length} workspaces (open the web dashboard or pass --json for full list).`)}`
    );
  }

  if (deletedSessions.length > 0) {
    console.log(`\n${pc.bold(pc.white('  DELETED CHATS (PRESERVED API SPEND)'))}`);
    console.log(
      `  ${padRight(pc.dim('Tool'), 13)} ${padRight(pc.dim('Chat Title'), 30)} ${padRight(pc.dim('Workspace'), 20)} ${padLeft(pc.dim('Turns'), 6)} ${padLeft(pc.dim('Tokens'), 10)} ${padLeft(pc.dim('API Cost'), 10)} ${padLeft(pc.dim('Deleted'), 11)}`
    );
    console.log(`  ${pc.dim('─'.repeat(106))}`);
    for (const chat of deletedSessions.slice(0, 8)) {
      const toolLabel =
        chat.source === 'antigravity'
          ? pc.cyan('Antigravity')
          : chat.source === 'claude'
            ? pc.magenta('Claude Code')
            : pc.yellow('Codex CLI');
      const title = truncateLabel(chat.sessionTitle || chat.sessionId, 29);
      const ws = truncateLabel(chat.workspaceName, 19, true);
      const delDate = (chat.deletedAt || chat.lastActiveAt || '').slice(0, 10) || '-';
      const tokStr = chat.untrackedHistory ? pc.dim('N/A') : fmtTokens(chat.totalTokens);
      const costStr = chat.untrackedHistory ? pc.dim('N/A') : pc.green(formatMoney(chat.costUSD, currency));
      console.log(
        `  ${padRight(toolLabel, 13)} ${padRight(title, 30)} ${padRight(pc.dim(ws), 20)} ${padLeft(String(chat.turns), 6)} ${padLeft(tokStr, 10)} ${padLeft(costStr, 10)} ${padLeft(pc.dim(delDate), 11)}`
      );
    }
    if (deletedSessions.length > 8) {
      console.log(`  ${pc.dim(`+${deletedSessions.length - 8} more deleted chat(s) in web dashboard popup.`)}`);
    }
  }

  console.log('');
}
