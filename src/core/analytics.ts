import type { SessionStats, ToolSource, UsageTurn } from './types.js';

export type ToolFilter = 'all' | ToolSource;
export type TimeRange = '24h' | '7d' | '30d' | 'all';
export type Currency = 'USD' | 'EUR';

export const EUR_RATE = 0.92;

export function convertMoney(usdAmount: number, currency: Currency): number {
  return currency === 'EUR' ? usdAmount * EUR_RATE : usdAmount;
}

export function formatMoney(usdAmount: number, currency: Currency): string {
  const val = convertMoney(usdAmount, currency);
  const sym = currency === 'EUR' ? '€' : '$';
  if (val > 0 && val < 0.01) return `<${sym}0.01`;
  return `${sym}${val.toFixed(2)}`;
}

export function getCutoffMs(timeRange: TimeRange, now = Date.now()): number {
  switch (timeRange) {
    case '24h':
      return now - 24 * 3600 * 1000;
    case '7d':
      return now - 7 * 24 * 3600 * 1000;
    case '30d':
      return now - 30 * 24 * 3600 * 1000;
    case 'all':
      return 0;
  }
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
            t.model.toLowerCase().includes(query)
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

export function workspacesToCsv(workspaces: WorkspaceGroup[], currency: Currency): string {
  const headers = [
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
          convertMoney(chat.cacheSavingsUSD, currency).toFixed(4),
          convertMoney(chat.costUSD, currency).toFixed(4),
          chat.startedAt,
          chat.lastActiveAt,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
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
  } = {}
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

  const roundMoney = (usd: number) => Number(convertMoney(usd, currency).toFixed(4));

  const payload = {
    exportedAt: new Date().toISOString(),
    currency,
    eurRate: EUR_RATE,
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
      turns,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      cacheSavings: roundMoney(cacheSavingsUSD),
      apiCost: roundMoney(costUSD),
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
      chats: ws.chats.map((c) => ({
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
      })),
    })),
  };

  return JSON.stringify(payload, null, 2);
}
