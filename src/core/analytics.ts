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

export function filterSessions(
  sessions: SessionStats[],
  options: {
    toolFilter?: ToolFilter;
    timeRange?: TimeRange;
    searchQuery?: string;
  } = {}
): SessionStats[] {
  const { toolFilter = 'all', timeRange = 'all', searchQuery = '' } = options;
  const cutoffMs = getCutoffMs(timeRange);
  const query = searchQuery.trim().toLowerCase();
  const filtered: SessionStats[] = [];

  for (const session of sessions) {
    if (toolFilter !== 'all' && session.source !== toolFilter) continue;

    const validTurns =
      cutoffMs > 0
        ? session.turnHistory.filter((t) => {
            const ts = new Date(t.timestamp).getTime();
            return !Number.isNaN(ts) && ts >= cutoffMs;
          })
        : session.turnHistory;

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

    const chatPrimaryModel =
      getSessionModelBreakdown(validTurns)[0]?.modelLabel || session.primaryModelLabel;

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
  filters: { toolFilter?: ToolFilter; timeRange?: TimeRange; searchQuery?: string } = {}
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
      query: filters.searchQuery || '',
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
