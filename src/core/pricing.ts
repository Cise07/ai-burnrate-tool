import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LongContextTier, ModelRate, PricingConfig, RateSnapshot, ToolSource } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_COMMIT_URL =
  'https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1';
const REPO_PRICING_URL =
  'https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/config/pricing.json';

export const PRICING_SYNC_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PRICING_SYNC_LOCK_STALE_MS = 60 * 1000; // 60 seconds

let cachedPricing: PricingConfig | null = null;

export function getPackageRoot(): string {
  let current = __dirname;
  for (let i = 0; i < 4; i++) {
    if (
      fs.existsSync(path.join(current, 'config', 'pricing.json')) ||
      fs.existsSync(path.join(current, 'package.json'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

export function getUserLedgerPath(): string {
  return path.join(os.homedir(), '.burnrate', 'pricing-ledger.json');
}

export function getPricingSyncLockPath(): string {
  return path.join(os.homedir(), '.burnrate', '.pricing-sync.lock');
}

export function releasePricingSyncLock(): void {
  try {
    const lockPath = getPricingSyncLockPath();
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore lock cleanup errors
  }
}

/**
 * Atomically checks TTL (`lastSyncCheckedAt`) and acquires a short-lived lock file
 * (`O_CREAT | O_EXCL`) so concurrent hook invocations never spawn duplicate background syncs.
 */
export function tryClaimBackgroundPricingSync(ttlMs = PRICING_SYNC_TTL_MS): boolean {
  if (process.env.BURNRATE_DISABLE_PRICING_SYNC === '1' || process.env.BURNRATE_DISABLE_PRICING_SYNC === 'true') {
    return false;
  }
  const now = Date.now();
  try {
    const ledgerPath = getUserLedgerPath();
    if (fs.existsSync(ledgerPath)) {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as Partial<PricingConfig>;
      if (parsed.lastSyncCheckedAt) {
        const lastMs = new Date(parsed.lastSyncCheckedAt).getTime();
        if (!Number.isNaN(lastMs) && now - lastMs < ttlMs) {
          return false;
        }
      }
    }
  } catch {
    // Proceed to lock check if ledger is unreadable
  }

  const lockPath = getPricingSyncLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }

  const acquire = (): boolean => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n${new Date(now).toISOString()}\n`);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  };

  if (acquire()) return true;

  // Check if an existing lock is stale (e.g. crashed background process)
  try {
    const st = fs.statSync(lockPath);
    if (now - st.mtimeMs >= PRICING_SYNC_LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      return acquire();
    }
  } catch {
    // Another worker released it between openSync and statSync
  }
  return false;
}

function loadBundledPricing(): PricingConfig {
  const root = getPackageRoot();
  const configPath = path.join(root, 'config', 'pricing.json');
  const fallbackPath = path.join(root, 'pricing.json');
  const pricingPath = fs.existsSync(configPath) ? configPath : fallbackPath;
  const raw = fs.readFileSync(pricingPath, 'utf-8');
  return JSON.parse(raw) as PricingConfig;
}

function ensureHistoryInitialized(config: PricingConfig): PricingConfig {
  if (!Array.isArray(config.history) || config.history.length === 0) {
    config.history = [
      {
        effectiveFrom: '1970-01-01T00:00:00.000Z',
        source: 'baseline',
        models: structuredClone(config.models),
      },
    ];
  }
  config.history.sort((a, b) => (a.effectiveFrom > b.effectiveFrom ? 1 : -1));
  return config;
}

export function saveUserLedger(config: PricingConfig): void {
  try {
    const ledgerPath = getUserLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(config, null, 2);
    const tmpPath = `${ledgerPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, ledgerPath);
    } catch {
      fs.writeFileSync(ledgerPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
  } catch {
    // Ignore write errors on read-only environments
  }
}

export function loadPricing(forceReload = false): PricingConfig {
  if (cachedPricing && !forceReload) return cachedPricing;

  const bundled = ensureHistoryInitialized(loadBundledPricing());
  const ledgerPath = getUserLedgerPath();

  if (fs.existsSync(ledgerPath)) {
    try {
      const ledger = ensureHistoryInitialized(
        JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as PricingConfig
      );
      // Ensure any newly added models in bundled config exist in ledger and all historical snapshots
      let migrated = false;
      for (const [k, v] of Object.entries(bundled.models)) {
        if (!ledger.models[k]) {
          ledger.models[k] = structuredClone(v);
          migrated = true;
        } else if (v.longContext && !ledger.models[k].longContext) {
          ledger.models[k].longContext = structuredClone(v.longContext);
          migrated = true;
        }
        if (ledger.history) {
          for (const snap of ledger.history) {
            if (!snap.models[k]) {
              snap.models[k] = structuredClone(v);
              migrated = true;
            } else if (v.longContext && !snap.models[k].longContext) {
              snap.models[k].longContext = structuredClone(v.longContext);
              migrated = true;
            }
          }
        }
      }
      if (bundled.defaults) {
        ledger.defaults = { ...bundled.defaults, ...(ledger.defaults || {}) };
      }
      if (migrated) {
        saveUserLedger(ledger);
      }
      cachedPricing = ledger;
      return cachedPricing;
    } catch {
      // Fallback to bundled if ledger is corrupted
    }
  }

  cachedPricing = bundled;
  saveUserLedger(cachedPricing);
  return cachedPricing;
}

function longContextTiersDiffer(a?: LongContextTier, b?: LongContextTier): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return (
    a.thresholdTokens !== b.thresholdTokens ||
    Math.abs(a.input - b.input) > 1e-6 ||
    Math.abs(a.output - b.output) > 1e-6 ||
    Math.abs(a.cacheRead - b.cacheRead) > 1e-6 ||
    Math.abs(a.cacheWrite - b.cacheWrite) > 1e-6
  );
}

function ratesDiffer(a: Record<string, ModelRate>, b: Record<string, ModelRate>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ma = a[k];
    const mb = b[k];
    if (!ma || !mb) return true;
    if (
      Math.abs(ma.input - mb.input) > 1e-6 ||
      Math.abs(ma.output - mb.output) > 1e-6 ||
      Math.abs(ma.cacheRead - mb.cacheRead) > 1e-6 ||
      Math.abs(ma.cacheWrite - mb.cacheWrite) > 1e-6 ||
      Boolean(ma.isPromo) !== Boolean(mb.isPromo) ||
      (ma.promoEnd || '') !== (mb.promoEnd || '') ||
      longContextTiersDiffer(ma.longContext, mb.longContext)
    ) {
      return true;
    }
  }
  return false;
}

const round4 = (n: number): number => Number(n.toFixed(4));

function extractLiteLlmLongContextTier(
  entry: Record<string, any>,
  provider: string,
  baseInputPer1M: number,
  baseCacheReadPer1M: number
): LongContextTier | undefined {
  let bestThreshold = 0;
  let bestInput = 0;
  let bestOutput = 0;
  let bestCacheRead: number | undefined;
  let bestCacheWrite: number | undefined;

  for (const [field, rawVal] of Object.entries(entry)) {
    const match = field.match(/^input_cost_per_token_above_(\d+)k_tokens$/);
    if (!match || typeof rawVal !== 'number' || rawVal <= 0) continue;
    const kNum = Number.parseInt(match[1], 10);
    if (!Number.isFinite(kNum) || kNum <= 0) continue;

    const outRaw = entry[`output_cost_per_token_above_${kNum}k_tokens`];
    if (typeof outRaw !== 'number' || outRaw <= 0) continue;

    const thresholdTokens = kNum * 1_000;
    if (bestThreshold === 0 || thresholdTokens < bestThreshold) {
      bestThreshold = thresholdTokens;
      bestInput = round4(rawVal * 1_000_000);
      bestOutput = round4(outRaw * 1_000_000);
      const cacheReadRaw = entry[`cache_read_input_token_cost_above_${kNum}k_tokens`];
      const cacheWriteRaw = entry[`cache_creation_input_token_cost_above_${kNum}k_tokens`];
      bestCacheRead =
        typeof cacheReadRaw === 'number' && cacheReadRaw >= 0
          ? round4(cacheReadRaw * 1_000_000)
          : undefined;
      bestCacheWrite =
        typeof cacheWriteRaw === 'number' && cacheWriteRaw > 0
          ? round4(cacheWriteRaw * 1_000_000)
          : undefined;
    }
  }

  if (bestThreshold <= 0 || bestInput <= 0 || bestOutput <= 0) return undefined;

  const cacheReadRatio = baseInputPer1M > 0 ? baseCacheReadPer1M / baseInputPer1M : 0.1;
  const cacheRead =
    bestCacheRead !== undefined ? bestCacheRead : round4(bestInput * cacheReadRatio);
  const cacheWrite =
    provider === 'anthropic'
      ? bestCacheWrite ?? round4(bestInput * 1.25)
      : bestInput;

  return {
    thresholdTokens: bestThreshold,
    input: bestInput,
    output: bestOutput,
    cacheRead,
    cacheWrite,
  };
}

function stripPromoMetadata(rate: ModelRate): ModelRate {
  const {
    promoStart: _ps,
    promoEnd: _pe,
    promoNote: _pn,
    standardInput: _si,
    standardOutput: _so,
    standardCacheRead: _scr,
    standardCacheWrite: _scw,
    ...clean
  } = rate;
  return { ...clean, isPromo: false };
}

function buildGooglePromoRate(
  ourKey: string,
  existing: ModelRate,
  inputPer1M: number,
  outputPer1M: number,
  cacheReadPer1M: number,
  cacheWritePer1M: number
): ModelRate {
  const base: ModelRate = {
    ...existing,
    input: inputPer1M,
    output: outputPer1M,
    cacheRead: cacheReadPer1M,
    cacheWrite: cacheWritePer1M,
  };

  if (ourKey === 'gemini-4-neon') {
    // Standard tier Neon launch pricing ($3.00 / $15.00 / $0.15) has no introductory promo
    if (inputPer1M >= 3.0) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      standardInput: existing.standardInput || 3.0,
      standardOutput: existing.standardOutput || 15.0,
      standardCacheRead: existing.standardCacheRead || 0.15,
      standardCacheWrite: existing.standardCacheWrite || 3.0,
    };
  }

  if (ourKey === 'gemini-4-hydrogen') {
    // Standard tier Hydrogen launch pricing ($1.50 / $7.50 / $0.075) has no introductory promo
    if (inputPer1M >= 1.5) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      standardInput: existing.standardInput || 1.5,
      standardOutput: existing.standardOutput || 7.5,
      standardCacheRead: existing.standardCacheRead || 0.075,
      standardCacheWrite: existing.standardCacheWrite || 1.5,
    };
  }

  if (ourKey === 'gemini-4-argon' || ourKey === 'gemini-4-carbon') {
    if (inputPer1M > 2.0) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      promoStart: existing.promoStart || '2026-10-21T00:00:00.000Z',
      promoEnd: existing.promoEnd || '2026-11-30T23:59:59.999Z',
      promoNote: 'Google AI Launch Promo (-50%, Oct 21 – Nov 30, 2026)',
      standardInput: 4.0,
      standardOutput: 20.0,
      standardCacheRead: 0.2,
      standardCacheWrite: 4.0,
    };
  }

  if (ourKey === 'gemini-3.8-flash') {
    if (inputPer1M > 0.75) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      promoStart: existing.promoStart || '2026-09-15T00:00:00.000Z',
      promoEnd: existing.promoEnd || '2026-12-31T23:59:59.999Z',
      promoNote: 'Google AI Promo (-50%, Sep 15 – Dec 31, 2026)',
      standardInput: existing.standardInput || 1.5,
      standardOutput: existing.standardOutput || 7.5,
      standardCacheRead: existing.standardCacheRead || 0.15,
      standardCacheWrite: existing.standardCacheWrite || 1.5,
    };
  }

  if (ourKey.includes('flash')) {
    const threshold = ourKey.includes('lite') ? 0.1 : 0.3;
    if (inputPer1M > threshold) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      promoStart: existing.promoStart || '2026-06-01T00:00:00.000Z',
      promoEnd: existing.promoEnd || '2026-12-31T23:59:59.999Z',
      promoNote: existing.promoNote || 'Promo Google AI Introductory',
      standardInput: existing.standardInput || (ourKey.includes('lite') ? 0.15 : 0.5),
      standardOutput: existing.standardOutput || (ourKey.includes('lite') ? 0.6 : 2.5),
    };
  }

  if (ourKey.includes('pro')) {
    if (inputPer1M > 1.25) return stripPromoMetadata(base);
    return {
      ...base,
      isPromo: true,
      promoStart: existing.promoStart || '2026-06-01T00:00:00.000Z',
      promoEnd: existing.promoEnd || '2026-12-31T23:59:59.999Z',
      promoNote: existing.promoNote || 'Promo Google AI (<200k tokens)',
      standardInput: existing.standardInput || 2.5,
      standardOutput: existing.standardOutput || 12.5,
    };
  }

  return base;
}

const ORCHESTRATOR_PLANNER_SHARE = 0.3;
const ORCHESTRATOR_EXECUTOR_SHARE = 0.7;

function deriveOrchestratorRate(
  plannerName: string,
  planner: ModelRate,
  executor: ModelRate,
  existing: ModelRate
): ModelRate {
  const blend = (a: number, b: number) =>
    round4(a * ORCHESTRATOR_PLANNER_SHARE + b * ORCHESTRATOR_EXECUTOR_SHARE);

  const input = blend(planner.input, executor.input);
  const output = blend(planner.output, executor.output);
  const cacheRead = blend(planner.cacheRead, executor.cacheRead);
  const cacheWrite = blend(planner.cacheWrite, executor.cacheWrite);
  const hasPromo = Boolean(planner.isPromo || executor.isPromo);

  if (!hasPromo) {
    return stripPromoMetadata({ ...existing, input, output, cacheRead, cacheWrite });
  }

  return {
    ...existing,
    input,
    output,
    cacheRead,
    cacheWrite,
    isPromo: true,
    promoStart: planner.promoStart || executor.promoStart,
    promoEnd: planner.promoEnd || executor.promoEnd,
    promoNote: `Google AI Launch Promo on Planner ${plannerName} (-50% until Nov 30, 2026) + Hydrogen`,
    standardInput: blend(planner.standardInput ?? planner.input, executor.standardInput ?? executor.input),
    standardOutput: blend(planner.standardOutput ?? planner.output, executor.standardOutput ?? executor.output),
    standardCacheRead: blend(planner.standardCacheRead ?? planner.cacheRead, executor.standardCacheRead ?? executor.cacheRead),
    standardCacheWrite: blend(planner.standardCacheWrite ?? planner.cacheWrite, executor.standardCacheWrite ?? executor.cacheWrite),
  };
}

async function fetchLiteLlmLastCommitIso(): Promise<string | null> {
  try {
    const res = await fetch(LITELLM_COMMIT_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ai-burnrate-tool',
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const commits = (await res.json()) as Array<{
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    }>;
    const rawDate = commits?.[0]?.commit?.committer?.date || commits?.[0]?.commit?.author?.date;
    if (!rawDate) return null;
    const parsed = new Date(rawDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

/**
 * Syncs latest official pricing without altering historical token calculations.
 * Uses conditional ETag (`If-None-Match` -> 304 Not Modified) for near-zero bandwidth/latency.
 * If any rate changed compared to the latest snapshot, a new RateSnapshot is appended
 * with an accurate `effectiveFrom` so past turns keep their original tariff.
 */
export async function syncOfficialPricing(options: { force?: boolean } = {}): Promise<{
  updated: boolean;
  effectiveFrom?: string;
  notModified?: boolean;
}> {
  const force = Boolean(options.force);
  const current = loadPricing(true);
  const previousSyncCheckedAt = current.lastSyncCheckedAt || '';
  const latestSnapshot: RateSnapshot =
    current.history && current.history.length > 0
      ? current.history[current.history.length - 1]
      : { effectiveFrom: '1970-01-01T00:00:00.000Z', models: current.models };

  const candidateModels: Record<string, ModelRate> = structuredClone(latestSnapshot.models);

  let remoteUpdatedAt: string | null = null;
  let repoApplied = false;
  let litellmApplied = false;
  let nextRepoEtag = current.repoPricingEtag;
  let nextLitellmEtag = current.litellmEtag;
  let anyNetworkSuccess = false;
  let repoNotModified = false;
  let litellmNotModified = false;

  try {
    // 1. Try syncing from official GitHub repository pricing.json (with ETag)
    try {
      const headers: Record<string, string> = {};
      if (!force && current.repoPricingEtag) {
        headers['If-None-Match'] = current.repoPricingEtag;
      }
      const res = await fetch(REPO_PRICING_URL, { headers, signal: AbortSignal.timeout(3000) });
      if (res.status === 304) {
        anyNetworkSuccess = true;
        repoNotModified = true;
      } else if (res.ok) {
        anyNetworkSuccess = true;
        const etag = res.headers.get('etag');
        if (etag) nextRepoEtag = etag;
        const remoteConfig = (await res.json()) as Partial<PricingConfig>;
        if (remoteConfig.updatedAt && typeof remoteConfig.updatedAt === 'string') {
          remoteUpdatedAt = remoteConfig.updatedAt;
        }
        if (
          remoteConfig.models &&
          typeof remoteConfig.models === 'object' &&
          (!current.updatedAt || (remoteConfig.updatedAt && remoteConfig.updatedAt > current.updatedAt))
        ) {
          for (const [k, rate] of Object.entries(remoteConfig.models)) {
            if (rate && typeof rate.input === 'number' && typeof rate.output === 'number') {
              candidateModels[k] = { ...candidateModels[k], ...rate };
              repoApplied = true;
            }
          }
        }
      }
    } catch {
      // Offline or repo unreachable; proceed to LiteLLM feed
    }

    // 2. Sync official provider per-token rates from LiteLLM registry (with ETag)
    try {
      const headers: Record<string, string> = {};
      if (!force && current.litellmEtag) {
        headers['If-None-Match'] = current.litellmEtag;
      }
      const res = await fetch(LITELLM_PRICING_URL, { headers, signal: AbortSignal.timeout(3500) });
      if (res.status === 304) {
        anyNetworkSuccess = true;
        litellmNotModified = true;
      } else if (res.ok) {
        anyNetworkSuccess = true;
        const etag = res.headers.get('etag');
        if (etag) nextLitellmEtag = etag;
        const litellm = (await res.json()) as Record<string, any>;
      const mapping: Array<{ ourKey: string; litellmKeys: string[] }> = [
        {
          ourKey: 'claude-3-7-sonnet',
          litellmKeys: [
            'anthropic.claude-3-7-sonnet-20250219-v1:0',
            'claude-3-7-sonnet-20250219',
            'claude-3-7-sonnet-latest',
          ],
        },
        {
          ourKey: 'claude-sonnet-4',
          litellmKeys: [
            'claude-sonnet-4-6',
            'claude-sonnet-4-5-20250929',
            'claude-sonnet-4-5',
            'anthropic.claude-sonnet-4-5-20250929-v1:0',
            'claude-sonnet-4-20250514',
            'anthropic/claude-sonnet-4-20250514',
          ],
        },
        {
          ourKey: 'claude-3-5-sonnet',
          litellmKeys: [
            'anthropic.claude-3-5-sonnet-20241022-v2:0',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-latest',
          ],
        },
        {
          ourKey: 'claude-opus-5-5',
          litellmKeys: [
            'claude-opus-5-5',
            'anthropic.claude-opus-5-5',
          ],
        },
        {
          ourKey: 'claude-opus-4-5',
          litellmKeys: [
            'claude-opus-5',
            'claude-opus-4-8',
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-opus-4-5-20251101',
            'claude-opus-4-5',
            'anthropic.claude-opus-4-5-20251101-v1:0',
          ],
        },
        {
          ourKey: 'claude-opus-4',
          litellmKeys: [
            'anthropic.claude-opus-4-20250514-v1:0',
            'claude-opus-4-20250514',
            'anthropic/claude-opus-4-20250514',
          ],
        },
        {
          ourKey: 'claude-3-opus',
          litellmKeys: [
            'anthropic.claude-3-opus-20240229-v1:0',
            'claude-3-opus-20240229',
          ],
        },
        {
          ourKey: 'claude-3-5-haiku',
          litellmKeys: [
            'anthropic.claude-3-5-haiku-20241022-v1:0',
            'claude-3-5-haiku-20241022',
            'claude-3-5-haiku-latest',
          ],
        },
        {
          ourKey: 'claude-haiku-4',
          litellmKeys: [
            'anthropic.claude-haiku-4-5-20251001-v1:0',
            'claude-haiku-4-5-20251001',
          ],
        },
        {
          ourKey: 'gemini-4-argon',
          litellmKeys: ['gemini/gemini-4-argon', 'vertex_ai/gemini-4-argon', 'gmi/google/gemini-4-argon'],
        },
        {
          ourKey: 'gemini-4-carbon',
          litellmKeys: ['gemini/gemini-4-carbon', 'vertex_ai/gemini-4-carbon', 'gmi/google/gemini-4-carbon'],
        },
        {
          ourKey: 'gemini-4-neon',
          litellmKeys: ['gemini/gemini-4-neon', 'vertex_ai/gemini-4-neon', 'gmi/google/gemini-4-neon', 'gemini-4-neon'],
        },
        {
          ourKey: 'gemini-4-hydrogen',
          litellmKeys: ['gemini/gemini-4-hydrogen', 'vertex_ai/gemini-4-hydrogen'],
        },
        {
          ourKey: 'gemini-2.5-pro',
          litellmKeys: ['gemini/gemini-2.5-pro', 'gemini-2.5-pro'],
        },
        {
          ourKey: 'gemini-pro',
          litellmKeys: ['gemini/gemini-2.5-pro', 'gemini-2.5-pro'],
        },
        {
          ourKey: 'gemini-2.5-flash',
          litellmKeys: ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
        },
        {
          ourKey: 'gemini-flash',
          litellmKeys: ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
        },
        {
          ourKey: 'gemini-3.8-flash',
          litellmKeys: ['gemini/gemini-3.8-flash', 'vertex_ai/gemini-3.8-flash', 'gemini-3.8-flash'],
        },
        {
          ourKey: 'gemini-flash-lite',
          litellmKeys: [
            'gemini/gemini-2.5-flash-lite',
            'gemini-2.5-flash-lite',
            'gemini/gemini-flash-lite-latest',
          ],
        },
        {
          ourKey: 'gpt-6.2-astra',
          litellmKeys: ['gpt-6.2-astra', 'openai/gpt-6.2-astra', 'openai.gpt-6.2-astra', 'gpt-6.2-astra-law'],
        },
        {
          ourKey: 'gpt-6.2-sol',
          litellmKeys: ['gpt-6.2-sol', 'openai/gpt-6.2-sol', 'openai.gpt-6.2-sol'],
        },
        {
          ourKey: 'gpt-6.1-sol',
          litellmKeys: ['gpt-6.1-sol', 'openai/gpt-6.1-sol', 'global.openai.gpt-6.1-sol'],
        },
        {
          ourKey: 'gpt-6.1-terra',
          litellmKeys: ['gpt-6.1-terra', 'openai/gpt-6.1-terra', 'global.openai.gpt-6.1-terra'],
        },
        {
          ourKey: 'gpt-6-astra',
          litellmKeys: ['gpt-6-astra', 'openai/gpt-6-astra', 'global.openai.gpt-6-astra', 'gpt-6-astra-law'],
        },
        {
          ourKey: 'gpt-6-sol',
          litellmKeys: ['gpt-6-sol', 'openai/gpt-6-sol', 'openai.gpt-6-sol'],
        },
        {
          ourKey: 'gpt-6-luna',
          litellmKeys: ['gpt-6-luna', 'openai/gpt-6-luna', 'openai.gpt-6-luna'],
        },
        {
          ourKey: 'gpt-6-cyber',
          litellmKeys: ['gpt-6-cyber', 'openai/gpt-6-cyber'],
        },
        {
          ourKey: 'gpt-6-rosalind',
          litellmKeys: ['gpt-6-rosalind', 'openai/gpt-6-rosalind'],
        },
        {
          ourKey: 'gpt-5.6-sol',
          litellmKeys: ['gpt-5.6-sol', 'openai/gpt-5.6-sol', 'gpt-5.6', 'global.openai.gpt-5.6-sol'],
        },
        {
          ourKey: 'gpt-5.6-terra',
          litellmKeys: ['gpt-5.6-terra', 'openai/gpt-5.6-terra', 'global.openai.gpt-5.6-terra'],
        },
        {
          ourKey: 'gpt-5.6-luna',
          litellmKeys: ['gpt-5.6-luna', 'openai/gpt-5.6-luna', 'global.openai.gpt-5.6-luna'],
        },
        {
          ourKey: 'gpt-5.6-cyber',
          litellmKeys: ['gpt-5.6-cyber', 'openai/gpt-5.6-cyber'],
        },
        {
          ourKey: 'gpt-5.5-pro',
          litellmKeys: ['gpt-5.5-pro', 'openai/gpt-5.5-pro'],
        },
        {
          ourKey: 'gpt-5.5-cyber',
          litellmKeys: ['gpt-5.5-cyber', 'openai/gpt-5.5-cyber', 'gpt-5.5-cyber-preview'],
        },
        {
          ourKey: 'gpt-5.5',
          litellmKeys: ['gpt-5.5', 'openai/gpt-5.5'],
        },
        {
          ourKey: 'gpt-5.4-pro',
          litellmKeys: ['gpt-5.4-pro', 'openai/gpt-5.4-pro'],
        },
        {
          ourKey: 'gpt-5.4',
          litellmKeys: ['gpt-5.4', 'openai/gpt-5.4'],
        },
        {
          ourKey: 'gpt-5.4-mini',
          litellmKeys: ['gpt-5.4-mini', 'openai/gpt-5.4-mini'],
        },
        {
          ourKey: 'gpt-5.4-nano',
          litellmKeys: ['gpt-5.4-nano', 'openai/gpt-5.4-nano'],
        },
        {
          ourKey: 'gpt-5.3-codex',
          litellmKeys: ['gpt-5.3-codex', 'openai/gpt-5.3-codex', 'gpt-5.3-chat-latest'],
        },
        {
          ourKey: 'gpt-5.2-pro',
          litellmKeys: ['gpt-5.2-pro', 'openai/gpt-5.2-pro'],
        },
        {
          ourKey: 'gpt-5.2-codex',
          litellmKeys: ['gpt-5.2-codex', 'openai/gpt-5.2-codex', 'gpt-5.2', 'openai/gpt-5.2'],
        },
        {
          ourKey: 'gpt-5.1-codex',
          litellmKeys: ['gpt-5.1-codex', 'openai/gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1'],
        },
        {
          ourKey: 'gpt-5-pro',
          litellmKeys: ['gpt-5-pro', 'openai/gpt-5-pro'],
        },
        {
          ourKey: 'gpt-5-codex',
          litellmKeys: ['gpt-5-codex', 'openai/gpt-5-codex'],
        },
        {
          ourKey: 'gpt-5',
          litellmKeys: ['gpt-5', 'openai/gpt-5'],
        },
        {
          ourKey: 'gpt-5-mini',
          litellmKeys: ['gpt-5-mini', 'openai/gpt-5-mini', 'gpt-5.1-codex-mini'],
        },
        {
          ourKey: 'gpt-5-nano',
          litellmKeys: ['gpt-5-nano', 'openai/gpt-5-nano'],
        },
        {
          ourKey: 'gpt-4.1',
          litellmKeys: ['gpt-4.1', 'openai/gpt-4.1'],
        },
        {
          ourKey: 'o3-pro',
          litellmKeys: ['o3-pro', 'openai/o3-pro'],
        },
        {
          ourKey: 'o3',
          litellmKeys: ['o3', 'openai/o3'],
        },
        {
          ourKey: 'o3-mini',
          litellmKeys: ['o3-mini', 'openai/o3-mini'],
        },
        {
          ourKey: 'o4-mini',
          litellmKeys: ['o4-mini', 'openai/o4-mini'],
        },
      ];

      for (const { ourKey, litellmKeys } of mapping) {
        for (const lk of litellmKeys) {
          const entry = litellm[lk];
          if (
            entry &&
            typeof entry.input_cost_per_token === 'number' &&
            typeof entry.output_cost_per_token === 'number'
          ) {
            const existing = candidateModels[ourKey];
            if (!existing) break;
            const inputPer1M = round4(entry.input_cost_per_token * 1_000_000);
            const outputPer1M = round4(entry.output_cost_per_token * 1_000_000);
            const cacheReadPer1M =
              typeof entry.cache_read_input_token_cost === 'number'
                ? round4(entry.cache_read_input_token_cost * 1_000_000)
                : existing.provider === 'openai'
                  ? existing.cacheRead
                  : round4(inputPer1M * (existing.provider === 'anthropic' ? 0.1 : 0.25));
            const cacheWritePer1M =
              typeof entry.cache_creation_input_token_cost === 'number' && entry.cache_creation_input_token_cost > 0
                ? round4(entry.cache_creation_input_token_cost * 1_000_000)
                : existing.provider === 'google' || existing.provider === 'openai'
                  ? inputPer1M
                  : existing.cacheWrite;

            const longContext = extractLiteLlmLongContextTier(
              entry,
              existing.provider,
              inputPer1M,
              cacheReadPer1M
            );

            const nextRate: ModelRate =
              existing.provider === 'google'
                ? buildGooglePromoRate(ourKey, existing, inputPer1M, outputPer1M, cacheReadPer1M, cacheWritePer1M)
                : {
                    ...existing,
                    input: inputPer1M,
                    output: outputPer1M,
                    cacheRead: cacheReadPer1M,
                    cacheWrite: cacheWritePer1M,
                  };
            if (longContext) {
              nextRate.longContext = longContext;
            } else {
              delete nextRate.longContext;
            }
            candidateModels[ourKey] = nextRate;
            litellmApplied = true;
            break;
          }
        }
      }
    }
  } catch {
    // Offline fallback: keep local ledger intact
  }

      // 3. Derive composite Orchestrator rates dynamically from live Planner (Carbon/Argon) + Executor (Hydrogen) rates
      const hydrogenRate = candidateModels['gemini-4-hydrogen'];
      if (hydrogenRate) {
        if (candidateModels['gemini-4-carbon'] && candidateModels['orchestrator-carbon']) {
          candidateModels['orchestrator-carbon'] = deriveOrchestratorRate(
            'Carbon',
            candidateModels['gemini-4-carbon'],
            hydrogenRate,
            candidateModels['orchestrator-carbon']
          );
        }
        if (candidateModels['gemini-4-argon'] && candidateModels['orchestrator-argon']) {
          candidateModels['orchestrator-argon'] = deriveOrchestratorRate(
            'Argon',
            candidateModels['gemini-4-argon'],
            hydrogenRate,
            candidateModels['orchestrator-argon']
          );
        }
      }

      const nowIso = new Date().toISOString();
      if (ratesDiffer(latestSnapshot.models, candidateModels)) {
        const remoteIso = remoteUpdatedAt ? `${remoteUpdatedAt}T00:00:00.000Z` : null;
        let effectiveFrom = nowIso;
        if (repoApplied && !litellmApplied && remoteIso && remoteIso > latestSnapshot.effectiveFrom) {
          effectiveFrom = remoteIso;
        } else if (litellmApplied) {
          const commitIso = await fetchLiteLlmLastCommitIso();
          const lowerBound =
            previousSyncCheckedAt && previousSyncCheckedAt > latestSnapshot.effectiveFrom
              ? previousSyncCheckedAt
              : latestSnapshot.effectiveFrom;
          if (commitIso && commitIso > lowerBound && commitIso <= nowIso) {
            effectiveFrom = commitIso;
          }
        }
        current.history = current.history || [];
        current.history.push({
          effectiveFrom,
          source: 'official-sync',
          models: candidateModels,
        });
        current.history.sort((a, b) => (a.effectiveFrom > b.effectiveFrom ? 1 : -1));
        current.models = structuredClone(candidateModels);
        current.updatedAt = remoteUpdatedAt && repoApplied && !litellmApplied ? remoteUpdatedAt : effectiveFrom.slice(0, 10);
        current.lastSyncCheckedAt = nowIso;
        if (nextLitellmEtag) current.litellmEtag = nextLitellmEtag;
        if (nextRepoEtag) current.repoPricingEtag = nextRepoEtag;
        cachedPricing = current;
        saveUserLedger(current);
        return { updated: true, effectiveFrom };
      }

      if (anyNetworkSuccess) {
        current.lastSyncCheckedAt = nowIso;
        if (nextLitellmEtag) current.litellmEtag = nextLitellmEtag;
        if (nextRepoEtag) current.repoPricingEtag = nextRepoEtag;
        cachedPricing = current;
        saveUserLedger(current);
      }

      return { updated: false, notModified: repoNotModified && litellmNotModified };
    } finally {
      releasePricingSyncLock();
    }
  }

function getDefaultModelForSource(source: ToolSource, pricing: PricingConfig): string {
  const fromConfig = pricing.defaults?.[source];
  if (fromConfig && pricing.models[fromConfig]) return fromConfig;
  if (source === 'claude') return 'claude-sonnet-4';
  if (source === 'codex') {
    if (pricing.models['gpt-6.2-sol']) return 'gpt-6.2-sol';
    if (pricing.models['gpt-5.3-codex']) return 'gpt-5.3-codex';
    return 'gpt-5';
  }
  return 'gemini-4-argon';
}

export function resolveModelKey(
  rawModel: string | undefined | null,
  source: ToolSource,
  pricing: PricingConfig
): string {
  const defaultKey = getDefaultModelForSource(source, pricing);
  if (!rawModel) return defaultKey;

  const cleaned = rawModel
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:global|us|eu|in|us-gov)\.)?openai[/.]/, '');
  if (
    !cleaned ||
    cleaned === 'auto' ||
    cleaned === 'default' ||
    cleaned === 'inherit' ||
    cleaned === 'none'
  ) {
    return defaultKey;
  }

  if (pricing.models[cleaned]) {
    return cleaned;
  }

  const pick = (key: string) => (pricing.models[key] ? key : defaultKey);

  // OpenAI GPT-6.2 family (Astra, Sol, + future variants)
  if (/gpt[-_\s]?6[.\-_]2/.test(cleaned)) {
    if (cleaned.includes('astra')) return pick('gpt-6.2-astra');
    if (cleaned.includes('cyber')) return pick('gpt-6-cyber');
    if (cleaned.includes('terra')) return pick('gpt-6.1-terra');
    if (cleaned.includes('luna')) return pick('gpt-6-luna');
    return pick('gpt-6.2-sol');
  }
  // OpenAI GPT-6.1 family (Sol, Terra, + future variants)
  if (/gpt[-_\s]?6[.\-_]1/.test(cleaned)) {
    if (cleaned.includes('terra')) return pick('gpt-6.1-terra');
    if (cleaned.includes('astra')) return pick('gpt-6.2-astra');
    if (cleaned.includes('cyber')) return pick('gpt-6-cyber');
    if (cleaned.includes('luna')) return pick('gpt-6-luna');
    return pick('gpt-6.1-sol');
  }
  // OpenAI GPT-6 family (Astra, Sol, Luna, Cyber, Rosalind, + generic GPT-6.x)
  if (/gpt[-_\s]?6(?:$|[^0-9])/.test(cleaned)) {
    if (cleaned.includes('cyber')) return pick('gpt-6-cyber');
    if (cleaned.includes('rosalind')) return pick('gpt-6-rosalind');
    if (cleaned.includes('astra')) return pick('gpt-6-astra');
    if (cleaned.includes('terra')) return pick('gpt-6.1-terra');
    if (cleaned.includes('luna')) return pick('gpt-6-luna');
    return pick('gpt-6-sol');
  }
  // OpenAI GPT-5.6 family (Sol, Terra, Luna, Cyber, + Daybreak Blue 5.6)
  if (/gpt[-_\s]?(?:daybreak[-_\s]?blue[-_\s]?)?5[.\-_]6/.test(cleaned)) {
    if (cleaned.includes('cyber')) return pick('gpt-5.6-cyber');
    if (cleaned.includes('luna')) return pick('gpt-5.6-luna');
    if (cleaned.includes('terra')) return pick('gpt-5.6-terra');
    return pick('gpt-5.6-sol');
  }
  // OpenAI GPT-5.5 family (Pro, Cyber, Standard)
  if (/gpt[-_\s]?5[.\-_]5/.test(cleaned)) {
    if (cleaned.includes('cyber')) return pick('gpt-5.5-cyber');
    if (cleaned.includes('pro')) return pick('gpt-5.5-pro');
    return pick('gpt-5.5');
  }
  // OpenAI GPT-5.4 family (Pro, Nano, Mini, Standard)
  if (/gpt[-_\s]?5[.\-_]4/.test(cleaned)) {
    if (cleaned.includes('pro')) return pick('gpt-5.4-pro');
    if (cleaned.includes('nano')) return pick('gpt-5.4-nano');
    if (cleaned.includes('mini')) return pick('gpt-5.4-mini');
    return pick('gpt-5.4');
  }
  // OpenAI GPT-5.3 family (Codex, Spark, Chat)
  if (/gpt[-_\s]?5[.\-_]3/.test(cleaned) || (cleaned.includes('5.3') && cleaned.includes('codex'))) {
    return pick('gpt-5.3-codex');
  }
  // OpenAI GPT-5.2 family (Pro, Codex, Standard)
  if (/gpt[-_\s]?5[.\-_]2/.test(cleaned) || (cleaned.includes('5.2') && cleaned.includes('codex'))) {
    if (cleaned.includes('pro')) return pick('gpt-5.2-pro');
    return pick('gpt-5.2-codex');
  }
  // OpenAI GPT-5.1 family (Codex Mini, Codex Max, Codex, Standard)
  if (/gpt[-_\s]?5[.\-_]1/.test(cleaned) || (cleaned.includes('5.1') && cleaned.includes('codex'))) {
    if (cleaned.includes('mini')) return pick('gpt-5-mini');
    if (cleaned.includes('nano')) return pick('gpt-5-nano');
    return pick('gpt-5.1-codex');
  }
  // OpenAI GPT-5 family (Pro, Nano, Mini, Codex, Standard)
  if (/gpt[-_\s]?5(?:$|[^0-9])/.test(cleaned)) {
    if (cleaned.includes('pro')) return pick('gpt-5-pro');
    if (cleaned.includes('nano')) return pick('gpt-5-nano');
    if (cleaned.includes('mini')) return pick('gpt-5-mini');
    if (cleaned.includes('codex')) return pick('gpt-5-codex');
    return pick('gpt-5');
  }
  // Bare codex aliases (codex-mini-latest, codex)
  if (cleaned.includes('codex')) {
    if (cleaned.includes('mini')) return pick('gpt-5-mini');
    return pick('gpt-5-codex');
  }
  if (/gpt[-_\s]?4[.\-_]1/.test(cleaned) || cleaned.includes('gpt-4o')) {
    return pick('gpt-4.1');
  }
  if (/(?:^|[^a-z0-9])o4[-_.\s]?mini/.test(cleaned)) {
    return pick('o4-mini');
  }
  if (/(?:^|[^a-z0-9])o3[-_.\s]?pro/.test(cleaned)) {
    return pick('o3-pro');
  }
  if (/(?:^|[^a-z0-9])o3[-_.\s]?mini/.test(cleaned)) {
    return pick('o3-mini');
  }
  if (/(?:^|[^a-z0-9])o3(?:$|[^0-9])/.test(cleaned)) {
    return pick('o3');
  }

  if (cleaned.includes('opus')) {
    if (/(?:^|[^0-9])5[-_.\s]?[5-9](?:$|[^0-9])/.test(cleaned) && pricing.models['claude-opus-5-5']) {
      return 'claude-opus-5-5';
    }
    if (
      (/(?:^|[^0-9])4[-_.\s]?[5-9](?:$|[^0-9])/.test(cleaned) ||
        /(?:^|[^0-9])5(?:\.0)?(?:$|[^0-9])/.test(cleaned)) &&
      pricing.models['claude-opus-4-5']
    ) {
      return 'claude-opus-4-5';
    }
    if (/(?:^|[^0-9])3(?:[-_.\s]?0)?(?:$|[^0-9])/.test(cleaned)) {
      return 'claude-3-opus';
    }
    if (/(?:^|[^0-9])4(?:[-_.\s]?[01])?(?:$|[^0-9])/.test(cleaned)) {
      return 'claude-opus-4';
    }
    return pricing.models['claude-opus-4-5'] ? 'claude-opus-4-5' : 'claude-opus-4';
  }
  if (cleaned.includes('haiku')) {
    return cleaned.includes('4') ? 'claude-haiku-4' : 'claude-3-5-haiku';
  }
  if (cleaned.includes('sonnet')) {
    if (cleaned.includes('3-5') || cleaned.includes('3.5')) return 'claude-3-5-sonnet';
    if (cleaned.includes('3-7') || cleaned.includes('3.7')) return 'claude-3-7-sonnet';
    return 'claude-sonnet-4';
  }

  if (cleaned.includes('orchestrator')) {
    if (cleaned.includes('argon') && pricing.models['orchestrator-argon']) {
      return 'orchestrator-argon';
    }
    return pricing.models['orchestrator-carbon'] ? 'orchestrator-carbon' : defaultKey;
  }
  if (cleaned.includes('neon')) {
    return pricing.models['gemini-4-neon'] ? 'gemini-4-neon' : defaultKey;
  }
  if (cleaned.includes('hydrogen')) {
    return pricing.models['gemini-4-hydrogen'] ? 'gemini-4-hydrogen' : defaultKey;
  }
  if (cleaned.includes('carbon')) {
    return pricing.models['gemini-4-carbon'] ? 'gemini-4-carbon' : defaultKey;
  }
  if (
    cleaned.includes('argon') ||
    cleaned.includes('ultra') ||
    cleaned.includes('gemini 4') ||
    cleaned.includes('gemini-4')
  ) {
    return 'gemini-4-argon';
  }
  if (cleaned.includes('flash-lite') || cleaned.includes('flash_lite') || cleaned.includes('lite')) {
    return 'gemini-flash-lite';
  }
  if (cleaned.includes('flash')) {
    if (cleaned.includes('3.8') || cleaned.includes('3-8') || cleaned.includes('high')) {
      return 'gemini-3.8-flash';
    }
    return 'gemini-2.5-flash';
  }
  if (cleaned.includes('pro') || cleaned.includes('gemini')) {
    return 'gemini-pro';
  }

  return defaultKey;
}

export function isPromoActive(
  rate: ModelRate | undefined,
  targetTimestamp?: string | number | Date
): boolean {
  if (!rate || !rate.isPromo) return false;
  const ts = targetTimestamp ? new Date(targetTimestamp).getTime() : Date.now();
  if (Number.isNaN(ts)) return false;
  const startMs = rate.promoStart ? new Date(rate.promoStart).getTime() : null;
  const endMs = rate.promoEnd ? new Date(rate.promoEnd).getTime() : null;

  if (startMs !== null && !Number.isNaN(startMs) && ts < startMs) return false;
  if (endMs !== null && !Number.isNaN(endMs) && ts > endMs) return false;
  return true;
}

/**
 * Resolves the exact ModelRate that was active at `turnTimestamp`.
 * Tokens consumed before a price change continue to use the historical rate active at that time.
 */
export function getHistoricalRate(
  normalizedModel: string,
  source: ToolSource,
  turnTimestamp: string | undefined,
  pricing: PricingConfig
): ModelRate {
  const fallbackKey = getDefaultModelForSource(source, pricing);
  const history = pricing.history;

  let baseRate: ModelRate =
    pricing.models[normalizedModel] ?? pricing.models[fallbackKey];

  if (history && history.length > 0 && turnTimestamp) {
    let activeSnapshot = history[0];
    for (const snap of history) {
      if (snap.effectiveFrom <= turnTimestamp) {
        activeSnapshot = snap;
      } else {
        break;
      }
    }
    const historicalRate =
      activeSnapshot.models[normalizedModel] ?? activeSnapshot.models[fallbackKey];
    if (historicalRate) {
      baseRate = historicalRate;
    }
  }

  // Verify promo dates: discount applies ONLY during the promotional window
  if (baseRate.isPromo && !isPromoActive(baseRate, turnTimestamp)) {
    // Revert to non-discounted standard rate for tokens consumed outside the promo period
    return {
      ...baseRate,
      isPromo: false,
      input: baseRate.standardInput ?? baseRate.input,
      output: baseRate.standardOutput ?? baseRate.output,
      cacheRead:
        baseRate.standardCacheRead ??
        (baseRate.standardInput
          ? baseRate.standardInput * (baseRate.provider === 'anthropic' ? 0.1 : 0.05)
          : baseRate.cacheRead),
      cacheWrite: baseRate.standardCacheWrite ?? baseRate.standardInput ?? baseRate.cacheWrite,
    };
  }

  return baseRate;
}

export interface CostCalculation {
  normalizedModel: string;
  modelLabel: string;
  rate: ModelRate;
  costUSD: number;
  cacheSavingsUSD: number;
}

export function calculateTurnCost(
  params: {
    rawModel?: string | null;
    source: ToolSource;
    timestamp?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  pricing: PricingConfig = loadPricing()
): CostCalculation {
  const normalizedModel = resolveModelKey(params.rawModel, params.source, pricing);
  const rate = getHistoricalRate(normalizedModel, params.source, params.timestamp, pricing);

  const nonCachedInput = Math.max(0, params.inputTokens);
  const cacheRead = Math.max(0, params.cacheReadTokens);
  const cacheWrite = Math.max(0, params.cacheWriteTokens);
  const output = Math.max(0, params.outputTokens);

  const contextTokens = nonCachedInput + cacheRead + cacheWrite;
  const activeTier =
    rate.longContext &&
    rate.longContext.thresholdTokens > 0 &&
    contextTokens > rate.longContext.thresholdTokens
      ? rate.longContext
      : null;

  const inputRate = activeTier ? activeTier.input : rate.input;
  const outputRate = activeTier ? activeTier.output : rate.output;
  const cacheReadRate = activeTier
    ? activeTier.cacheRead
    : typeof rate.cacheRead === 'number'
      ? rate.cacheRead
      : rate.input * (rate.provider === 'anthropic' ? 0.1 : 0.25);
  const cacheWriteRate = activeTier
    ? activeTier.cacheWrite
    : typeof rate.cacheWrite === 'number'
      ? rate.cacheWrite
      : rate.input * (rate.provider === 'anthropic' ? 1.25 : 1.0);

  const inputCost = (nonCachedInput / 1_000_000) * inputRate;
  const cacheReadCost = (cacheRead / 1_000_000) * cacheReadRate;
  const cacheWriteCost = (cacheWrite / 1_000_000) * cacheWriteRate;
  const outputCost = (output / 1_000_000) * outputRate;

  const costUSD = inputCost + cacheReadCost + cacheWriteCost + outputCost;
  const cacheSavingsUSD = Math.max(0, (cacheRead / 1_000_000) * (inputRate - cacheReadRate));

  return {
    normalizedModel,
    modelLabel:
      params.rawModel && params.rawModel !== 'auto' && params.rawModel !== 'default'
        ? formatDisplayModel(params.rawModel, rate.label)
        : rate.label,
    rate,
    costUSD,
    cacheSavingsUSD,
  };
}

const EFFORT_LABELS: Record<string, string> = {
  max: 'Max',
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
};

function formatDisplayModel(raw: string, fallbackLabel: string): string {
  const trimmed = raw
    .trim()
    .replace(/^(?:(?:global|us|eu|in|us-gov)\.)?openai[/.]/i, '');
  if (trimmed.length > 42) return fallbackLabel;
  if (trimmed.startsWith('Gemini ') || trimmed.startsWith('Orchestrator (')) return trimmed;

  // Avoid misinterpreting 'gpt-5.1-codex-max' model name as an effort suffix
  if (/codex[-_\s]?max$/i.test(trimmed)) return fallbackLabel;

  const effortMatch = trimmed.match(/(?:[-_\s]+|\()(max|xhigh|high|medium|low|minimal)\)?$/i);
  if (effortMatch) {
    const effort = EFFORT_LABELS[effortMatch[1].toLowerCase()];
    if (effort && !/\((?:max|xhigh|high|medium|low|minimal)\)$/i.test(fallbackLabel)) {
      return `${fallbackLabel} (${effort})`;
    }
  }
  return fallbackLabel;
}
