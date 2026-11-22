import type { SessionStats, ToolSource, UsageTurn } from './types.js';

export type ToolFilter = 'all' | ToolSource;
export type TimeRange = '24h' | '7d' | '30d' | 'all';
export type Currency = 'USD' | 'EUR';

export const EUR_RATE = 0.92;
export const EUR_TAX_RATE = 0.22; // 22% VAT (IVA) on subscriptions
export const USD_TAX_RATE = 0.075; // ~7.5% average US sales tax on subscriptions

export function getTaxRate(currency: Currency): number {
  return currency === 'EUR' ? EUR_TAX_RATE : USD_TAX_RATE;
}

export function getTaxLabel(currency: Currency): string {
  return currency === 'EUR' ? 'IVA 22%' : 'Tax 7.5%';
}

export function convertMoney(usdAmount: number, currency: Currency, eurRate = EUR_RATE): number {
  return currency === 'EUR' ? usdAmount * eurRate : usdAmount;
}

export function formatMoney(usdAmount: number, currency: Currency, eurRate = EUR_RATE): string {
  const val = convertMoney(usdAmount, currency, eurRate);
  const sym = currency === 'EUR' ? '€' : '$';
  if (val > 0 && val < 0.01) return `<${sym}0.01`;
  return `${sym}${val.toFixed(2)}`;
}

export function getSubscriptionMultiplier(currency: Currency, eurRate = EUR_RATE): number {
  return currency === 'EUR' ? eurRate * (1 + EUR_TAX_RATE) : 1 + USD_TAX_RATE;
}

export function convertSubscriptionMoney(usdAmount: number, currency: Currency, eurRate = EUR_RATE): number {
  return usdAmount * getSubscriptionMultiplier(currency, eurRate);
}

export function formatSubscriptionMoney(usdAmount: number, currency: Currency, eurRate = EUR_RATE): string {
  const val = convertSubscriptionMoney(usdAmount, currency, eurRate);
  const sym = currency === 'EUR' ? '€' : '$';
  if (val > 0 && val < 0.01) return `<${sym}0.01`;
  return `${sym}${val.toFixed(2)}`;
}

export function getWindowDurationMs(timeRange: TimeRange): number {
  switch (timeRange) {
    case '24h':
      return 24 * 3600 * 1000;
    case '7d':
      return 7 * 24 * 3600 * 1000;
    case '30d':
      return 30 * 24 * 3600 * 1000;
    case 'all':
      return 0;
  }
}

export function getCutoffMs(timeRange: TimeRange, now = Date.now()): number {
  const duration = getWindowDurationMs(timeRange);
  return duration > 0 ? now - duration : 0;
}

export function getPreviousWindowBounds(
  timeRange: TimeRange,
  now = Date.now()
): { startMs: number; endMs: number; label: string } | null {
  const duration = getWindowDurationMs(timeRange);
  if (duration <= 0) return null;
  return {
    startMs: now - duration * 2,
    endMs: now - duration,
    label: `prev ${timeRange}`,
  };
}

export function filterSessionsInWindow(
  sessions: SessionStats[],
  options: {
    toolFilter?: ToolFilter;
    startMs: number;
    endMs: number;
  }
): SessionStats[] {
  const { toolFilter = 'all', startMs, endMs } = options;
  const filtered: SessionStats[] = [];

  for (const session of sessions) {
    if (toolFilter !== 'all' && session.source !== toolFilter) continue;
    if (session.untrackedHistory) continue;

    const validTurns = session.turnHistory.filter((t) => {
      const ts = new Date(t.timestamp).getTime();
      return !Number.isNaN(ts) && ts >= startMs && ts < endMs;
    });
    if (validTurns.length === 0) continue;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costUSD = 0;
    let cacheSavingsUSD = 0;
    for (const t of validTurns) {
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
      cacheReadTokens += t.cacheReadTokens;
      cacheWriteTokens += t.cacheWriteTokens;
      totalTokens += t.totalTokens;
      costUSD += t.costUSD;
      cacheSavingsUSD += t.cacheSavingsUSD;
    }

    filtered.push({
      ...session,
      turns: validTurns.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUSD,
      cacheSavingsUSD,
      turnHistory: validTurns,
    });
  }
  return filtered;
}

export interface SessionModelItem {
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

export interface SessionSubagentItem {
  subagentId: string;
  subagentName: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  models: SessionModelItem[];
}

export interface SessionSubagentSummary {
  main: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    costUSD: number;
    cacheSavingsUSD: number;
  };
  subagents: SessionSubagentItem[];
}

export function getSessionSubagentBreakdown(turnHistory: UsageTurn[]): SessionSubagentSummary {
  const main = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
  const map = new Map<string, { name: string; turns: UsageTurn[] }>();

  for (const t of turnHistory) {
    if (!t.subagentId && !t.subagentName) {
      main.turns += 1;
      main.inputTokens += t.inputTokens;
      main.outputTokens += t.outputTokens;
      main.cacheReadTokens += t.cacheReadTokens;
      main.totalTokens += t.totalTokens;
      main.costUSD += t.costUSD;
      main.cacheSavingsUSD += t.cacheSavingsUSD;
      continue;
    }
    const id = t.subagentId || t.subagentName || 'subagent';
    const name = t.subagentName || id;
    const entry = map.get(id) || { name, turns: [] };
    entry.turns.push(t);
    map.set(id, entry);
  }

  const subagents: SessionSubagentItem[] = [];
  for (const [subagentId, info] of map.entries()) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let totalTokens = 0;
    let costUSD = 0;
    let cacheSavingsUSD = 0;
    for (const t of info.turns) {
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
      cacheReadTokens += t.cacheReadTokens;
      totalTokens += t.totalTokens;
      costUSD += t.costUSD;
      cacheSavingsUSD += t.cacheSavingsUSD;
    }
    subagents.push({
      subagentId,
      subagentName: info.name,
      turns: info.turns.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      costUSD,
      cacheSavingsUSD,
      models: getSessionModelBreakdown(info.turns),
    });
  }

  subagents.sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns);
  return { main, subagents };
}

export function getSessionModelBreakdown(turnHistory: UsageTurn[]): SessionModelItem[] {
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

export interface WorkspaceGroup {
  workspaceKey: string;
  workspace: string;
  workspaceName: string;
  sources: ToolSource[];
  chats: SessionStats[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  startedAt: string;
  lastActiveAt: string;
  primaryModelLabel: string;
  distinctModels: string[];
}

export function normalizeWorkspaceKey(workspacePath: string): string {
  const cleaned = (workspacePath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return cleaned ? cleaned.toLowerCase() : 'global / cli';
}

export type WorkspaceSortField =
  | 'lastActiveAt'
  | 'startedAt'
  | 'totalTokens'
  | 'ioTokens'
  | 'cacheReadTokens'
  | 'cacheSavingsUSD'
  | 'costUSD'
  | 'turns'
  | 'chats'
  | 'workspaceName'
  | 'primaryModelLabel'
  | 'tool';
export type SortDirection = 'asc' | 'desc';

export function filterSessions(
  sessions: SessionStats[],
  options: {
    toolFilter?: ToolFilter;
    timeRange?: TimeRange;
    searchQuery?: string;
    modelFilter?: string;
  } = {}
): SessionStats[] {
  const { toolFilter = 'all', timeRange = 'all', searchQuery = '', modelFilter = 'all' } = options;
  const cutoffMs = getCutoffMs(timeRange);
  const query = searchQuery.trim().toLowerCase();
  const targetModel = modelFilter && modelFilter !== 'all' ? modelFilter.toLowerCase() : '';
  const filtered: SessionStats[] = [];

  for (const session of sessions) {
    if (toolFilter !== 'all' && session.source !== toolFilter) continue;

    if (session.untrackedHistory) {
      if (targetModel) continue;
      if (cutoffMs > 0) {
        const ts = new Date(session.deletedAt || session.lastActiveAt || session.startedAt).getTime();
        if (Number.isNaN(ts) || ts < cutoffMs) continue;
      }
      if (query) {
        const matchesQuery =
          session.workspaceName.toLowerCase().includes(query) ||
          session.workspace.toLowerCase().includes(query) ||
          (session.sessionTitle || '').toLowerCase().includes(query) ||
          session.sessionId.toLowerCase().includes(query) ||
          session.source.toLowerCase().includes(query);
        if (!matchesQuery) continue;
      }
      filtered.push(session);
      continue;
    }

    let validTurns =
      cutoffMs > 0
        ? session.turnHistory.filter((t) => {
            const ts = new Date(t.timestamp).getTime();
            return !Number.isNaN(ts) && ts >= cutoffMs;
          })
        : session.turnHistory;

    if (targetModel) {
      validTurns = validTurns.filter((t) => {
        const label = (t.modelLabel || t.normalizedModel || t.model || '').toLowerCase();
        return label === targetModel;
      });
    }

    if (validTurns.length === 0) continue;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costUSD = 0;
    let cacheSavingsUSD = 0;
    let minTs = '';
    let maxTs = '';

    for (const t of validTurns) {
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
      cacheReadTokens += t.cacheReadTokens;
      cacheWriteTokens += t.cacheWriteTokens;
      totalTokens += t.totalTokens;
      costUSD += t.costUSD;
      cacheSavingsUSD += t.cacheSavingsUSD;
      if (t.timestamp) {
        if (!minTs || t.timestamp < minTs) minTs = t.timestamp;
        if (!maxTs || t.timestamp > maxTs) maxTs = t.timestamp;
      }
    }

    const chatPrimaryModel =
      getSessionModelBreakdown(validTurns)[0]?.modelLabel || session.primaryModelLabel;
    const isTurnScoped = cutoffMs > 0 || Boolean(targetModel);

    const scopedSession: SessionStats = {
      ...session,
      primaryModelLabel: chatPrimaryModel,
      turns: validTurns.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUSD,
      cacheSavingsUSD,
      startedAt: (isTurnScoped && minTs) || session.startedAt,
      lastActiveAt: (isTurnScoped && maxTs) || session.lastActiveAt,
      turnHistory: validTurns,
    };

    if (query) {
      const matchesQuery =
        scopedSession.workspaceName.toLowerCase().includes(query) ||
        scopedSession.workspace.toLowerCase().includes(query) ||
        (scopedSession.sessionTitle || '').toLowerCase().includes(query) ||
        scopedSession.primaryModelLabel.toLowerCase().includes(query) ||
        scopedSession.sessionId.toLowerCase().includes(query) ||
        scopedSession.source.toLowerCase().includes(query) ||
        scopedSession.turnHistory.some(
          (t) =>
            t.modelLabel.toLowerCase().includes(query) ||
            t.normalizedModel.toLowerCase().includes(query) ||
            t.model.toLowerCase().includes(query) ||
            (t.subagentName || '').toLowerCase().includes(query)
        );
      if (!matchesQuery) continue;
    }

    filtered.push(scopedSession);
  }

  return filtered;
}

export function buildWorkspaceGroups(sessions: SessionStats[]): WorkspaceGroup[] {
  const map = new Map<
    string,
    {
      workspaceKey: string;
      workspace: string;
      workspaceName: string;
      sourceSet: Set<ToolSource>;
      chats: SessionStats[];
      turns: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUSD: number;
      cacheSavingsUSD: number;
      startedAt: string;
      lastActiveAt: string;
      modelStats: Map<string, { turns: number; costUSD: number }>;
    }
  >();

  for (const s of sessions) {
    const key = normalizeWorkspaceKey(s.workspace);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        workspaceKey: key,
        workspace: s.workspace,
        workspaceName: s.workspaceName,
        sourceSet: new Set<ToolSource>(),
        chats: [],
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        cacheSavingsUSD: 0,
        startedAt: s.startedAt,
        lastActiveAt: s.lastActiveAt,
        modelStats: new Map(),
      };
      map.set(key, entry);
    }

    entry.sourceSet.add(s.source);
    entry.chats.push(s);
    entry.turns += s.turns;
    entry.inputTokens += s.inputTokens;
    entry.outputTokens += s.outputTokens;
    entry.cacheReadTokens += s.cacheReadTokens;
    entry.cacheWriteTokens += s.cacheWriteTokens;
    entry.totalTokens += s.totalTokens;
    entry.costUSD += s.costUSD;
    entry.cacheSavingsUSD += s.cacheSavingsUSD;

    if (s.startedAt && (!entry.startedAt || s.startedAt < entry.startedAt)) {
      entry.startedAt = s.startedAt;
    }
    if (s.lastActiveAt && (!entry.lastActiveAt || s.lastActiveAt > entry.lastActiveAt)) {
      entry.lastActiveAt = s.lastActiveAt;
    }

    for (const t of s.turnHistory) {
      const label = t.modelLabel || t.normalizedModel || 'Unknown';
      const prev = entry.modelStats.get(label) || { turns: 0, costUSD: 0 };
      prev.turns += 1;
      prev.costUSD += t.costUSD;
      entry.modelStats.set(label, prev);
    }
  }

  const groups: WorkspaceGroup[] = [];
  for (const entry of map.values()) {
    entry.chats.sort((a, b) => (b.lastActiveAt > a.lastActiveAt ? 1 : -1));
    const orderedModels = Array.from(entry.modelStats.entries()).sort(
      (a, b) => b[1].costUSD - a[1].costUSD || b[1].turns - a[1].turns
    );
    const topByTurns = Array.from(entry.modelStats.entries()).sort(
      (a, b) => b[1].turns - a[1].turns || b[1].costUSD - a[1].costUSD
    );

    const sources: ToolSource[] = [];
    if (entry.sourceSet.has('antigravity')) sources.push('antigravity');
    if (entry.sourceSet.has('claude')) sources.push('claude');
    if (entry.sourceSet.has('codex')) sources.push('codex');

    groups.push({
      workspaceKey: entry.workspaceKey,
      workspace: entry.workspace,
      workspaceName: entry.workspaceName,
      sources,
      chats: entry.chats,
      turns: entry.turns,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      totalTokens: entry.totalTokens,
      costUSD: entry.costUSD,
      cacheSavingsUSD: entry.cacheSavingsUSD,
      startedAt: entry.startedAt,
      lastActiveAt: entry.lastActiveAt,
      primaryModelLabel: topByTurns[0]?.[0] || entry.chats[0]?.primaryModelLabel || 'Unknown',
      distinctModels: orderedModels.map(([label]) => label),
    });
  }

  return groups.sort((a, b) => (b.lastActiveAt > a.lastActiveAt ? 1 : -1));
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function getWorkspaceSortKey(ws: WorkspaceGroup, field: WorkspaceSortField): string | number {
  switch (field) {
    case 'lastActiveAt':
      return ws.lastActiveAt || '';
    case 'startedAt':
      return ws.startedAt || '';
    case 'totalTokens':
      return ws.totalTokens;
    case 'ioTokens':
      return ws.inputTokens + ws.outputTokens;
    case 'cacheReadTokens':
      return ws.cacheReadTokens;
    case 'cacheSavingsUSD':
      return ws.cacheSavingsUSD;
    case 'costUSD':
      return ws.costUSD;
    case 'turns':
      return ws.turns;
    case 'chats':
      return ws.chats.length;
    case 'workspaceName':
      return ws.workspaceName;
    case 'primaryModelLabel':
      return ws.primaryModelLabel;
    case 'tool':
      return ws.sources.join(',');
  }
}

function getChatSortKey(chat: SessionStats, field: WorkspaceSortField): string | number {
  switch (field) {
    case 'lastActiveAt':
    case 'chats':
      return chat.lastActiveAt || '';
    case 'startedAt':
      return chat.startedAt || '';
    case 'totalTokens':
      return chat.totalTokens;
    case 'ioTokens':
      return chat.inputTokens + chat.outputTokens;
    case 'cacheReadTokens':
      return chat.cacheReadTokens;
    case 'cacheSavingsUSD':
      return chat.cacheSavingsUSD;
    case 'costUSD':
      return chat.costUSD;
    case 'turns':
      return chat.turns;
    case 'workspaceName':
      return chat.sessionTitle || chat.sessionId;
    case 'primaryModelLabel':
      return chat.primaryModelLabel;
    case 'tool':
      return chat.source;
  }
}

export function sortWorkspaceGroups(
  groups: WorkspaceGroup[],
  sortBy: WorkspaceSortField = 'lastActiveAt',
  direction: SortDirection = 'desc'
): WorkspaceGroup[] {
  const dir = direction === 'asc' ? 1 : -1;
  return groups
    .map((ws) => ({
      ...ws,
      chats: [...ws.chats].sort((a, b) => {
        const cmp = compareValues(getChatSortKey(a, sortBy), getChatSortKey(b, sortBy));
        return cmp !== 0 ? cmp * dir : compareValues(b.lastActiveAt || '', a.lastActiveAt || '');
      }),
    }))
    .sort((a, b) => {
      const cmp = compareValues(getWorkspaceSortKey(a, sortBy), getWorkspaceSortKey(b, sortBy));
      return cmp !== 0 ? cmp * dir : compareValues(b.lastActiveAt || '', a.lastActiveAt || '');
    });
}

function escapeCsvCell(value: string | number): string {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function workspacesToCsv(
  workspaces: WorkspaceGroup[],
  currency: Currency,
  deletedSessions: SessionStats[] = [],
  eurRate = EUR_RATE
): string {
  const headers = [
    'Status',
    'Workspace',
    'Workspace Path',
    'Chat Title',
    'Session ID',
    'Tool',
    'Primary Model',
    'Models Used',
    'Turns',
    'Input Tokens',
    'Cache Read Tokens',
    'Output Tokens',
    'Total Tokens',
    `Cache Savings (${currency})`,
    `API Cost (${currency})`,
    'Started At',
    'Last Active At',
  ];

  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const ws of workspaces) {
    for (const chat of ws.chats) {
      const models = getSessionModelBreakdown(chat.turnHistory)
        .map((m) => m.modelLabel)
        .join(' | ');
      lines.push(
        [
          'active',
          ws.workspaceName,
          ws.workspace,
          chat.sessionTitle || chat.sessionId,
          chat.sessionId,
          chat.source,
          chat.primaryModelLabel,
          models,
          chat.turns,
          chat.inputTokens,
          chat.cacheReadTokens,
          chat.outputTokens,
          chat.totalTokens,
          convertMoney(chat.cacheSavingsUSD, currency, eurRate).toFixed(4),
          convertMoney(chat.costUSD, currency, eurRate).toFixed(4),
          chat.startedAt,
          chat.lastActiveAt,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
  }

  for (const chat of deletedSessions) {
    if (chat.untrackedHistory) continue;
    const models = getSessionModelBreakdown(chat.turnHistory)
      .map((m) => m.modelLabel)
      .join(' | ');
    lines.push(
      [
        'deleted',
        chat.workspaceName,
        chat.workspace,
        chat.sessionTitle || chat.sessionId,
        chat.sessionId,
        chat.source,
        chat.primaryModelLabel,
        models,
        chat.turns,
        chat.inputTokens,
        chat.cacheReadTokens,
        chat.outputTokens,
        chat.totalTokens,
        convertMoney(chat.cacheSavingsUSD, currency, eurRate).toFixed(4),
        convertMoney(chat.costUSD, currency, eurRate).toFixed(4),
        chat.startedAt,
        chat.deletedAt || chat.lastActiveAt,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  return lines.join('\r\n');
}

export function workspacesToJson(
  workspaces: WorkspaceGroup[],
  currency: Currency,
  filters: {
    toolFilter?: ToolFilter;
    timeRange?: TimeRange;
    modelFilter?: string;
    searchQuery?: string;
    sortBy?: WorkspaceSortField;
    sortDir?: SortDirection;
  } = {},
  deletedSessions: SessionStats[] = [],
  eurRate = EUR_RATE
): string {
  let chats = 0;
  let turns = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUSD = 0;
  let cacheSavingsUSD = 0;

  for (const ws of workspaces) {
    chats += ws.chats.length;
    turns += ws.turns;
    inputTokens += ws.inputTokens;
    cacheReadTokens += ws.cacheReadTokens;
    outputTokens += ws.outputTokens;
    totalTokens += ws.totalTokens;
    costUSD += ws.costUSD;
    cacheSavingsUSD += ws.cacheSavingsUSD;
  }

  let deletedTurns = 0;
  let deletedInputTokens = 0;
  let deletedCacheReadTokens = 0;
  let deletedOutputTokens = 0;
  let deletedTotalTokens = 0;
  let deletedCostUSD = 0;
  let deletedCacheSavingsUSD = 0;

  for (const d of deletedSessions) {
    if (d.untrackedHistory) continue;
    deletedTurns += d.turns;
    deletedInputTokens += d.inputTokens;
    deletedCacheReadTokens += d.cacheReadTokens;
    deletedOutputTokens += d.outputTokens;
    deletedTotalTokens += d.totalTokens;
    deletedCostUSD += d.costUSD;
    deletedCacheSavingsUSD += d.cacheSavingsUSD;
  }

  const roundMoney = (usd: number) => Number(convertMoney(usd, currency, eurRate).toFixed(4));

  const payload = {
    exportedAt: new Date().toISOString(),
    currency,
    eurRate,
    filters: {
      tool: filters.toolFilter || 'all',
      range: filters.timeRange || 'all',
      model: filters.modelFilter || 'all',
      query: filters.searchQuery || '',
      sortBy: filters.sortBy || 'lastActiveAt',
      sortDir: filters.sortDir || 'desc',
    },
    summary: {
      workspaces: workspaces.length,
      chats,
      deletedChats: deletedSessions.length,
      turns: turns + deletedTurns,
      inputTokens: inputTokens + deletedInputTokens,
      cacheReadTokens: cacheReadTokens + deletedCacheReadTokens,
      outputTokens: outputTokens + deletedOutputTokens,
      totalTokens: totalTokens + deletedTotalTokens,
      cacheSavings: roundMoney(cacheSavingsUSD + deletedCacheSavingsUSD),
      apiCost: roundMoney(costUSD + deletedCostUSD),
      deletedApiCost: roundMoney(deletedCostUSD),
    },
    workspaces: workspaces.map((ws) => ({
      workspaceName: ws.workspaceName,
      workspace: ws.workspace,
      sources: ws.sources,
      primaryModel: ws.primaryModelLabel,
      distinctModels: ws.distinctModels,
      turns: ws.turns,
      inputTokens: ws.inputTokens,
      cacheReadTokens: ws.cacheReadTokens,
      outputTokens: ws.outputTokens,
      totalTokens: ws.totalTokens,
      cacheSavings: roundMoney(ws.cacheSavingsUSD),
      apiCost: roundMoney(ws.costUSD),
      startedAt: ws.startedAt,
      lastActiveAt: ws.lastActiveAt,
      chats: ws.chats.map((c) => {
        const subagentSummary = getSessionSubagentBreakdown(c.turnHistory);
        return {
          sessionId: c.sessionId,
          sessionTitle: c.sessionTitle || c.sessionId,
          source: c.source,
          primaryModel: c.primaryModelLabel,
          turns: c.turns,
          inputTokens: c.inputTokens,
          cacheReadTokens: c.cacheReadTokens,
          outputTokens: c.outputTokens,
          totalTokens: c.totalTokens,
          cacheSavings: roundMoney(c.cacheSavingsUSD),
          apiCost: roundMoney(c.costUSD),
          startedAt: c.startedAt,
          lastActiveAt: c.lastActiveAt,
          models: getSessionModelBreakdown(c.turnHistory).map((m) => ({
            model: m.modelLabel,
            turns: m.turns,
            inputTokens: m.inputTokens,
            cacheReadTokens: m.cacheReadTokens,
            outputTokens: m.outputTokens,
            totalTokens: m.totalTokens,
            cacheSavings: roundMoney(m.cacheSavingsUSD),
            apiCost: roundMoney(m.costUSD),
          })),
          ...(subagentSummary.subagents.length > 0
            ? {
                subagents: subagentSummary.subagents.map((sub) => ({
                  subagentId: sub.subagentId,
                  subagentName: sub.subagentName,
                  turns: sub.turns,
                  inputTokens: sub.inputTokens,
                  cacheReadTokens: sub.cacheReadTokens,
                  outputTokens: sub.outputTokens,
                  totalTokens: sub.totalTokens,
                  cacheSavings: roundMoney(sub.cacheSavingsUSD),
                  apiCost: roundMoney(sub.costUSD),
                  models: sub.models.map((m) => m.modelLabel),
                })),
              }
            : {}),
        };
      }),
    })),
    ...(deletedSessions.length > 0
      ? {
          deletedChats: deletedSessions.map((c) => ({
            sessionId: c.sessionId,
            sessionTitle: c.sessionTitle || c.sessionId,
            workspaceName: c.workspaceName,
            workspace: c.workspace,
            source: c.source,
            primaryModel: c.primaryModelLabel,
            turns: c.turns,
            totalTokens: c.totalTokens,
            cacheSavings: roundMoney(c.cacheSavingsUSD),
            apiCost: roundMoney(c.costUSD),
            deletedAt: c.deletedAt || c.lastActiveAt,
            untrackedHistory: Boolean(c.untrackedHistory),
          })),
        }
      : {}),
  };

  return JSON.stringify(payload, null, 2);
}

export interface MonthlyProjection {
  todayUSD: number;
  last7dUSD: number;
  last30dUSD: number;
  dailyAvgUSD: number;
  projectedMonthlyUSD: number;
  sampleDays: number;
}

export function computeMonthlyProjection(sessions: SessionStats[], now = Date.now()): MonthlyProjection {
  const dayMs = 24 * 3600 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStartMs = startOfToday.getTime();
  const sevenDaysAgoMs = now - 7 * dayMs;
  const thirtyDaysAgoMs = now - 30 * dayMs;

  let todayUSD = 0;
  let last7dUSD = 0;
  let last30dUSD = 0;
  let earliestTurnMs = Infinity;

  for (const s of sessions) {
    if (s.untrackedHistory) continue;
    for (const t of s.turnHistory) {
      const ts = new Date(t.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts < earliestTurnMs) earliestTurnMs = ts;
      if (ts >= todayStartMs) todayUSD += t.costUSD;
      if (ts >= sevenDaysAgoMs) last7dUSD += t.costUSD;
      if (ts >= thirtyDaysAgoMs) last30dUSD += t.costUSD;
    }
  }

  const spanDays = Number.isFinite(earliestTurnMs)
    ? Math.max(1, Math.min(7, Math.ceil((now - earliestTurnMs) / dayMs)))
    : 1;
  const dailyAvgUSD = last7dUSD / spanDays;
  const projectedMonthlyUSD = dailyAvgUSD * 30;

  return {
    todayUSD,
    last7dUSD,
    last30dUSD,
    dailyAvgUSD,
    projectedMonthlyUSD,
    sampleDays: spanDays,
  };
}

export interface HeatmapDay {
  date: string;
  dayOfWeek: number; // 0 = Mon .. 6 = Sun
  weekIndex: number;
  costUSD: number;
  tokens: number;
  turns: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export function computeDailyHeatmap(sessions: SessionStats[], weeks = 13, now = Date.now()): HeatmapDay[] {
  const dailyMap = new Map<string, { costUSD: number; tokens: number; turns: number }>();

  for (const s of sessions) {
    if (s.untrackedHistory) continue;
    for (const t of s.turnHistory) {
      if (!t.timestamp) continue;
      const dayKey = t.timestamp.slice(0, 10);
      const prev = dailyMap.get(dayKey) || { costUSD: 0, tokens: 0, turns: 0 };
      prev.costUSD += t.costUSD;
      prev.tokens += t.totalTokens;
      prev.turns += 1;
      dailyMap.set(dayKey, prev);
    }
  }

  // Align end date to the Sunday of the current week or today, starting on a Monday `weeks` weeks back
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const jsDow = today.getDay(); // 0=Sun..6=Sat
  const monDow = (jsDow + 6) % 7; // 0=Mon..6=Sun
  const totalDays = (weeks - 1) * 7 + monDow + 1;

  const startDate = new Date(today.getTime() - (totalDays - 1) * 24 * 3600 * 1000);
  const rawDays: Array<{
    date: string;
    dayOfWeek: number;
    weekIndex: number;
    costUSD: number;
    tokens: number;
    turns: number;
  }> = [];

  let maxCost = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate.getTime() + i * 24 * 3600 * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const stats = dailyMap.get(key) || { costUSD: 0, tokens: 0, turns: 0 };
    if (stats.costUSD > maxCost) maxCost = stats.costUSD;
    rawDays.push({
      date: key,
      dayOfWeek: i % 7,
      weekIndex: Math.floor(i / 7),
      ...stats,
    });
  }

  return rawDays.map((d) => {
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (d.costUSD > 0 && maxCost > 0) {
      const ratio = d.costUSD / maxCost;
      if (ratio >= 0.72) level = 4;
      else if (ratio >= 0.42) level = 3;
      else if (ratio >= 0.16) level = 2;
      else level = 1;
    }
    return { ...d, level };
  });
}

export interface TopWorkspaceItem {
  workspaceKey: string;
  workspaceName: string;
  workspace: string;
  sources: ToolSource[];
  chats: number;
  turns: number;
  tokens: number;
  costUSD: number;
  sharePct: number;
}

export function computeTopWorkspaces(sessions: SessionStats[], limit = 7): TopWorkspaceItem[] {
  const groups = buildWorkspaceGroups(sessions.filter((s) => !s.untrackedHistory));
  const totalCost = groups.reduce((acc, g) => acc + g.costUSD, 0);
  return groups
    .sort((a, b) => b.costUSD - a.costUSD)
    .slice(0, limit)
    .map((g) => ({
      workspaceKey: g.workspaceKey,
      workspaceName: g.workspaceName,
      workspace: g.workspace,
      sources: g.sources,
      chats: g.chats.length,
      turns: g.turns,
      tokens: g.totalTokens,
      costUSD: g.costUSD,
      sharePct: totalCost > 0 ? (g.costUSD / totalCost) * 100 : 0,
    }));
}
