import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateTurnCost, loadPricing } from './pricing.js';
import { getSessionKey, reconcileSessionLedger } from './session-ledger.js';
import type { BurnrateSnapshot, PricingConfig, SessionStats, ToolSource, UsageTurn } from './types.js';

const require = createRequire(import.meta.url);

interface AntigravityAppStore {
  hasSummaryDb: boolean;
  hasConversationsDir: boolean;
  summaryIds: Set<string>;
  conversationFileIds: Set<string>;
}

interface StaleSummaryRecord {
  sessionId: string;
  title: string;
  stepCount: number;
  workspace: string;
  lastModifiedTime: string;
}

interface AntigravityMetadata {
  titles: Map<string, string>;
  workspaces: Map<string, string>;
  appStores: Map<string, AntigravityAppStore>;
  allActiveConversationFileIds: Set<string>;
  staleSummaries: Map<string, StaleSummaryRecord>;
}

const ORPHAN_GRACE_MS = 10_000;

function normalizePathKey(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function parseFirstWorkspaceUri(rawUris: string | undefined): string | null {
  if (!rawUris) return null;
  try {
    const parsed = JSON.parse(rawUris);
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') return null;
    const uri = parsed[0].trim();
    if (!uri) return null;
    if (uri.toLowerCase().startsWith('file://')) {
      try {
        return fileURLToPath(uri);
      } catch {
        const decoded = decodeURIComponent(uri.replace(/^file:\/+/i, ''));
        return /^[a-z]:/i.test(decoded) ? decoded : `/${decoded}`;
      }
    }
    return uri;
  } catch {
    return null;
  }
}

function normalizeIsoTimestamp(raw: string | number | undefined): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof raw === 'string' && raw.trim()) {
    const cleaned = raw.trim().replace(' ', 'T');
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1970) return d.toISOString();
  }
  return '';
}

function loadAntigravityMetadata(geminiDir: string): AntigravityMetadata {
  const titles = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const appStores = new Map<string, AntigravityAppStore>();
  const allActiveConversationFileIds = new Set<string>();
  const staleSummaries = new Map<string, StaleSummaryRecord>();

  let DatabaseSync: any = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    DatabaseSync = null;
  }

  const appRoots = [
    path.join(geminiDir, 'antigravity-cli'),
    path.join(geminiDir, 'antigravity'),
    geminiDir,
  ];

  for (const appRoot of appRoots) {
    if (!fs.existsSync(appRoot)) continue;

    const store: AntigravityAppStore = {
      hasSummaryDb: false,
      hasConversationsDir: false,
      summaryIds: new Set<string>(),
      conversationFileIds: new Set<string>(),
    };

    const convDir = path.join(appRoot, 'conversations');
    if (fs.existsSync(convDir)) {
      try {
        const entries = fs.readdirSync(convDir, { withFileTypes: true });
        store.hasConversationsDir = true;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const match = entry.name.match(/^([^.]+)\.(?:db|pb)$/i);
          if (match && match[1]) {
            store.conversationFileIds.add(match[1]);
            allActiveConversationFileIds.add(match[1]);
          }
        }
      } catch {
        // Ignore transient directory read errors
      }
    }

    const dbPath = path.join(appRoot, 'conversation_summaries.db');
    if (DatabaseSync && fs.existsSync(dbPath)) {
      let db: any = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db
          .prepare(
            'SELECT conversation_id, title, step_count, workspace_uris, last_modified_time FROM conversation_summaries'
          )
          .all() as Array<{
          conversation_id?: string;
          title?: string;
          step_count?: number;
          workspace_uris?: string;
          last_modified_time?: string;
        }>;
        store.hasSummaryDb = true;
        for (const row of rows) {
          if (!row.conversation_id) continue;
          const id = row.conversation_id;
          store.summaryIds.add(id);
          const title = row.title?.trim() || '';
          if (title && !titles.has(id)) {
            titles.set(id, title);
          }
          const wsPath = parseFirstWorkspaceUri(row.workspace_uris);
          if (wsPath && !workspaces.has(id)) {
            workspaces.set(id, wsPath);
          }
          const stepCount = Number(row.step_count ?? 0);
          if (
            store.hasConversationsDir &&
            !store.conversationFileIds.has(id) &&
            stepCount > 0 &&
            !staleSummaries.has(id)
          ) {
            staleSummaries.set(id, {
              sessionId: id,
              title: title || id,
              stepCount,
              workspace: wsPath || 'Global / CLI',
              lastModifiedTime: normalizeIsoTimestamp(row.last_modified_time),
            });
          }
        }
      } catch {
        // Ignore locked or incompatible SQLite DB
      } finally {
        try {
          db?.close?.();
        } catch {
          // ignore close error
        }
      }
    }

    if (store.hasConversationsDir || store.hasSummaryDb) {
      appStores.set(normalizePathKey(appRoot), store);
    }
  }

  return { titles, workspaces, appStores, allActiveConversationFileIds, staleSummaries };
}

function collectLegacyDeletedSessions(
  geminiDir: string,
  claudeDir: string,
  antigravityMeta: AntigravityMetadata,
  knownKeys: Set<string>
): SessionStats[] {
  const recovered = new Map<string, SessionStats>();

  // 1. Stale Antigravity summary DB rows whose conversation file & brain logs were deleted before tracking
  for (const [id, rec] of antigravityMeta.staleSummaries.entries()) {
    const key = getSessionKey('antigravity', id);
    if (knownKeys.has(key) || antigravityMeta.allActiveConversationFileIds.has(id)) continue;
    const relWs = toRelativeHomePath(rec.workspace || 'Global / CLI');
    const ts = rec.lastModifiedTime || new Date(0).toISOString();
    recovered.set(key, {
      sessionId: id,
      sessionTitle: rec.title || id,
      source: 'antigravity',
      workspace: relWs,
      workspaceName: formatWorkspaceName(relWs),
      filePath: '',
      startedAt: ts,
      lastActiveAt: ts,
      primaryModel: 'unknown',
      primaryModelLabel: 'Unavailable (legacy)',
      turns: rec.stepCount,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      cacheSavingsUSD: 0,
      estimatedTurns: 0,
      turnHistory: [],
      deleted: true,
      deletedAt: ts,
      untrackedHistory: true,
    });
  }

  // 2. Previously deleted Antigravity CLI chats recorded in antigravity-cli/history.jsonl
  const MAX_HISTORY_BYTES = 25 * 1024 * 1024;
  const agyHistoryPath = path.join(geminiDir, 'antigravity-cli', 'history.jsonl');
  if (fs.existsSync(agyHistoryPath)) {
    try {
      if (fs.statSync(agyHistoryPath).size > MAX_HISTORY_BYTES) throw new Error('history too large');
      const grouped = new Map<
        string,
        { prompts: number; firstPrompt: string; workspace: string; firstTs: number; lastTs: number }
      >();
      const lines = fs.readFileSync(agyHistoryPath, 'utf-8').split(/\r?\n/);
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        const id = typeof obj.conversationId === 'string' ? obj.conversationId.trim() : '';
        if (!id) continue;
        const key = getSessionKey('antigravity', id);
        if (knownKeys.has(key) || antigravityMeta.allActiveConversationFileIds.has(id)) continue;
        const disp = typeof obj.display === 'string' ? cleanChatTitle(obj.display) : '';
        if (!disp || disp.startsWith('/')) continue;
        const ts = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp) ? obj.timestamp : 0;
        const ws = typeof obj.workspace === 'string' && obj.workspace.trim() ? obj.workspace.trim() : '';
        const prev = grouped.get(id);
        if (!prev) {
          grouped.set(id, { prompts: 1, firstPrompt: disp, workspace: ws, firstTs: ts, lastTs: ts });
        } else {
          prev.prompts += 1;
          if (ts && (!prev.firstTs || ts < prev.firstTs)) prev.firstTs = ts;
          if (ts && ts > prev.lastTs) prev.lastTs = ts;
          if (!prev.workspace && ws) prev.workspace = ws;
        }
      }

      for (const [id, info] of grouped.entries()) {
        const key = getSessionKey('antigravity', id);
        const existing = recovered.get(key);
        const startedIso = normalizeIsoTimestamp(info.firstTs) || existing?.startedAt || '';
        const lastIso = normalizeIsoTimestamp(info.lastTs) || existing?.lastActiveAt || startedIso;
        const rawWs = info.workspace || antigravityMeta.workspaces.get(id) || existing?.workspace || 'Global / CLI';
        const relWs = toRelativeHomePath(rawWs);
        const title = antigravityMeta.titles.get(id) || existing?.sessionTitle || info.firstPrompt || id;
        recovered.set(key, {
          sessionId: id,
          sessionTitle: title,
          source: 'antigravity',
          workspace: relWs,
          workspaceName: formatWorkspaceName(relWs),
          filePath: '',
          startedAt: startedIso,
          lastActiveAt: lastIso,
          primaryModel: 'unknown',
          primaryModelLabel: 'Unavailable (legacy)',
          turns: Math.max(info.prompts, existing?.turns ?? 0),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0,
          estimatedTurns: 0,
          turnHistory: [],
          deleted: true,
          deletedAt: lastIso,
          untrackedHistory: true,
        });
      }
    } catch {
      // Ignore unreadable history.jsonl
    }
  }

  // 3. Previously deleted Claude Code chats recorded in ~/.claude/history.jsonl
  const claudeHistoryPath = path.join(claudeDir, 'history.jsonl');
  if (fs.existsSync(claudeHistoryPath)) {
    try {
      if (fs.statSync(claudeHistoryPath).size > MAX_HISTORY_BYTES) throw new Error('history too large');
      const grouped = new Map<
        string,
        { prompts: number; firstPrompt: string; workspace: string; firstTs: number; lastTs: number }
      >();
      const lines = fs.readFileSync(claudeHistoryPath, 'utf-8').split(/\r?\n/);
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        const id = typeof obj.sessionId === 'string' ? obj.sessionId.trim() : '';
        if (!id) continue;
        const key = getSessionKey('claude', id);
        if (knownKeys.has(key)) continue;
        const disp = typeof obj.display === 'string' ? cleanChatTitle(obj.display) : '';
        if (!disp || disp.startsWith('/')) continue;
        const ts = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp) ? obj.timestamp : 0;
        const ws = typeof obj.project === 'string' && obj.project.trim() ? obj.project.trim() : '';
        const prev = grouped.get(id);
        if (!prev) {
          grouped.set(id, { prompts: 1, firstPrompt: disp, workspace: ws, firstTs: ts, lastTs: ts });
        } else {
          prev.prompts += 1;
          if (ts && (!prev.firstTs || ts < prev.firstTs)) prev.firstTs = ts;
          if (ts && ts > prev.lastTs) prev.lastTs = ts;
          if (!prev.workspace && ws) prev.workspace = ws;
        }
      }

      for (const [id, info] of grouped.entries()) {
        const key = getSessionKey('claude', id);
        const startedIso = normalizeIsoTimestamp(info.firstTs);
        const lastIso = normalizeIsoTimestamp(info.lastTs) || startedIso;
        const relWs = toRelativeHomePath(info.workspace || 'Global / CLI');
        recovered.set(key, {
          sessionId: id,
          sessionTitle: info.firstPrompt || id,
          source: 'claude',
          workspace: relWs,
          workspaceName: formatWorkspaceName(relWs),
          filePath: '',
          startedAt: startedIso,
          lastActiveAt: lastIso,
          primaryModel: 'unknown',
          primaryModelLabel: 'Unavailable (legacy)',
          turns: info.prompts,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0,
          estimatedTurns: 0,
          turnHistory: [],
          deleted: true,
          deletedAt: lastIso,
          untrackedHistory: true,
        });
      }
    } catch {
      // Ignore unreadable history.jsonl
    }
  }

  return Array.from(recovered.values()).sort((a, b) => {
    const aKey = a.deletedAt || a.lastActiveAt || '';
    const bKey = b.deletedAt || b.lastActiveAt || '';
    return bKey > aKey ? 1 : -1;
  });
}

function isOrphanedAntigravitySession(
  filePath: string,
  sessionId: string,
  meta: AntigravityMetadata
): boolean {
  const normFile = path.resolve(filePath).replace(/\\/g, '/');
  const brainIdx = normFile.toLowerCase().lastIndexOf('/brain/');
  if (brainIdx <= 0) return false;

  const appRootKey = normFile.slice(0, brainIdx).toLowerCase();
  const store = meta.appStores.get(appRootKey);
  if (!store) return false;

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return true;
  }
  if (Date.now() - mtimeMs < ORPHAN_GRACE_MS) {
    return false;
  }

  if (store.hasConversationsDir) {
    return !store.conversationFileIds.has(sessionId);
  }
  if (store.hasSummaryDb && store.summaryIds.size > 0) {
    return !store.summaryIds.has(sessionId);
  }
  return false;
}

function cleanChatTitle(raw: string, maxLen = 72): string {
  const userReqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const base = userReqMatch ? userReqMatch[1] : raw;
  const cleaned = base
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/gi, ' ')
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1).trimEnd()}…` : cleaned;
}

function extractClaudeUserText(msgContent: unknown): string {
  if (typeof msgContent === 'string') return msgContent;
  if (Array.isArray(msgContent)) {
    return msgContent
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

function formatSlugTitle(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  session: SessionStats | null;
}

const fileCache = new Map<string, CachedFileEntry>();

export function getWatchRoots(): { geminiDir: string; claudeDir: string } {
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

export function toRelativeHomePath(targetPath: string): string {
  if (!targetPath) return targetPath;
  const home = os.homedir();
  const normTarget = path.normalize(targetPath);
  const normHome = path.normalize(home);
  if (normTarget.toLowerCase().startsWith(normHome.toLowerCase())) {
    const rel = normTarget.slice(normHome.length).replace(/^[\\/]+/, '');
    return rel ? `~/${rel.replace(/\\/g, '/')}` : '~';
  }
  return targetPath.replace(/\\/g, '/');
}

function shouldSkipJsonlFile(filePath: string, source: ToolSource): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);

  if (source === 'antigravity') {
    if (base === 'transcript_full.jsonl') return true;
    if (normalized.includes('/.system_generated/logs/chunks/')) return true;
  }

  if (source === 'claude') {
    if (base === 'history.jsonl' && !normalized.includes('/projects/')) return true;
  }

  return false;
}

function collectJsonlFiles(dirPath: string, source: ToolSource, results: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return results;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
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
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (!shouldSkipJsonlFile(fullPath, source)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function estimateTokensFromText(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function cleanStringArg(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  return val.replace(/^"+|"+$/g, '').replace(/\\\\/g, '\\').trim() || null;
}

function extractWorkspaceFromPathCandidate(rawPath: string | null): string | null {
  if (!rawPath) return null;
  const cleaned = cleanStringArg(rawPath);
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\\/g, '/');
  if (normalized.includes('/.gemini/') || normalized.includes('/.claude/')) return null;

  const base = path.basename(normalized);
  if (base.includes('.') && !base.startsWith('.')) {
    return path.dirname(cleaned);
  }
  return cleaned;
}

function formatWorkspaceName(workspacePath: string): string {
  if (!workspacePath || workspacePath === 'Global / CLI') return 'Global / CLI';
  const normalized = workspacePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return workspacePath;
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1];
}

function decodeClaudeProjectFolder(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/\.claude\/projects\/([^/]+)\//i);
  if (!match) return 'Global / CLI';
  const encoded = match[1];
  const driveMatch = encoded.match(/^([A-Za-z])--(.+)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const tail = driveMatch[2].replace(/-/g, '/');
    return `${drive}:/${tail}`;
  }
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function extractAntigravitySessionId(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/brain\/([^/]+)\//i);
  if (match) return match[1];
  return path.basename(filePath, '.jsonl');
}

function parseAntigravityFile(
  filePath: string,
  stat: fs.Stats,
  pricing: PricingConfig,
  antigravityTitles?: Map<string, string>,
  antigravityWorkspaces?: Map<string, string>
): SessionStats | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const sessionId = extractAntigravitySessionId(filePath);
  let currentModel = 'Gemini 4 Argon';
  let workspace: string | null = null;
  let lastUserPromptChars = 0;
  let firstUserTitle = '';

  const turnHistory: UsageTurn[] = [];
  let startedAt = '';
  let lastActiveAt = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;

    let obj: Record<string, any>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp: string =
      typeof obj.created_at === 'string'
        ? obj.created_at
        : typeof obj.timestamp === 'string'
          ? obj.timestamp
          : new Date(stat.mtimeMs).toISOString();

    if (!startedAt || timestamp < startedAt) startedAt = timestamp;
    if (!lastActiveAt || timestamp > lastActiveAt) lastActiveAt = timestamp;

    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      lastUserPromptChars = obj.content.length;
      if (!firstUserTitle) {
        const candidateTitle = cleanChatTitle(obj.content);
        if (candidateTitle) firstUserTitle = candidateTitle;
      }
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
        const candidate =
          extractWorkspaceFromPathCandidate(args.Cwd) ||
          extractWorkspaceFromPathCandidate(args.DirectoryPath) ||
          extractWorkspaceFromPathCandidate(args.SearchPath) ||
          extractWorkspaceFromPathCandidate(args.Path);
        if (candidate) {
          workspace = candidate;
          break;
        }
      }
    }

    const isPlannerResponse =
      obj.type === 'PLANNER_RESPONSE' ||
      (obj.source === 'MODEL' &&
        (typeof obj.input_tokens === 'number' ||
          typeof obj.output_tokens === 'number' ||
          typeof obj.thinking === 'string' ||
          Array.isArray(obj.tool_calls)));

    if (!isPlannerResponse && obj.type === 'GENERIC') {
      continue;
    }

    if (isPlannerResponse) {
      const hasExplicitTokens =
        typeof obj.input_tokens === 'number' ||
        typeof obj.output_tokens === 'number' ||
        typeof obj.cache_read_tokens === 'number';

      let inputTokens = Number(obj.input_tokens ?? 0);
      let outputTokens = Number(obj.output_tokens ?? 0);
      let cacheReadTokens = Number(obj.cache_read_tokens ?? obj.cached_tokens ?? 0);
      let cacheWriteTokens = Number(obj.cache_creation_tokens ?? 0);
      let estimated = false;

      if (!hasExplicitTokens) {
        const outText =
          (typeof obj.content === 'string' ? obj.content : '') +
          (typeof obj.thinking === 'string' ? obj.thinking : '') +
          (Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls) : '');
        if (!outText) continue;
        inputTokens = Math.max(250, Math.ceil(lastUserPromptChars / 4));
        outputTokens = estimateTokensFromText(outText);
        estimated = true;
      }

      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      if (totalTokens <= 0) continue;

      const turnModel =
        typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : currentModel;

      const costCalc = calculateTurnCost(
        {
          rawModel: turnModel,
          source: 'antigravity',
          timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        pricing
      );

      turnHistory.push({
        timestamp,
        model: turnModel,
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

  if (turnHistory.length === 0) return null;

  const sessionTitle = antigravityTitles?.get(sessionId) || firstUserTitle || sessionId;
  const resolvedWorkspace = workspace || antigravityWorkspaces?.get(sessionId) || 'Global / CLI';

  return summarizeSession({
    sessionId,
    sessionTitle,
    source: 'antigravity',
    workspace: toRelativeHomePath(resolvedWorkspace),
    filePath: toRelativeHomePath(filePath),
    startedAt: startedAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
    turnHistory,
  });
}

function parseClaudeFile(filePath: string, stat: fs.Stats, pricing: PricingConfig): SessionStats | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  let sessionId = path.basename(filePath, '.jsonl');
  let workspace: string | null = null;
  let startedAt = '';
  let lastActiveAt = '';
  let lastUserPromptChars = 0;
  let customTitle = '';
  let summaryTitle = '';
  let slugTitle = '';
  let firstUserTitle = '';
  let fallbackSlashTitle = '';

  const turnMap = new Map<string, UsageTurn>();
  let fallbackCounter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;

    let obj: Record<string, any>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof obj.sessionId === 'string' && obj.sessionId) {
      sessionId = obj.sessionId;
    } else if (typeof obj.session_id === 'string' && obj.session_id) {
      sessionId = obj.session_id;
    }

    if (typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
      customTitle = cleanChatTitle(obj.customTitle);
    }
    if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
      summaryTitle = cleanChatTitle(obj.summary);
    }
    if (!slugTitle && typeof obj.slug === 'string' && obj.slug.trim()) {
      slugTitle = obj.slug.trim();
    }

    if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
      workspace = obj.cwd.trim();
    }

    const timestamp: string =
      typeof obj.timestamp === 'string'
        ? obj.timestamp
        : typeof obj.snapshot?.timestamp === 'string'
          ? obj.snapshot.timestamp
          : new Date(stat.mtimeMs).toISOString();

    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastActiveAt || timestamp > lastActiveAt) lastActiveAt = timestamp;
    }

    if (obj.type === 'user' || obj.message?.role === 'user') {
      const msgContent = obj.message?.content ?? obj.content;
      const text = typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent ?? '');
      lastUserPromptChars = text.length;
      if (!firstUserTitle) {
        const userText = extractClaudeUserText(msgContent);
        const candidate = cleanChatTitle(userText);
        if (candidate && candidate !== '[Request interrupted by user]') {
          if (candidate.startsWith('/')) {
            if (!fallbackSlashTitle) fallbackSlashTitle = candidate;
          } else {
            firstUserTitle = candidate;
          }
        }
      }
      continue;
    }

    const isAssistant = obj.type === 'assistant' || obj.message?.role === 'assistant';
    if (!isAssistant) continue;

    const msg = obj.message || obj;
    const msgId: string =
      typeof msg.id === 'string' && msg.id
        ? msg.id
        : typeof obj.uuid === 'string' && obj.uuid
          ? obj.uuid
          : `turn_${++fallbackCounter}`;

    const rawModel: string =
      (typeof msg.model === 'string' && msg.model !== 'auto' ? msg.model : null) ||
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
    } else {
      const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      if (!textContent) continue;
      inputTokens = Math.max(250, Math.ceil(lastUserPromptChars / 4));
      outputTokens = estimateTokensFromText(textContent);
      estimated = true;
    }

    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (totalTokens <= 0) continue;

    const costCalc = calculateTurnCost(
      {
        rawModel,
        source: 'claude',
        timestamp,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      },
      pricing
    );

    const turn: UsageTurn = {
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
  if (turnHistory.length === 0) return null;

  const resolvedWs = workspace || decodeClaudeProjectFolder(filePath);
  const sessionTitle =
    customTitle ||
    summaryTitle ||
    firstUserTitle ||
    (slugTitle ? formatSlugTitle(slugTitle) : '') ||
    fallbackSlashTitle ||
    sessionId;

  return summarizeSession({
    sessionId,
    sessionTitle,
    source: 'claude',
    workspace: toRelativeHomePath(resolvedWs),
    filePath: toRelativeHomePath(filePath),
    startedAt: startedAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
    turnHistory,
  });
}

function summarizeSession(params: {
  sessionId: string;
  sessionTitle: string;
  source: ToolSource;
  workspace: string;
  filePath: string;
  startedAt: string;
  lastActiveAt: string;
  turnHistory: UsageTurn[];
}): SessionStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let costUSD = 0;
  let cacheSavingsUSD = 0;
  let estimatedTurns = 0;

  const modelCounts = new Map<string, { count: number; label: string }>();

  for (const turn of params.turnHistory) {
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    cacheReadTokens += turn.cacheReadTokens;
    cacheWriteTokens += turn.cacheWriteTokens;
    totalTokens += turn.totalTokens;
    costUSD += turn.costUSD;
    cacheSavingsUSD += turn.cacheSavingsUSD;
    if (turn.estimated) estimatedTurns++;

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
    sessionTitle: params.sessionTitle,
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

export function parseSingleFile(
  filePath: string,
  source: ToolSource,
  pricing: PricingConfig = loadPricing(),
  antigravityTitles?: Map<string, string>,
  antigravityWorkspaces?: Map<string, string>
): SessionStats | null {
  if (shouldSkipJsonlFile(filePath, source)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return null;
  }

  let resolvedTitles = antigravityTitles;
  let resolvedWorkspaces = antigravityWorkspaces;
  if (source === 'antigravity' && (!resolvedTitles || !resolvedWorkspaces)) {
    const meta = loadAntigravityMetadata(getWatchRoots().geminiDir);
    resolvedTitles = resolvedTitles || meta.titles;
    resolvedWorkspaces = resolvedWorkspaces || meta.workspaces;
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    if (cached.session && resolvedTitles) {
      const dbTitle = resolvedTitles.get(cached.session.sessionId);
      if (dbTitle) cached.session.sessionTitle = dbTitle;
    }
    if (cached.session && resolvedWorkspaces && cached.session.workspace === 'Global / CLI') {
      const dbWs = resolvedWorkspaces.get(cached.session.sessionId);
      if (dbWs) {
        const rel = toRelativeHomePath(dbWs);
        cached.session.workspace = rel;
        cached.session.workspaceName = formatWorkspaceName(rel);
      }
    }
    return cached.session;
  }

  const session =
    source === 'antigravity'
      ? parseAntigravityFile(filePath, stat, pricing, resolvedTitles, resolvedWorkspaces)
      : parseClaudeFile(filePath, stat, pricing);

  fileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    session,
  });

  return session;
}

export function scanAllLogs(forceClearCache = false): BurnrateSnapshot {
  if (forceClearCache) {
    fileCache.clear();
  }

  const pricing = loadPricing(forceClearCache);
  const { geminiDir, claudeDir } = getWatchRoots();
  const antigravityMeta = loadAntigravityMetadata(geminiDir);

  const geminiFiles = collectJsonlFiles(geminiDir, 'antigravity');
  const claudeFiles = collectJsonlFiles(claudeDir, 'claude');

  // Purge stale entries from fileCache for files deleted from disk
  const seenFiles = new Set<string>([...geminiFiles, ...claudeFiles]);
  for (const cachedPath of fileCache.keys()) {
    if (!seenFiles.has(cachedPath)) {
      fileCache.delete(cachedPath);
    }
  }

  const liveSessions: SessionStats[] = [];
  const orphanedDeletedSessions: SessionStats[] = [];

  for (const file of geminiFiles) {
    const session = parseSingleFile(
      file,
      'antigravity',
      pricing,
      antigravityMeta.titles,
      antigravityMeta.workspaces
    );
    if (!session) continue;
    if (isOrphanedAntigravitySession(file, session.sessionId, antigravityMeta)) {
      orphanedDeletedSessions.push(session);
    } else {
      liveSessions.push(session);
    }
  }

  for (const file of claudeFiles) {
    const session = parseSingleFile(file, 'claude', pricing);
    if (session) liveSessions.push(session);
  }

  const { activeSessions, deletedSessions: ledgerDeleted } = reconcileSessionLedger({
    liveSessions,
    orphanedDeletedSessions,
    geminiDirExists: fs.existsSync(geminiDir),
    claudeDirExists: fs.existsSync(claudeDir),
  });

  const knownKeys = new Set<string>();
  for (const s of activeSessions) knownKeys.add(getSessionKey(s.source, s.sessionId));
  for (const s of ledgerDeleted) knownKeys.add(getSessionKey(s.source, s.sessionId));

  const legacyDeleted = collectLegacyDeletedSessions(geminiDir, claudeDir, antigravityMeta, knownKeys);
  const deletedSessions = [...ledgerDeleted, ...legacyDeleted].sort((a, b) => {
    const aKey = a.deletedAt || a.lastActiveAt || '';
    const bKey = b.deletedAt || b.lastActiveAt || '';
    return bKey > aKey ? 1 : -1;
  });

  return {
    generatedAt: new Date().toISOString(),
    watchedPaths: [toRelativeHomePath(geminiDir), toRelativeHomePath(claudeDir)],
    pricing,
    sessions: activeSessions,
    deletedSessions,
  };
}
