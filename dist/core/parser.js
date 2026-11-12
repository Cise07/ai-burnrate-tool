import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateTurnCost, loadPricing } from './pricing.js';
const fileCache = new Map();
export function getWatchRoots() {
    const home = os.homedir();
    return {
        geminiDir: process.env.BURNRATE_GEMINI_DIR
            ? path.resolve(process.env.BURNRATE_GEMINI_DIR)
            : path.join(home, '.gemini'),
        claudeDir: process.env.BURNRATE_CLAUDE_DIR
            ? path.resolve(process.env.BURNRATE_CLAUDE_DIR)
            : path.join(home, '.claude'),
    };
}
export function toRelativeHomePath(targetPath) {
    if (!targetPath)
        return targetPath;
    const home = os.homedir();
    const normTarget = path.normalize(targetPath);
    const normHome = path.normalize(home);
    if (normTarget.toLowerCase().startsWith(normHome.toLowerCase())) {
        const rel = normTarget.slice(normHome.length).replace(/^[\\/]+/, '');
        return rel ? `~/${rel.replace(/\\/g, '/')}` : '~';
    }
    return targetPath.replace(/\\/g, '/');
}
function shouldSkipJsonlFile(filePath, source) {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(normalized);
    if (source === 'antigravity') {
        if (base === 'transcript_full.jsonl')
            return true;
        if (normalized.includes('/.system_generated/logs/chunks/'))
            return true;
    }
    if (source === 'claude') {
        if (base === 'history.jsonl' && !normalized.includes('/projects/'))
            return true;
    }
    return false;
}
function collectJsonlFiles(dirPath, source, results = []) {
    if (!fs.existsSync(dirPath))
        return results;
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const lower = entry.name.toLowerCase();
            if (lower === 'node_modules' || lower === '.git' || lower === 'chunks' || lower === 'cache' || lower === 'downloads') {
                continue;
            }
            collectJsonlFiles(fullPath, source, results);
        }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            if (!shouldSkipJsonlFile(fullPath, source)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}
function estimateTokensFromText(text) {
    if (!text)
        return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}
function cleanStringArg(val) {
    if (typeof val !== 'string')
        return null;
    return val.replace(/^"+|"+$/g, '').replace(/\\\\/g, '\\').trim() || null;
}
function extractWorkspaceFromPathCandidate(rawPath) {
    if (!rawPath)
        return null;
    const cleaned = cleanStringArg(rawPath);
    if (!cleaned)
        return null;
    const normalized = cleaned.replace(/\\/g, '/');
    if (normalized.includes('/.gemini/') || normalized.includes('/.claude/'))
        return null;
    const base = path.basename(normalized);
    if (base.includes('.') && !base.startsWith('.')) {
        return path.dirname(cleaned);
    }
    return cleaned;
}
function formatWorkspaceName(workspacePath) {
    if (!workspacePath || workspacePath === 'Global / CLI')
        return 'Global / CLI';
    const normalized = workspacePath.replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0)
        return workspacePath;
    if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1];
}
function decodeClaudeProjectFolder(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/\/\.claude\/projects\/([^/]+)\//i);
    if (!match)
        return 'Global / CLI';
    const encoded = match[1];
    const driveMatch = encoded.match(/^([A-Za-z])--(.+)$/);
    if (driveMatch) {
        const drive = driveMatch[1].toUpperCase();
        const tail = driveMatch[2].replace(/-/g, '/');
        return `${drive}:/${tail}`;
    }
    return encoded.replace(/^-/, '/').replace(/-/g, '/');
}
function extractAntigravitySessionId(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/\/brain\/([^/]+)\//i);
    if (match)
        return match[1];
    return path.basename(filePath, '.jsonl');
}
function parseAntigravityFile(filePath, stat, pricing) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
    const lines = content.split(/\r?\n/);
    const sessionId = extractAntigravitySessionId(filePath);
    let currentModel = 'Gemini 4 Argon';
    let workspace = null;
    let lastUserPromptChars = 0;
    const turnHistory = [];
    let startedAt = '';
    let lastActiveAt = '';
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('{'))
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        const timestamp = typeof obj.created_at === 'string'
            ? obj.created_at
            : typeof obj.timestamp === 'string'
                ? obj.timestamp
                : new Date(stat.mtimeMs).toISOString();
        if (!startedAt || timestamp < startedAt)
            startedAt = timestamp;
        if (!lastActiveAt || timestamp > lastActiveAt)
            lastActiveAt = timestamp;
        if (typeof obj.model === 'string' && obj.model.trim()) {
            currentModel = obj.model.trim();
        }
        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
            lastUserPromptChars = obj.content.length;
            const modelMatch = obj.content.match(/Model Selection`?\s+from\s+[^\r\n]+?\s+to\s+([^\r\n]+?)\.(?:\s|$)/i);
            if (modelMatch && modelMatch[1]) {
                currentModel = modelMatch[1].trim();
            }
            const wsMatch = obj.content.match(/Command Working Directory:\s*([^\r\n<]+)/i);
            if (wsMatch && wsMatch[1]) {
                workspace = wsMatch[1].trim();
            }
        }
        if (!workspace && Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
                const args = tc?.args || tc?.arguments || {};
                const candidate = extractWorkspaceFromPathCandidate(args.Cwd) ||
                    extractWorkspaceFromPathCandidate(args.DirectoryPath) ||
                    extractWorkspaceFromPathCandidate(args.SearchPath) ||
                    extractWorkspaceFromPathCandidate(args.Path);
                if (candidate) {
                    workspace = candidate;
                    break;
                }
            }
        }
        const isPlannerResponse = obj.type === 'PLANNER_RESPONSE' ||
            (obj.source === 'MODEL' &&
                (typeof obj.input_tokens === 'number' ||
                    typeof obj.output_tokens === 'number' ||
                    typeof obj.thinking === 'string' ||
                    Array.isArray(obj.tool_calls)));
        if (!isPlannerResponse && obj.type === 'GENERIC') {
            continue;
        }
        if (isPlannerResponse) {
            const hasExplicitTokens = typeof obj.input_tokens === 'number' ||
                typeof obj.output_tokens === 'number' ||
                typeof obj.cache_read_tokens === 'number';
            let inputTokens = Number(obj.input_tokens ?? 0);
            let outputTokens = Number(obj.output_tokens ?? 0);
            let cacheReadTokens = Number(obj.cache_read_tokens ?? obj.cached_tokens ?? 0);
            let cacheWriteTokens = Number(obj.cache_creation_tokens ?? 0);
            let estimated = false;
            if (!hasExplicitTokens) {
                const outText = (typeof obj.content === 'string' ? obj.content : '') +
                    (typeof obj.thinking === 'string' ? obj.thinking : '') +
                    (Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls) : '');
                if (!outText)
                    continue;
                inputTokens = Math.max(250, Math.ceil(lastUserPromptChars / 4));
                outputTokens = estimateTokensFromText(outText);
                estimated = true;
            }
            const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
            if (totalTokens <= 0)
                continue;
            const costCalc = calculateTurnCost({
                rawModel: currentModel,
                source: 'antigravity',
                timestamp,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
            }, pricing);
            turnHistory.push({
                timestamp,
                model: currentModel,
                normalizedModel: costCalc.normalizedModel,
                modelLabel: costCalc.modelLabel,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                totalTokens,
                costUSD: costCalc.costUSD,
                cacheSavingsUSD: costCalc.cacheSavingsUSD,
                estimated,
            });
        }
    }
    if (turnHistory.length === 0)
        return null;
    return summarizeSession({
        sessionId,
        source: 'antigravity',
        workspace: toRelativeHomePath(workspace || 'Global / CLI'),
        filePath: toRelativeHomePath(filePath),
        startedAt: startedAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
        turnHistory,
    });
}
function parseClaudeFile(filePath, stat, pricing) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
    const lines = content.split(/\r?\n/);
    let sessionId = path.basename(filePath, '.jsonl');
    let workspace = null;
    let startedAt = '';
    let lastActiveAt = '';
    let lastUserPromptChars = 0;
    const turnMap = new Map();
    let fallbackCounter = 0;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('{'))
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof obj.sessionId === 'string' && obj.sessionId) {
            sessionId = obj.sessionId;
        }
        else if (typeof obj.session_id === 'string' && obj.session_id) {
            sessionId = obj.session_id;
        }
        if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
            workspace = obj.cwd.trim();
        }
        const timestamp = typeof obj.timestamp === 'string'
            ? obj.timestamp
            : typeof obj.snapshot?.timestamp === 'string'
                ? obj.snapshot.timestamp
                : new Date(stat.mtimeMs).toISOString();
        if (timestamp) {
            if (!startedAt || timestamp < startedAt)
                startedAt = timestamp;
            if (!lastActiveAt || timestamp > lastActiveAt)
                lastActiveAt = timestamp;
        }
        if (obj.type === 'user' || obj.message?.role === 'user') {
            const msgContent = obj.message?.content ?? obj.content;
            const text = typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent ?? '');
            lastUserPromptChars = text.length;
            continue;
        }
        const isAssistant = obj.type === 'assistant' || obj.message?.role === 'assistant';
        if (!isAssistant)
            continue;
        const msg = obj.message || obj;
        const msgId = typeof msg.id === 'string' && msg.id
            ? msg.id
            : typeof obj.uuid === 'string' && obj.uuid
                ? obj.uuid
                : `turn_${++fallbackCounter}`;
        const rawModel = (typeof msg.model === 'string' && msg.model !== 'auto' ? msg.model : null) ||
            (typeof obj.requestedModel === 'string' && obj.requestedModel !== 'auto' ? obj.requestedModel : null) ||
            (typeof msg.model === 'string' ? msg.model : 'claude-sonnet-4');
        const usage = msg.usage || obj.usage;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let estimated = false;
        if (usage && typeof usage === 'object') {
            inputTokens = Number(usage.input_tokens ?? 0);
            outputTokens = Number(usage.output_tokens ?? 0);
            cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0);
            cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0);
        }
        else {
            const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
            if (!textContent)
                continue;
            inputTokens = Math.max(250, Math.ceil(lastUserPromptChars / 4));
            outputTokens = estimateTokensFromText(textContent);
            estimated = true;
        }
        const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
        if (totalTokens <= 0)
            continue;
        const costCalc = calculateTurnCost({
            rawModel,
            source: 'claude',
            timestamp,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
        }, pricing);
        const turn = {
            timestamp,
            model: rawModel,
            normalizedModel: costCalc.normalizedModel,
            modelLabel: costCalc.modelLabel,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens,
            costUSD: costCalc.costUSD,
            cacheSavingsUSD: costCalc.cacheSavingsUSD,
            estimated,
        };
        const existing = turnMap.get(msgId);
        if (!existing || turn.totalTokens >= existing.totalTokens) {
            turnMap.set(msgId, turn);
        }
    }
    const turnHistory = Array.from(turnMap.values());
    if (turnHistory.length === 0)
        return null;
    const resolvedWs = workspace || decodeClaudeProjectFolder(filePath);
    return summarizeSession({
        sessionId,
        source: 'claude',
        workspace: toRelativeHomePath(resolvedWs),
        filePath: toRelativeHomePath(filePath),
        startedAt: startedAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
        turnHistory,
    });
}
function summarizeSession(params) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costUSD = 0;
    let cacheSavingsUSD = 0;
    let estimatedTurns = 0;
    const modelCounts = new Map();
    for (const turn of params.turnHistory) {
        inputTokens += turn.inputTokens;
        outputTokens += turn.outputTokens;
        cacheReadTokens += turn.cacheReadTokens;
        cacheWriteTokens += turn.cacheWriteTokens;
        totalTokens += turn.totalTokens;
        costUSD += turn.costUSD;
        cacheSavingsUSD += turn.cacheSavingsUSD;
        if (turn.estimated)
            estimatedTurns++;
        const prev = modelCounts.get(turn.normalizedModel);
        modelCounts.set(turn.normalizedModel, {
            count: (prev?.count ?? 0) + 1,
            label: turn.modelLabel,
        });
    }
    let primaryModel = params.turnHistory[params.turnHistory.length - 1]?.normalizedModel || 'unknown';
    let primaryModelLabel = params.turnHistory[params.turnHistory.length - 1]?.modelLabel || 'Unknown';
    let maxCount = -1;
    for (const [modelKey, info] of modelCounts.entries()) {
        if (info.count >= maxCount) {
            maxCount = info.count;
            primaryModel = modelKey;
            primaryModelLabel = info.label;
        }
    }
    return {
        sessionId: params.sessionId,
        source: params.source,
        workspace: params.workspace,
        workspaceName: formatWorkspaceName(params.workspace),
        filePath: params.filePath,
        startedAt: params.startedAt,
        lastActiveAt: params.lastActiveAt,
        primaryModel,
        primaryModelLabel,
        turns: params.turnHistory.length,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costUSD,
        cacheSavingsUSD,
        estimatedTurns,
        turnHistory: params.turnHistory,
    };
}
export function parseSingleFile(filePath, source, pricing = loadPricing()) {
    if (shouldSkipJsonlFile(filePath, source))
        return null;
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        fileCache.delete(filePath);
        return null;
    }
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.session;
    }
    const session = source === 'antigravity'
        ? parseAntigravityFile(filePath, stat, pricing)
        : parseClaudeFile(filePath, stat, pricing);
    fileCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        session,
    });
    return session;
}
export function scanAllLogs(forceClearCache = false) {
    if (forceClearCache) {
        fileCache.clear();
    }
    const pricing = loadPricing(forceClearCache);
    const { geminiDir, claudeDir } = getWatchRoots();
    const geminiFiles = collectJsonlFiles(geminiDir, 'antigravity');
    const claudeFiles = collectJsonlFiles(claudeDir, 'claude');
    const sessions = [];
    for (const file of geminiFiles) {
        const session = parseSingleFile(file, 'antigravity', pricing);
        if (session)
            sessions.push(session);
    }
    for (const file of claudeFiles) {
        const session = parseSingleFile(file, 'claude', pricing);
        if (session)
            sessions.push(session);
    }
    sessions.sort((a, b) => (b.lastActiveAt > a.lastActiveAt ? 1 : -1));
    return {
        generatedAt: new Date().toISOString(),
        watchedPaths: [toRelativeHomePath(geminiDir), toRelativeHomePath(claudeDir)],
        pricing,
        sessions,
    };
}
