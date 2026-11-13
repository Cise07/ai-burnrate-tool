import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRate, PricingConfig, RateSnapshot, ToolSource } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REPO_PRICING_URL =
  'https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/config/pricing.json';

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
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(config, null, 2), 'utf-8');
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
        }
        if (ledger.history) {
          for (const snap of ledger.history) {
            if (!snap.models[k]) {
              snap.models[k] = structuredClone(v);
              migrated = true;
            }
          }
        }
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
      (ma.promoEnd || '') !== (mb.promoEnd || '')
    ) {
      return true;
    }
  }
  return false;
}

const round4 = (n: number): number => Number(n.toFixed(4));

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
      promoNote: 'Promo Google AI Launch (-50% dal 21/10/2026 al 30/11/2026)',
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
      promoNote: 'Promo Google AI (-50% dal 15/09/2026 al 31/12/2026)',
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
    promoNote: `Promo Google AI Launch su Planner ${plannerName} (-50% fino al 30/11/2026) + Hydrogen`,
    standardInput: blend(planner.standardInput ?? planner.input, executor.standardInput ?? executor.input),
    standardOutput: blend(planner.standardOutput ?? planner.output, executor.standardOutput ?? executor.output),
    standardCacheRead: blend(planner.standardCacheRead ?? planner.cacheRead, executor.standardCacheRead ?? executor.cacheRead),
    standardCacheWrite: blend(planner.standardCacheWrite ?? planner.cacheWrite, executor.standardCacheWrite ?? executor.cacheWrite),
  };
}

/**
 * Syncs latest official pricing without altering historical token calculations.
 * If any rate changed compared to the latest snapshot, a new RateSnapshot is appended
 * with `effectiveFrom = new Date().toISOString()` so only future tokens use the new tariff.
 */
export async function syncOfficialPricing(): Promise<{
  updated: boolean;
  effectiveFrom?: string;
}> {
  const current = loadPricing(true);
  const latestSnapshot: RateSnapshot =
    current.history && current.history.length > 0
      ? current.history[current.history.length - 1]
      : { effectiveFrom: '1970-01-01T00:00:00.000Z', models: current.models };

  const candidateModels: Record<string, ModelRate> = structuredClone(latestSnapshot.models);

  // 1. Try syncing from official GitHub repository pricing.json
  let remoteUpdatedAt: string | null = null;
  let repoApplied = false;
  let litellmApplied = false;
  try {
    const res = await fetch(REPO_PRICING_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
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
    // Offline or repo not yet published; proceed to LiteLLM feed
  }

  // 2. Sync official provider per-token rates from LiteLLM registry
  try {
    const res = await fetch(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(3500) });
    if (res.ok) {
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
                : round4(inputPer1M * (existing.provider === 'anthropic' ? 0.1 : 0.25));
            const cacheWritePer1M =
              typeof entry.cache_creation_input_token_cost === 'number' && entry.cache_creation_input_token_cost > 0
                ? round4(entry.cache_creation_input_token_cost * 1_000_000)
                : existing.provider === 'google'
                  ? inputPer1M
                  : existing.cacheWrite;

            candidateModels[ourKey] =
              existing.provider === 'google'
                ? buildGooglePromoRate(ourKey, existing, inputPer1M, outputPer1M, cacheReadPer1M, cacheWritePer1M)
                : {
                    ...existing,
                    input: inputPer1M,
                    output: outputPer1M,
                    cacheRead: cacheReadPer1M,
                    cacheWrite: cacheWritePer1M,
                  };
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

  if (ratesDiffer(latestSnapshot.models, candidateModels)) {
    const remoteIso = remoteUpdatedAt ? `${remoteUpdatedAt}T00:00:00.000Z` : null;
    const effectiveFrom =
      repoApplied && !litellmApplied && remoteIso && remoteIso > latestSnapshot.effectiveFrom
        ? remoteIso
        : new Date().toISOString();
    current.history = current.history || [];
    current.history.push({
      effectiveFrom,
      source: 'official-sync',
      models: candidateModels,
    });
    current.history.sort((a, b) => (a.effectiveFrom > b.effectiveFrom ? 1 : -1));
    current.models = structuredClone(candidateModels);
    current.updatedAt = remoteUpdatedAt && repoApplied && !litellmApplied ? remoteUpdatedAt : effectiveFrom.slice(0, 10);
    cachedPricing = current;
    saveUserLedger(current);
    return { updated: true, effectiveFrom };
  }

  return { updated: false };
}

export function resolveModelKey(
  rawModel: string | undefined | null,
  source: ToolSource,
  pricing: PricingConfig
): string {
  const defaultKey =
    pricing.defaults[source] || (source === 'claude' ? 'claude-sonnet-4' : 'gemini-4-argon');
  if (!rawModel) return defaultKey;

  const cleaned = rawModel.trim().toLowerCase();
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

  if (cleaned.includes('opus')) {
    return cleaned.includes('4') ? 'claude-opus-4' : 'claude-3-opus';
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
  const fallbackKey = pricing.defaults[source];
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

  const cacheReadRate =
    typeof rate.cacheRead === 'number'
      ? rate.cacheRead
      : rate.input * (rate.provider === 'anthropic' ? 0.1 : 0.25);
  const cacheWriteRate =
    typeof rate.cacheWrite === 'number'
      ? rate.cacheWrite
      : rate.input * (rate.provider === 'anthropic' ? 1.25 : 1.0);

  const inputCost = (nonCachedInput / 1_000_000) * rate.input;
  const cacheReadCost = (cacheRead / 1_000_000) * cacheReadRate;
  const cacheWriteCost = (cacheWrite / 1_000_000) * cacheWriteRate;
  const outputCost = (output / 1_000_000) * rate.output;

  const costUSD = inputCost + cacheReadCost + cacheWriteCost + outputCost;
  const cacheSavingsUSD = Math.max(0, (cacheRead / 1_000_000) * (rate.input - cacheReadRate));

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

function formatDisplayModel(raw: string, fallbackLabel: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 34) return fallbackLabel;
  if (trimmed.startsWith('Gemini ') || trimmed.startsWith('Orchestrator (')) return trimmed;
  return fallbackLabel;
}
