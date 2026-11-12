import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REPO_PRICING_URL = 'https://raw.githubusercontent.com/Cise07/ai-burnrate-tool/main/config/pricing.json';
let cachedPricing = null;
export function getPackageRoot() {
    let current = __dirname;
    for (let i = 0; i < 4; i++) {
        if (fs.existsSync(path.join(current, 'config', 'pricing.json')) ||
            fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    return process.cwd();
}
export function getUserLedgerPath() {
    return path.join(os.homedir(), '.burnrate', 'pricing-ledger.json');
}
function loadBundledPricing() {
    const root = getPackageRoot();
    const configPath = path.join(root, 'config', 'pricing.json');
    const fallbackPath = path.join(root, 'pricing.json');
    const pricingPath = fs.existsSync(configPath) ? configPath : fallbackPath;
    const raw = fs.readFileSync(pricingPath, 'utf-8');
    return JSON.parse(raw);
}
function ensureHistoryInitialized(config) {
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
export function saveUserLedger(config) {
    try {
        const ledgerPath = getUserLedgerPath();
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        fs.writeFileSync(ledgerPath, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch {
        // Ignore write errors on read-only environments
    }
}
export function loadPricing(forceReload = false) {
    if (cachedPricing && !forceReload)
        return cachedPricing;
    const bundled = ensureHistoryInitialized(loadBundledPricing());
    const ledgerPath = getUserLedgerPath();
    if (fs.existsSync(ledgerPath)) {
        try {
            const ledger = ensureHistoryInitialized(JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')));
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
        }
        catch {
            // Fallback to bundled if ledger is corrupted
        }
    }
    cachedPricing = bundled;
    saveUserLedger(cachedPricing);
    return cachedPricing;
}
function ratesDiffer(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const ma = a[k];
        const mb = b[k];
        if (!ma || !mb)
            return true;
        if (Math.abs(ma.input - mb.input) > 1e-6 ||
            Math.abs(ma.output - mb.output) > 1e-6 ||
            Math.abs(ma.cacheRead - mb.cacheRead) > 1e-6 ||
            Math.abs(ma.cacheWrite - mb.cacheWrite) > 1e-6) {
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
export async function syncOfficialPricing() {
    const current = loadPricing(true);
    const latestSnapshot = current.history && current.history.length > 0
        ? current.history[current.history.length - 1]
        : { effectiveFrom: '1970-01-01T00:00:00.000Z', models: current.models };
    const candidateModels = structuredClone(latestSnapshot.models);
    // 1. Try syncing from official GitHub repository pricing.json
    try {
        const res = await fetch(REPO_PRICING_URL, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const remoteConfig = (await res.json());
            if (remoteConfig.models && typeof remoteConfig.models === 'object') {
                for (const [k, rate] of Object.entries(remoteConfig.models)) {
                    if (rate && typeof rate.input === 'number' && typeof rate.output === 'number') {
                        candidateModels[k] = rate;
                    }
                }
            }
        }
    }
    catch {
        // Offline or repo not yet published; proceed to LiteLLM feed
    }
    // 2. Sync official provider per-token rates from LiteLLM registry
    try {
        const res = await fetch(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
            const litellm = (await res.json());
            const mapping = [
                {
                    ourKey: 'claude-sonnet-4',
                    litellmKeys: ['claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-20250514'],
                },
                {
                    ourKey: 'claude-opus-4',
                    litellmKeys: ['claude-opus-4-20250514', 'anthropic/claude-opus-4-20250514'],
                },
                {
                    ourKey: 'claude-3-7-sonnet',
                    litellmKeys: ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-latest'],
                },
                {
                    ourKey: 'claude-3-5-sonnet',
                    litellmKeys: ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'],
                },
                {
                    ourKey: 'claude-3-5-haiku',
                    litellmKeys: ['claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest'],
                },
                {
                    ourKey: 'gemini-2.5-pro',
                    litellmKeys: ['gemini/gemini-2.5-pro', 'gemini-2.5-pro'],
                },
                {
                    ourKey: 'gemini-2.5-flash',
                    litellmKeys: ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
                },
            ];
            for (const { ourKey, litellmKeys } of mapping) {
                for (const lk of litellmKeys) {
                    const entry = litellm[lk];
                    if (entry &&
                        typeof entry.input_cost_per_token === 'number' &&
                        typeof entry.output_cost_per_token === 'number') {
                        const existing = candidateModels[ourKey];
                        if (!existing)
                            break;
                        const inputPer1M = Number((entry.input_cost_per_token * 1_000_000).toFixed(4));
                        const outputPer1M = Number((entry.output_cost_per_token * 1_000_000).toFixed(4));
                        const cacheReadPer1M = typeof entry.cache_read_input_token_cost === 'number'
                            ? Number((entry.cache_read_input_token_cost * 1_000_000).toFixed(4))
                            : Number((inputPer1M * (existing.provider === 'anthropic' ? 0.1 : 0.25)).toFixed(4));
                        const cacheWritePer1M = typeof entry.cache_creation_input_token_cost === 'number'
                            ? Number((entry.cache_creation_input_token_cost * 1_000_000).toFixed(4))
                            : existing.cacheWrite;
                        candidateModels[ourKey] = {
                            ...existing,
                            input: inputPer1M,
                            output: outputPer1M,
                            cacheRead: cacheReadPer1M,
                            cacheWrite: cacheWritePer1M,
                        };
                        break;
                    }
                }
            }
        }
    }
    catch {
        // Offline fallback: keep local ledger intact
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
export function resolveModelKey(rawModel, source, pricing) {
    const defaultKey = pricing.defaults[source] || (source === 'claude' ? 'claude-sonnet-4' : 'gemini-4-argon');
    if (!rawModel)
        return defaultKey;
    const cleaned = rawModel.trim().toLowerCase();
    if (!cleaned ||
        cleaned === 'auto' ||
        cleaned === 'default' ||
        cleaned === 'inherit' ||
        cleaned === 'none') {
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
        if (cleaned.includes('3-5') || cleaned.includes('3.5'))
            return 'claude-3-5-sonnet';
        if (cleaned.includes('3-7') || cleaned.includes('3.7'))
            return 'claude-3-7-sonnet';
        return 'claude-sonnet-4';
    }
    if (cleaned.includes('argon') ||
        cleaned.includes('ultra') ||
        cleaned.includes('gemini 4') ||
        cleaned.includes('gemini-4')) {
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
/**
 * Resolves the exact ModelRate that was active at `turnTimestamp`.
 * Tokens consumed before a price change continue to use the historical rate active at that time.
 */
export function getHistoricalRate(normalizedModel, source, turnTimestamp, pricing) {
    const fallbackKey = pricing.defaults[source];
    const history = pricing.history;
    if (history && history.length > 0 && turnTimestamp) {
        let activeSnapshot = history[0];
        for (const snap of history) {
            if (snap.effectiveFrom <= turnTimestamp) {
                activeSnapshot = snap;
            }
            else {
                break;
            }
        }
        const historicalRate = activeSnapshot.models[normalizedModel] ?? activeSnapshot.models[fallbackKey];
        if (historicalRate)
            return historicalRate;
    }
    return pricing.models[normalizedModel] ?? pricing.models[fallbackKey];
}
export function calculateTurnCost(params, pricing = loadPricing()) {
    const normalizedModel = resolveModelKey(params.rawModel, params.source, pricing);
    const rate = getHistoricalRate(normalizedModel, params.source, params.timestamp, pricing);
    const nonCachedInput = Math.max(0, params.inputTokens);
    const cacheRead = Math.max(0, params.cacheReadTokens);
    const cacheWrite = Math.max(0, params.cacheWriteTokens);
    const output = Math.max(0, params.outputTokens);
    const totalPromptTokens = nonCachedInput + cacheRead;
    const promptEquivalentCost = (totalPromptTokens / 1_000_000) * rate.input;
    const cacheWriteCost = (cacheWrite / 1_000_000) * rate.cacheWrite;
    const outputCost = (output / 1_000_000) * rate.output;
    const costUSD = promptEquivalentCost + outputCost + cacheWriteCost;
    const cacheSavingsUSD = Math.max(0, (cacheRead / 1_000_000) * (rate.input - rate.cacheRead));
    return {
        normalizedModel,
        modelLabel: params.rawModel && params.rawModel !== 'auto' && params.rawModel !== 'default'
            ? formatDisplayModel(params.rawModel, rate.label)
            : rate.label,
        rate,
        costUSD,
        cacheSavingsUSD,
    };
}
function formatDisplayModel(raw, fallbackLabel) {
    const trimmed = raw.trim();
    if (trimmed.length > 34)
        return fallbackLabel;
    if (trimmed.startsWith('Gemini '))
        return trimmed;
    return fallbackLabel;
}
