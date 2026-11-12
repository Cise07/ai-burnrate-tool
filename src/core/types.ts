export type ToolSource = 'antigravity' | 'claude';

export interface ModelRate {
  label: string;
  provider: 'anthropic' | 'google' | string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
    combinedMonthlyUSD: number;
  };
  models: Record<string, ModelRate>;
  history?: RateSnapshot[];
  defaults: {
    claude: string;
    antigravity: string;
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
}

export interface SessionStats {
  sessionId: string;
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
}

export interface BurnrateSnapshot {
  generatedAt: string;
  watchedPaths: string[];
  pricing: PricingConfig;
  sessions: SessionStats[];
}
