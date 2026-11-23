export type ToolSource = 'antigravity' | 'claude' | 'codex';

export type DashboardSectionId =
  | 'kpis'
  | 'charts'
  | 'modelUsage'
  | 'heatmapWorkspaces'
  | 'sessions';

export interface DashboardLayoutSettings {
  order: DashboardSectionId[];
  hidden: DashboardSectionId[];
}

export interface UserSettings {
  subscriptions: {
    antigravity: number;
    claude: number;
    codex: number;
  };
  includeDeletedInTotals: boolean;
  layout: DashboardLayoutSettings;
}

export interface HooksStatus {
  antigravity: boolean;
  claude: boolean;
  codex?: boolean;
}

export interface LongContextTier {
  thresholdTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelRate {
  label: string;
  provider: 'anthropic' | 'google' | string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  longContext?: LongContextTier;
  isPromo?: boolean;
  promoStart?: string;
  promoEnd?: string;
  promoNote?: string;
  standardInput?: number;
  standardOutput?: number;
  standardCacheRead?: number;
  standardCacheWrite?: number;
}

export interface RateSnapshot {
  effectiveFrom: string;
  source?: string;
  models: Record<string, ModelRate>;
}

export interface PricingConfig {
  updatedAt: string;
  currency: string;
  unit: string;
  subscriptions: {
    claude_max: { name: string; monthlyUSD: number };
    antigravity_pro: { name: string; monthlyUSD: number };
    codex_plus?: { name: string; monthlyUSD: number };
    combinedMonthlyUSD: number;
  };
  models: Record<string, ModelRate>;
  history?: RateSnapshot[];
  defaults: {
    claude: string;
    antigravity: string;
    codex?: string;
  };
}

export interface UsageTurn {
  timestamp: string;
  model: string;
  normalizedModel: string;
  modelLabel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  estimated: boolean;
  subagentId?: string;
  subagentName?: string;
  subagentTitle?: string;
}

export interface SessionStats {
  sessionId: string;
  sessionTitle: string;
  source: ToolSource;
  workspace: string;
  workspaceName: string;
  filePath: string;
  startedAt: string;
  lastActiveAt: string;
  primaryModel: string;
  primaryModelLabel: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  estimatedTurns: number;
  turnHistory: UsageTurn[];
  deleted?: boolean;
  deletedAt?: string;
  untrackedHistory?: boolean;
}

export interface BurnrateSnapshot {
  generatedAt: string;
  watchedPaths: string[];
  pricing: PricingConfig;
  sessions: SessionStats[];
  deletedSessions?: SessionStats[];
  dismissedLegacyCount?: number;
  settings?: UserSettings;
  hooksStatus?: HooksStatus;
}
