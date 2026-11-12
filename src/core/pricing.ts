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
      // Ensure any newly added models in bundled config exist in baseline
      for (const [k, v] of Object.entries(bundled.models)) {
        if (!ledger.models[k]) {
          ledger.models[k] = v;
        }
        if (ledger.history && ledger.history.length > 0 && !ledger.history[0].models[k]) {
          ledger.history[0].models[k] = v;
        }
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
      Boolean(ma.isPromo) !== Boolean(mb.isPromo)
    ) {
      return true;
    }
  }
  return false;
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
  try {
    const res = await fetch(REPO_PRICING_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const remoteConfig = (await res.json()) as Partial<PricingConfig>;
      if (
        remoteConfig.models &&
        typeof remoteConfig.models === 'object' &&
        (!current.updatedAt || (remoteConfig.updatedAt && remoteConfig.updatedAt > current.updatedAt))
      ) {
        for (const [k, rate] of Object.entries(remoteConfig.models)) {
          if (rate && typeof rate.input === 'number' && typeof rate.output === 'number') {
            candidateModels[k] = { ...candidateModels[k], ...rate };
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
          litellmKeys: ['gemini/gemini-3.8-flash', 'gemini-3.8-flash'],
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
            const inputPer1M = Number((entry.input_cost_per_token * 1_000_000).toFixed(4));
            const outputPer1M = Number((entry.output_cost_per_token * 1_000_000).toFixed(4));
            const cacheReadPer1M =
              typeof entry.cache_read_input_token_cost === 'number'
                ? Number((entry.cache_read_input_token_cost * 1_000_000).toFixed(4))
                : Number((inputPer1M * (existing.provider === 'anthropic' ? 0.1 : 0.25)).toFixed(4));
            const cacheWritePer1M =
              typeof entry.cache_creation_input_token_cost === 'number' && entry.cache_creation_input_token_cost > 0
                ? Number((entry.cache_creation_input_token_cost * 1_000_000).toFixed(4))
                : existing.cacheWrite;

            let isPromo = existing.isPromo ?? false;
            let promoNote = existing.promoNote;
            let standardInput = existing.standardInput;
            let standardOutput = existing.standardOutput;

            if (existing.provider === 'google') {
              if (ourKey.includes('flash') && inputPer1M <= 0.75) {
                isPromo = true;
                promoNote = 'Promo Google AI (-50% fino al 31/12/2026)';
                standardInput = standardInput || 1.5;
                standardOutput = standardOutput || 7.5;
              } else if (ourKey.includes('pro') && inputPer1M <= 1.25) {
                isPromo = true;
                promoNote = 'Promo Google AI (<200k tokens)';
                standardInput = standardInput || 2.5;
                standardOutput = standardOutput || 12.5;
              } else if (ourKey.includes('argon')) {
                isPromo = true;
                promoNote = 'Promo Google AI Launch (-50% fino al 30/11/2026)';
                standardInput = 4.0;
                standardOutput = 20.0;
              }
            }

            candidateModels[ourKey] = {
              ...existing,
              input: inputPer1M,
              output: outputPer1M,
              cacheRead: cacheReadPer1M,
              cacheWrite: cacheWritePer1M,
              isPromo,
              promoNote,
              standardInput,
              standardOutput,
            };
            break;
          }
        }
      }
    }
  } catch {
    // Offline fallback: keep local ledger intact
  }

  // Ensure active Google promotional pricing is strictly applied
  if (candidateModels['gemini-4-argon']) {
    candidateModels['gemini-4-argon'] = {
      ...candidateModels['gemini-4-argon'],
      input: 2.0,
      output: 10.0,
      cacheRead: 0.1,
      cacheWrite: 2.0,
      isPromo: true,
      promoNote: 'Promo Google AI Launch (-50% fino al 30/11/2026)',
      standardInput: 4.0,
      standardOutput: 20.0,
    };
  }

  if (ratesDiffer(latestSnapshot.models, candidateModels)) {
    const effectiveFrom = new Date().toISOString();
    current.history = current.history || [];
    current.history.push({
      effectiveFrom,
      source: 'official-sync',
      models: candidateModels,
    });
    current.models = structuredClone(candidateModels);
    current.updatedAt = effectiveFrom.slice(0, 10);
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
  if (trimmed.startsWith('Gemini ')) return trimmed;
  return fallbackLabel;
}
