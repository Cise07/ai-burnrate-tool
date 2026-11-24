export type ToolKey = 'antigravity' | 'claude' | 'codex';
export type ToolFilter = 'all' | ToolKey;
export type TimeRange = '24h' | '7d' | '30d' | 'all';
export type Currency = 'USD' | 'EUR';

export const EUR_RATE = 0.92;
export const EUR_TAX = 0.22;
export const USD_TAX = 0.075;

export function formatApiMoney(usd: number, currency: Currency): string {
  const val = currency === 'EUR' ? usd * EUR_RATE : usd;
  const sym = currency === 'EUR' ? '€' : '$';
  if (val > 0 && val < 0.01) return `<${sym}0.01`;
  return `${sym}${val.toFixed(2)}`;
}

export function formatSubMoney(usdNet: number, currency: Currency): string {
  const mult = currency === 'EUR' ? EUR_RATE * (1 + EUR_TAX) : 1 + USD_TAX;
  const sym = currency === 'EUR' ? '€' : '$';
  return `${sym}${(usdNet * mult).toFixed(2)}`;
}

export function formatRateMoney(usd: number, currency: Currency): string {
  const val = currency === 'EUR' ? usd * EUR_RATE : usd;
  const sym = currency === 'EUR' ? '€' : '$';
  if (val < 1) return `${sym}${val.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `${sym}${val.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export interface DemoTurn {
  id: string;
  daysAgo: number; // 0 = today, 1..42
  dayIndex: number; // 0..13 slot on 14-day chart (13 = today)
  modelLabel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  subagentName?: string;
  subagentTitle?: string;
}

export interface DemoSession {
  id: string;
  workspaceName: string;
  title: string;
  source: ToolKey;
  primaryModel: string;
  turns: DemoTurn[];
}

export const DEMO_DAYS = [
  'Nov 11',
  'Nov 12',
  'Nov 13',
  'Nov 14',
  'Nov 15',
  'Nov 16',
  'Nov 17',
  'Nov 18',
  'Nov 19',
  'Nov 20',
  'Nov 21',
  'Nov 22',
  'Nov 23',
  'Today',
];

export const DEMO_SUBSCRIPTIONS: Record<ToolKey, number> = {
  antigravity: 19.99,
  claude: 100,
  codex: 20,
};

export function isWithinTimeRange(daysAgo: number, range: TimeRange): boolean {
  if (range === '24h') return daysAgo === 0;
  if (range === '7d') return daysAgo <= 6;
  if (range === '30d') return daysAgo <= 29;
  return true;
}

// Synthetic sample telemetry mirroring real Burnrate multi-tool transcripts
export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: 'demo-claude-billing',
    workspaceName: 'saas-billing-engine',
    title: 'Stripe webhook idempotency & proration engine',
    source: 'claude',
    primaryModel: 'Claude Opus 4.5+',
    turns: [
      {
        id: 'c0',
        daysAgo: 35,
        dayIndex: 0,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 215000,
        outputTokens: 61000,
        cacheReadTokens: 2950000,
        costUSD: 23.4,
        cacheSavingsUSD: 51.2,
      },
      {
        id: 'c1',
        daysAgo: 12,
        dayIndex: 1,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 168000,
        outputTokens: 42000,
        cacheReadTokens: 1920000,
        costUSD: 14.2,
        cacheSavingsUSD: 28.4,
      },
      {
        id: 'c2',
        daysAgo: 9,
        dayIndex: 4,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 210000,
        outputTokens: 64000,
        cacheReadTokens: 2850000,
        costUSD: 24.6,
        cacheSavingsUSD: 54.1,
      },
      {
        id: 'c3',
        daysAgo: 6,
        dayIndex: 7,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 195000,
        outputTokens: 58000,
        cacheReadTokens: 2420000,
        costUSD: 21.8,
        cacheSavingsUSD: 46.2,
      },
      {
        id: 'c4',
        daysAgo: 3,
        dayIndex: 10,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 152000,
        outputTokens: 48000,
        cacheReadTokens: 2180000,
        costUSD: 16.4,
        cacheSavingsUSD: 33.8,
      },
      {
        id: 'c5',
        daysAgo: 1,
        dayIndex: 12,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 184000,
        outputTokens: 51000,
        cacheReadTokens: 2650000,
        costUSD: 19.7,
        cacheSavingsUSD: 42.9,
      },
      {
        id: 'c6',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 44000,
        outputTokens: 16800,
        cacheReadTokens: 640000,
        costUSD: 4.18,
        cacheSavingsUSD: 9.6,
      },
      {
        id: 'c7',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 14200,
        outputTokens: 4900,
        cacheReadTokens: 210000,
        costUSD: 0.78,
        cacheSavingsUSD: 1.94,
        subagentName: 'Explore',
        subagentTitle: 'Audit idempotency key locks in checkout worker',
      },
      {
        id: 'c8',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 6400,
        outputTokens: 2100,
        cacheReadTokens: 185000,
        costUSD: 0.34,
        cacheSavingsUSD: 0.92,
        subagentName: '/btw',
        subagentTitle: 'Check Stripe webhook retry backoff schedule',
      },
      {
        id: 'c9',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 5800,
        outputTokens: 1900,
        cacheReadTokens: 192000,
        costUSD: 0.31,
        cacheSavingsUSD: 0.88,
        subagentName: '/btw',
        subagentTitle: 'Verify EU VAT proration rounding rules',
      },
    ],
  },
  {
    id: 'demo-agy-portal',
    workspaceName: 'saas-billing-engine',
    title: 'Invoice timeline charts & billing portal views',
    source: 'antigravity',
    primaryModel: 'Gemini 4 Argon',
    turns: [
      {
        id: 'a0',
        daysAgo: 38,
        dayIndex: 0,
        modelLabel: 'Gemini Pro',
        inputTokens: 280000,
        outputTokens: 70000,
        cacheReadTokens: 2700000,
        costUSD: 10.6,
        cacheSavingsUSD: 17.4,
      },
      {
        id: 'a1',
        daysAgo: 13,
        dayIndex: 0,
        modelLabel: 'Gemini 4 Argon',
        inputTokens: 240000,
        outputTokens: 62000,
        cacheReadTokens: 2400000,
        costUSD: 8.6,
        cacheSavingsUSD: 14.4,
      },
      {
        id: 'a2',
        daysAgo: 10,
        dayIndex: 3,
        modelLabel: 'Gemini Pro',
        inputTokens: 310000,
        outputTokens: 78000,
        cacheReadTokens: 3100000,
        costUSD: 11.4,
        cacheSavingsUSD: 19.2,
      },
      {
        id: 'a3',
        daysAgo: 7,
        dayIndex: 6,
        modelLabel: 'Gemini 4 Argon',
        inputTokens: 280000,
        outputTokens: 71000,
        cacheReadTokens: 2800000,
        costUSD: 9.8,
        cacheSavingsUSD: 16.5,
      },
      {
        id: 'a4',
        daysAgo: 4,
        dayIndex: 9,
        modelLabel: 'Gemini Pro',
        inputTokens: 360000,
        outputTokens: 84000,
        cacheReadTokens: 3400000,
        costUSD: 12.9,
        cacheSavingsUSD: 21.8,
      },
      {
        id: 'a5',
        daysAgo: 2,
        dayIndex: 11,
        modelLabel: 'Gemini 4 Argon',
        inputTokens: 225000,
        outputTokens: 54000,
        cacheReadTokens: 2150000,
        costUSD: 7.4,
        cacheSavingsUSD: 12.9,
      },
      {
        id: 'a6',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'Gemini 4 Argon',
        inputTokens: 82000,
        outputTokens: 21400,
        cacheReadTokens: 960000,
        costUSD: 2.86,
        cacheSavingsUSD: 5.1,
      },
    ],
  },
  {
    id: 'demo-codex-voice',
    workspaceName: 'realtime-voice-agent',
    title: 'WebRTC PCM audio pipeline & low-latency VAD',
    source: 'codex',
    primaryModel: 'GPT-6.2 Sol',
    turns: [
      {
        id: 'x1',
        daysAgo: 11,
        dayIndex: 2,
        modelLabel: 'GPT-6.2 Sol',
        inputTokens: 190000,
        outputTokens: 54000,
        cacheReadTokens: 2200000,
        costUSD: 7.9,
        cacheSavingsUSD: 16.2,
      },
      {
        id: 'x2',
        daysAgo: 8,
        dayIndex: 5,
        modelLabel: 'GPT-6.2 Astra',
        inputTokens: 145000,
        outputTokens: 42000,
        cacheReadTokens: 1950000,
        costUSD: 15.8,
        cacheSavingsUSD: 34.4,
      },
      {
        id: 'x3',
        daysAgo: 5,
        dayIndex: 8,
        modelLabel: 'GPT-6.2 Sol',
        inputTokens: 215000,
        outputTokens: 61000,
        cacheReadTokens: 2680000,
        costUSD: 9.1,
        cacheSavingsUSD: 18.8,
      },
      {
        id: 'x4',
        daysAgo: 1,
        dayIndex: 12,
        modelLabel: 'GPT-6.2 Sol',
        inputTokens: 170000,
        outputTokens: 48000,
        cacheReadTokens: 2050000,
        costUSD: 7.2,
        cacheSavingsUSD: 14.9,
      },
      {
        id: 'x5',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'GPT-6.2 Sol',
        inputTokens: 68000,
        outputTokens: 19500,
        cacheReadTokens: 820000,
        costUSD: 2.94,
        cacheSavingsUSD: 6.1,
      },
      {
        id: 'x6',
        daysAgo: 0,
        dayIndex: 13,
        modelLabel: 'GPT-6.2 Sol',
        inputTokens: 12400,
        outputTokens: 3200,
        cacheReadTokens: 148000,
        costUSD: 0.42,
        cacheSavingsUSD: 1.05,
        subagentName: '/btw',
        subagentTitle: 'Opus 20ms vs 40ms jitter buffer trade-off',
      },
    ],
  },
  {
    id: 'demo-claude-sdk',
    workspaceName: 'mobile-checkout-sdk',
    title: 'Biometric payment token vault & offline queue',
    source: 'claude',
    primaryModel: 'Claude Sonnet 4.x',
    turns: [
      {
        id: 'm1',
        daysAgo: 10,
        dayIndex: 3,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 162000,
        outputTokens: 49000,
        cacheReadTokens: 2140000,
        costUSD: 15.1,
        cacheSavingsUSD: 30.2,
      },
      {
        id: 'm2',
        daysAgo: 5,
        dayIndex: 8,
        modelLabel: 'Claude Opus 4.5+',
        inputTokens: 144000,
        outputTokens: 41000,
        cacheReadTokens: 1920000,
        costUSD: 17.6,
        cacheSavingsUSD: 38.4,
      },
      {
        id: 'm3',
        daysAgo: 2,
        dayIndex: 11,
        modelLabel: 'Claude Sonnet 4.x',
        inputTokens: 138000,
        outputTokens: 37000,
        cacheReadTokens: 1840000,
        costUSD: 12.9,
        cacheSavingsUSD: 26.8,
      },
    ],
  },
];

// Deterministic 13-week (91-day) synthetic heatmap matching src/web/components/HeatmapAndWorkspaces.tsx
export interface SampleHeatmapDay {
  date: string;
  weekIndex: number;
  dayOfWeek: number; // 0=Mon..6=Sun
  costUSD: number;
  tokens: number;
  turns: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export const SAMPLE_HEATMAP_DAYS: SampleHeatmapDay[] = (() => {
  const days: SampleHeatmapDay[] = [];
  const baseDate = new Date(Date.UTC(2026, 7, 31)); // Monday Aug 31, 2026 -> 13 weeks to Nov 29
  for (let i = 0; i < 91; i++) {
    const d = new Date(baseDate.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const weekIndex = Math.floor(i / 7);
    const dayOfWeek = i % 7;
    const isWeekend = dayOfWeek >= 5;
    const wave = (i * 17 + weekIndex * 11 + dayOfWeek * 5) % 19;
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (isWeekend) {
      level = wave > 14 ? 2 : wave > 9 ? 1 : 0;
    } else if (wave < 3) {
      level = 0;
    } else if (wave < 8) {
      level = 1;
    } else if (wave < 13) {
      level = 2;
    } else if (wave < 17) {
      level = 3;
    } else {
      level = 4;
    }
    const mult = level === 0 ? 0 : level === 1 ? 3.4 : level === 2 ? 9.8 : level === 3 ? 19.6 : 34.2;
    const costUSD = level === 0 ? 0 : Number((mult + (wave % 5) * 0.85).toFixed(2));
    const turns = level === 0 ? 0 : level * 6 + (wave % 5);
    const tokens = turns * 185_000;
    days.push({ date: iso, weekIndex, dayOfWeek, costUSD, tokens, turns, level });
  }
  return days;
})();

export interface SampleTopWorkspace {
  name: string;
  path: string;
  sources: ToolKey[];
  chats: number;
  turns: number;
  tokens: number;
  costUSD: number;
}

export const SAMPLE_TOP_WORKSPACES: SampleTopWorkspace[] = [
  {
    name: 'saas-billing-engine',
    path: '~/projects/saas-billing-engine',
    sources: ['claude', 'antigravity'],
    chats: 9,
    turns: 142,
    tokens: 34_800_000,
    costUSD: 148.62,
  },
  {
    name: 'realtime-voice-agent',
    path: '~/projects/realtime-voice-agent',
    sources: ['codex', 'antigravity'],
    chats: 6,
    turns: 88,
    tokens: 21_400_000,
    costUSD: 74.18,
  },
  {
    name: 'mobile-checkout-sdk',
    path: '~/projects/mobile-checkout-sdk',
    sources: ['claude'],
    chats: 5,
    turns: 64,
    tokens: 15_900_000,
    costUSD: 58.4,
  },
  {
    name: 'infra-terraform-modules',
    path: '~/projects/infra-terraform-modules',
    sources: ['codex'],
    chats: 3,
    turns: 37,
    tokens: 8_200_000,
    costUSD: 26.15,
  },
  {
    name: 'analytics-clickhouse-etl',
    path: '~/projects/analytics-clickhouse-etl',
    sources: ['antigravity'],
    chats: 2,
    turns: 29,
    tokens: 6_450_000,
    costUSD: 14.9,
  },
];

export interface PricingRow {
  id: string;
  label: string;
  provider: 'anthropic' | 'google' | 'openai';
  providerLabel: string;
  input: number;
  cacheRead: number;
  output: number;
  longContextLabel: string;
  note: string;
}

// Verified directly from config/pricing.json
export const PRICING_CATALOG: PricingRow[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    input: 4.0,
    cacheRead: 0.2,
    output: 20.0,
    longContextLabel: 'Flat rate',
    note: '95% cache discount',
  },
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5+',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    input: 5.0,
    cacheRead: 0.5,
    output: 25.0,
    longContextLabel: 'Flat rate',
    note: '90% cache discount',
  },
  {
    id: 'claude-sonnet-4',
    label: 'Claude Sonnet 4.x',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    input: 3.0,
    cacheRead: 0.3,
    output: 15.0,
    longContextLabel: 'Flat rate',
    note: 'Default Claude Code model',
  },
  {
    id: 'claude-haiku-4',
    label: 'Claude Haiku 4.x',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    input: 1.0,
    cacheRead: 0.1,
    output: 5.0,
    longContextLabel: 'Flat rate',
    note: 'Fast subagent tier',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon / Carbon',
    provider: 'google',
    providerLabel: 'Google AI',
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    longContextLabel: 'Flat rate',
    note: 'Launch promo tracked with window dates',
  },
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    provider: 'google',
    providerLabel: 'Google AI',
    input: 3.0,
    cacheRead: 0.15,
    output: 15.0,
    longContextLabel: 'Flat rate',
    note: 'High-reasoning Google tier',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    providerLabel: 'Google AI',
    input: 1.25,
    cacheRead: 0.125,
    output: 10.0,
    longContextLabel: '>200k ctx: 2x in/cache, 1.5x out',
    note: 'Per-request context tiering',
  },
  {
    id: 'gpt-6.2-astra',
    label: 'GPT-6.2 Astra',
    provider: 'openai',
    providerLabel: 'OpenAI / Codex',
    input: 8.0,
    cacheRead: 0.4,
    output: 40.0,
    longContextLabel: '>272k ctx: 2x in/cache, 1.5x out',
    note: 'Flagship Codex reasoning model',
  },
  {
    id: 'gpt-6.2-sol',
    label: 'GPT-6.2 Sol',
    provider: 'openai',
    providerLabel: 'OpenAI / Codex',
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    longContextLabel: '>272k ctx: 2x in/cache, 1.5x out',
    note: 'Everyday Codex CLI model',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    provider: 'openai',
    providerLabel: 'OpenAI / Codex',
    input: 10.0,
    cacheRead: 1.0,
    output: 50.0,
    longContextLabel: '>272k ctx: 2x in/cache, 1.5x out',
    note: 'Per-request context tiering',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    provider: 'openai',
    providerLabel: 'OpenAI / Codex',
    input: 0.1,
    cacheRead: 0.01,
    output: 0.5,
    longContextLabel: '>272k ctx: 2x in/cache, 1.5x out',
    note: 'Ultra-low-cost Codex tier',
  },
];

export interface CliFlagRow {
  flag: string;
  category: 'dashboard' | 'reset' | 'hooks';
  categoryLabel: string;
  summary: string;
}

export const CLI_FLAGS: CliFlagRow[] = [
  {
    flag: 'burn',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Sync pricing, ensure offline hooks, bind 0.0.0.0 + mDNS + 6-digit PIN/QR, and open live dashboard.',
  },
  {
    flag: 'burn --cli',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Print colorized ANSI tables (Tool, Model, Workspaces, Chats, Subagents & /btw) and exit.',
  },
  {
    flag: 'burn --eur',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Display net API spend and VAT-adjusted subscriptions in EUR across Web UI and CLI.',
  },
  {
    flag: 'burn --tool <tool>',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Filter report by all, antigravity, claude, or codex.',
  },
  {
    flag: 'burn --range <range>',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Restrict calculations to 24h, 7d, 30d, or all.',
  },
  {
    flag: 'burn --cli --json',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Emit structured JSON with summary totals, workspaces, chats, subagents, and deleted chats.',
  },
  {
    flag: 'burn -p, --port <number>',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Bind dashboard to a custom port (defaults to 4321 with automatic free-port fallback).',
  },
  {
    flag: 'burn --no-open',
    category: 'dashboard',
    categoryLabel: 'Dashboard & CLI',
    summary: 'Run the live SSE server and file watcher headless without launching a browser window.',
  },
  {
    flag: 'burn --reset-tool <tool>',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Start counting spend from now (or --since <date>) for one tool or all without touching chat files.',
  },
  {
    flag: 'burn --restore-tool <tool>',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Restore full spend history from the beginning, or resume from a chosen --since <date>.',
  },
  {
    flag: 'burn --since <date>',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Custom YYYY-MM-DD or ISO-8601 cutoff timestamp paired with --reset-tool or --restore-tool.',
  },
  {
    flag: 'burn --export-backup [file]',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Snapshot live logs and export ~/.burnrate (sessions, pricing history & settings) into one JSON bundle.',
  },
  {
    flag: 'burn --import-backup <file>',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Restore a Burnrate backup bundle using safe Merge mode by default (preserves newer local data).',
  },
  {
    flag: 'burn --replace',
    category: 'reset',
    categoryLabel: 'Reset & Backup',
    summary: 'Pair with --import-backup <file> to overwrite local ~/.burnrate state instead of merging.',
  },
  {
    flag: 'burn --no-hooks',
    category: 'hooks',
    categoryLabel: 'Hooks & Maintenance',
    summary: 'Skip installing Antigravity, Claude Code, and Codex CLI offline auto-archive hooks.',
  },
  {
    flag: 'burn --uninstall-hooks',
    category: 'hooks',
    categoryLabel: 'Hooks & Maintenance',
    summary: 'Remove ai-burnrate-tool entries from tool hook configs while keeping custom hooks intact.',
  },
  {
    flag: 'burn --sync-ledger',
    category: 'hooks',
    categoryLabel: 'Hooks & Maintenance',
    summary: 'Internal hook fast-path: snapshots active turn to ledger and spawns detached --sync-pricing every 30m.',
  },
  {
    flag: 'burn --sync-pricing',
    category: 'hooks',
    categoryLabel: 'Hooks & Maintenance',
    summary: 'Internal background worker: conditional ETag check (304 Not Modified) updating pricing-ledger.json.',
  },
  {
    flag: 'burn --update / --uninstall',
    category: 'hooks',
    categoryLabel: 'Hooks & Maintenance',
    summary: 'Self-update to the latest npm release or cleanly remove hooks and uninstall globally.',
  },
];

export const HOOK_MATRIX = [
  {
    tool: 'Antigravity CLI',
    colorClass: 'text-cyanTool',
    configPath: '~/.gemini/config/hooks.json',
    events: 'Stop (5s)',
    scope: 'Main chats, subagents & ephemeral /btw side-chats',
  },
  {
    tool: 'Claude Code',
    colorClass: 'text-claudeTool',
    configPath: '~/.claude/settings.json',
    events: 'Stop (5s), SubagentStop (5s), SessionEnd (5s)',
    scope: 'Project JSONL sessions, /subagents/*.jsonl & /btw turns',
  },
  {
    tool: 'Codex CLI',
    colorClass: 'text-codexTool',
    configPath: '~/.codex/hooks.json',
    events: 'Stop (5s), SubagentStop (5s), SessionEnd (3s)',
    scope: 'Rollout threads, forked /btw & /side sessions, archived_sessions/',
  },
];

export const ENV_OVERRIDES = [
  { name: 'BURNRATE_GEMINI_DIR', desc: 'Custom Antigravity root instead of ~/.gemini' },
  { name: 'BURNRATE_CLAUDE_DIR', desc: 'Custom Claude Code root instead of ~/.claude' },
  { name: 'BURNRATE_CODEX_DIR / CODEX_HOME', desc: 'Custom Codex CLI root instead of ~/.codex' },
  { name: 'BURNRATE_SETTINGS_PATH', desc: 'Override ~/.burnrate/settings.json location' },
];

export const FAQ_ITEMS = [
  {
    q: 'Does ai-burnrate-tool send my prompts, code, or spend data to any server?',
    a: 'No. Every transcript parser, SQLite/JSONL reader, pricing calculator, and dashboard server runs strictly on your machine. The only outbound request is a read-only conditional HTTP GET (with ETag / 304 Not Modified) to fetch public model price tables from LiteLLM and GitHub.',
  },
  {
    q: 'How do offline hooks archive chats without running a background daemon?',
    a: 'Burnrate registers lightweight commands in the native hook configs of AI CLIs already installed on your PC (~/.gemini/config/hooks.json, ~/.claude/settings.json, ~/.codex/hooks.json). When a turn ends, the CLI calls burn --sync-ledger, which reads only the changed transcript, writes atomically to ~/.burnrate/sessions-ledger.json, and exits immediately.',
  },
  {
    q: 'What happens when I reset a tool from a specific date and later resume or delete an older chat?',
    a: 'Tool resets filter strictly per turn (turn.timestamp >= trackingStartAt[tool]) without touching files in ~/.claude, ~/.gemini, or ~/.codex. Old turns stay at $0.00 while new turns count normally — even if you later delete that mixed chat, only post-reset turns appear in totals and Deleted Chats. You can resume from any earlier date or restore full history anytime.',
  },
  {
    q: 'Can I restore a backup on a freshly formatted PC before installing Claude or Codex?',
    a: 'Yes. Running burn --import-backup burnrate-backup-YYYY-MM-DD.json (or importing inside Settings) restores settings, historical pricing snapshots, and all archived sessions immediately into ~/.burnrate. Totals, charts, and heatmaps appear right away, and sessions automatically reconnect as active if matching transcripts later appear on disk.',
  },
  {
    q: 'How is LAN mobile access protected when burn binds to 0.0.0.0?',
    a: 'Localhost remains instant-access, while any remote device connecting via http://ai-burnrate.local:<port> or your LAN IP must pass a random 6-digit PIN verified with crypto.timingSafeEqual, guarded by per-IP lockout (5 failed attempts -> 60s block) and issued an HttpOnly SameSite=Lax cookie.',
  },
  {
    q: 'Why do monthly subscription plans include VAT / Sales Tax while API spend is net?',
    a: 'Cloud API billing tables are published net of tax, whereas consumer plans (Google AI Pro/Ultra, Claude Pro/Max, ChatGPT Plus/Pro) are billed with local retail tax. Burnrate keeps API equivalent spend strictly net and applies +22% VAT in EUR or +7.5% Sales Tax in USD to subscription comparisons so ROI multiples stay realistic.',
  },
];
