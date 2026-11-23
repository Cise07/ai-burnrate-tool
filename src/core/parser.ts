import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHooksStatus } from './hooks.js';
import { calculateTurnCost, loadPricing } from './pricing.js';
import {
  getDismissedLegacyCount,
  getDismissedLegacyKeys,
  getSessionKey,
  reconcileSessionLedger,
  upsertSingleSessionToLedger,
} from './session-ledger.js';
import { loadUserSettings } from './settings.js';
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
  parentIds: Map<string, string>;
  agentNames: Map<string, string>;
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
  const parentIds = new Map<string, string>();
  const agentNames = new Map<string, string>();
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
        let rows: Array<{
          conversation_id?: string;
          title?: string;
          step_count?: number;
          workspace_uris?: string;
          last_modified_time?: string;
          agent_name?: string;
          parent_conversation_id?: string;
        }>;
        try {
          rows = db
            .prepare(
              'SELECT conversation_id, title, step_count, workspace_uris, last_modified_time, agent_name, parent_conversation_id FROM conversation_summaries'
            )
            .all();
        } catch {
          rows = db
            .prepare(
              'SELECT conversation_id, title, step_count, workspace_uris, last_modified_time FROM conversation_summaries'
            )
            .all();
        }
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
          const agentName = row.agent_name?.trim() || '';
          if (agentName && !agentNames.has(id)) {
            agentNames.set(id, agentName);
          }
          const parentId = row.parent_conversation_id?.trim() || '';
          if (parentId && parentId !== id && !parentIds.has(id)) {
            parentIds.set(id, parentId);
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
        try {
          const parentRows = db
            .prepare('SELECT conversation_id, parent_id FROM conversation_parents')
            .all() as Array<{ conversation_id?: string; parent_id?: string }>;
          for (const pr of parentRows) {
            const cid = pr.conversation_id?.trim() || '';
            const pid = pr.parent_id?.trim() || '';
            if (cid && pid && cid !== pid && !parentIds.has(cid)) {
              parentIds.set(cid, pid);
            }
          }
        } catch {
          // conversation_parents table may not exist on older DBs
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

  return { titles, workspaces, parentIds, agentNames, appStores, allActiveConversationFileIds, staleSummaries };
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
    if (
      knownKeys.has(key) ||
      antigravityMeta.allActiveConversationFileIds.has(id) ||
      antigravityMeta.parentIds.has(id)
    ) {
      continue;
    }
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

interface CodexThreadRelation {
  sessionId: string;
  parentSessionId?: string;
  isSideChat: boolean;
  subagentName?: string;
  workspace?: string;
}

interface CodexMetadata {
  titles: Map<string, string>;
  parentIds: Map<string, string>;
  sideChatIds: Set<string>;
  agentNames: Map<string, string>;
  workspaces: Map<string, string>;
}

interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  session: SessionStats | null;
  codexRelation?: CodexThreadRelation | null;
}

const fileCache = new Map<string, CachedFileEntry>();

export function getWatchRoots(): {
  geminiDir: string;
  claudeDir: string;
  codexDir: string;
} {
  const home = os.homedir();
  const geminiDir = process.env.BURNRATE_GEMINI_DIR
    ? path.resolve(process.env.BURNRATE_GEMINI_DIR)
    : path.join(home, '.gemini');
  return {
    geminiDir,
    claudeDir: process.env.BURNRATE_CLAUDE_DIR
      ? path.resolve(process.env.BURNRATE_CLAUDE_DIR)
      : path.join(home, '.claude'),
    codexDir: process.env.BURNRATE_CODEX_DIR
      ? path.resolve(process.env.BURNRATE_CODEX_DIR)
      : process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(home, '.codex'),
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
    if (base === 'transcript_full.jsonl') {
      // Allow fallback to transcript_full.jsonl only if sibling transcript.jsonl is missing
      const siblingCompact = path.join(path.dirname(filePath), 'transcript.jsonl');
      if (fs.existsSync(siblingCompact)) return true;
    }
    if (normalized.includes('/.system_generated/logs/chunks/')) return true;
    if (normalized.includes('/tmp/')) return true;
  }

  if (source === 'claude') {
    if (base === 'history.jsonl' && !normalized.includes('/projects/')) return true;
  }

  if (source === 'codex') {
    if (!normalized.includes('/sessions/') && !normalized.includes('/archived_sessions/')) return true;
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

  const normalizedClaudePath = filePath.replace(/\\/g, '/');
  const claudeSubagentMatch = normalizedClaudePath.match(/\/projects\/[^/]+\/([^/]+)\/subagents\/([^/]+)\.jsonl$/i);
  const claudeSubagentParentId = claudeSubagentMatch ? claudeSubagentMatch[1] : null;
  const claudeSubagentId = claudeSubagentMatch ? claudeSubagentMatch[2] : null;
  let claudeSubagentName = claudeSubagentId || '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;

    let obj: Record<string, any>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (claudeSubagentId) {
      const candidateName =
        (typeof obj.agentName === 'string' && obj.agentName.trim()) ||
        (typeof obj.subagent_type === 'string' && obj.subagent_type.trim()) ||
        (typeof obj.agentType === 'string' && obj.agentType.trim()) ||
        '';
      if (candidateName) claudeSubagentName = candidateName;
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
      ...(!claudeSubagentId && obj.isSidechain === true
        ? { subagentId: 'btw:sidechain', subagentName: '/btw' }
        : {}),
    };

    const existing = turnMap.get(msgId);
    if (!existing || turn.totalTokens >= existing.totalTokens) {
      turnMap.set(msgId, turn);
    }
  }

  const turnHistory = Array.from(turnMap.values()).map((turn) =>
    claudeSubagentId
      ? {
          ...turn,
          subagentId: claudeSubagentId,
          subagentName: claudeSubagentName || 'subagent',
        }
      : turn
  );
  if (turnHistory.length === 0) return null;

  const resolvedSessionId = claudeSubagentParentId || sessionId;
  const resolvedWs = workspace || decodeClaudeProjectFolder(filePath);
  const sessionTitle =
    customTitle ||
    summaryTitle ||
    firstUserTitle ||
    (slugTitle ? formatSlugTitle(slugTitle) : '') ||
    fallbackSlashTitle ||
    (claudeSubagentId ? `Subagent: ${claudeSubagentName || claudeSubagentId}` : resolvedSessionId);

  return summarizeSession({
    sessionId: resolvedSessionId,
    sessionTitle,
    source: 'claude',
    workspace: toRelativeHomePath(resolvedWs),
    filePath: toRelativeHomePath(filePath),
    startedAt: startedAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
    turnHistory,
  });
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.input_text === 'string') return part.input_text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function loadCodexSessionTitles(codexDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  const indexPath = path.join(codexDir, 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return titles;
  try {
    if (fs.statSync(indexPath).size > 25 * 1024 * 1024) return titles;
    const lines = fs.readFileSync(indexPath, 'utf-8').split(/\r?\n/);
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const id = typeof obj.id === 'string' ? obj.id.trim() : '';
      const name = typeof obj.thread_name === 'string' ? cleanChatTitle(obj.thread_name) : '';
      if (id && name) {
        titles.set(id, name);
      }
    }
  } catch {
    // Ignore unreadable session_index.jsonl
  }
  return titles;
}

function isSyntheticCodexUserPrompt(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('# AGENTS.md') ||
    trimmed.startsWith('<environment_context') ||
    trimmed.startsWith('<permissions instructions') ||
    trimmed.startsWith('<INSTRUCTIONS>') ||
    trimmed.startsWith('<collaboration_mode') ||
    trimmed.startsWith('<turn_aborted>') ||
    trimmed.startsWith('Side conversation boundary.') ||
    trimmed.startsWith('Everything before this boundary is inherited history')
  ) {
    return true;
  }
  return false;
}

function cleanCodexUserTitle(raw: string): string {
  if (isSyntheticCodexUserPrompt(raw)) return '';
  const stripped = raw
    .trim()
    .replace(/^\/(?:btw|side)\s+/i, '')
    .trim();
  if (!stripped || /^\/(?:btw|side)$/i.test(stripped)) return '';
  return cleanChatTitle(stripped);
}

function parseCodexFile(
  filePath: string,
  stat: fs.Stats,
  pricing: PricingConfig,
  codexTitles?: Map<string, string>
): { session: SessionStats | null; relation: CodexThreadRelation | null } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { session: null, relation: null };
  }

  const lines = content.split(/\r?\n/);
  let sessionId = path.basename(filePath, '.jsonl');
  let workspace = 'Global / CLI';
  let currentModel = pricing.defaults?.codex || 'gpt-6.2-sol';
  let currentEffort = '';
  let firstUserTitle = '';
  let startedAt = '';
  let lastActiveAt = '';

  // Primary SessionMeta lineage fields (first session_meta in file is canonical; later ones may be copied from parent)
  let seenPrimarySessionMeta = false;
  let forkedFromId = '';
  let parentThreadId = '';
  let rootSessionId = '';
  let isSideChat = false;
  let agentName = '';

  const VALID_CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const normalizeCodexEffort = (val: unknown): string => {
    if (typeof val !== 'string') return '';
    const cleaned = val.trim().toLowerCase();
    return VALID_CODEX_EFFORTS.has(cleaned) ? cleaned : '';
  };

  const turnHistory: UsageTurn[] = [];
  let prevTotalTokensSig = '';
  let prevTotalInput = 0;
  let prevTotalCached = 0;
  let prevTotalOutput = 0;

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
      typeof obj.timestamp === 'string' && obj.timestamp
        ? obj.timestamp
        : new Date(stat.mtimeMs).toISOString();

    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastActiveAt || timestamp > lastActiveAt) lastActiveAt = timestamp;
    }

    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;

    if (obj.type === 'session_meta') {
      if (!seenPrimarySessionMeta) {
        seenPrimarySessionMeta = true;
        if (typeof payload.id === 'string' && payload.id.trim()) sessionId = payload.id.trim();
        if (typeof payload.cwd === 'string' && payload.cwd.trim()) workspace = payload.cwd.trim();
        if (typeof payload.forked_from_id === 'string' && payload.forked_from_id.trim()) {
          forkedFromId = payload.forked_from_id.trim();
        }
        if (typeof payload.session_id === 'string' && payload.session_id.trim()) {
          rootSessionId = payload.session_id.trim();
        }
        if (payload.attached_thread === true) {
          isSideChat = true;
        }
        const subSpawn =
          payload.source?.subagent?.thread_spawn ||
          payload.source?.SubAgent?.ThreadSpawn ||
          payload.source?.subagent ||
          null;
        const rawParent =
          (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id.trim()) ||
          (typeof subSpawn?.parent_thread_id === 'string' && subSpawn.parent_thread_id.trim()) ||
          '';
        if (rawParent) parentThreadId = rawParent;
        const rawAgent =
          (typeof payload.agent_nickname === 'string' && payload.agent_nickname.trim()) ||
          (typeof payload.agent_role === 'string' && payload.agent_role.trim()) ||
          (typeof subSpawn?.agent_nickname === 'string' && subSpawn.agent_nickname.trim()) ||
          (typeof subSpawn?.agent_role === 'string' && subSpawn.agent_role.trim()) ||
          '';
        if (rawAgent) agentName = rawAgent;
      } else if (workspace === 'Global / CLI' && typeof payload.cwd === 'string' && payload.cwd.trim()) {
        workspace = payload.cwd.trim();
      }
      const metaModel =
        (typeof payload.model === 'string' && payload.model.trim()) ||
        (typeof payload.model_slug === 'string' && payload.model_slug.trim()) ||
        '';
      if (metaModel) currentModel = metaModel;
      const metaEffort = normalizeCodexEffort(payload.effort ?? payload.reasoning_effort);
      if (metaEffort) currentEffort = metaEffort;
      continue;
    }

    if (obj.type === 'turn_context') {
      const ctxModel =
        (typeof payload.model === 'string' && payload.model.trim()) ||
        (typeof payload.model_slug === 'string' && payload.model_slug.trim()) ||
        (typeof payload.collaboration_mode?.settings?.model === 'string' &&
          payload.collaboration_mode.settings.model.trim()) ||
        '';
      if (ctxModel) currentModel = ctxModel;
      const rawEffort =
        payload.effort ??
        payload.reasoning_effort ??
        payload.collaboration_mode?.settings?.reasoning_effort;
      if (typeof rawEffort === 'string') {
        currentEffort = normalizeCodexEffort(rawEffort);
      }
      if (typeof payload.cwd === 'string' && payload.cwd.trim() && workspace === 'Global / CLI') {
        workspace = payload.cwd.trim();
      }
      continue;
    }

    if (obj.type === 'response_item' && payload.role === 'developer') {
      const devText = extractCodexMessageText(payload.content);
      if (devText.includes('You are in a side conversation, not the main thread.')) {
        isSideChat = true;
      }
      continue;
    }

    if (
      obj.type === 'response_item' &&
      (payload.role === 'user' || payload.type === 'message') &&
      payload.role === 'user'
    ) {
      const rawUserText = extractCodexMessageText(payload.content).trim();
      if (
        rawUserText.startsWith('Side conversation boundary.') ||
        rawUserText.startsWith('Everything before this boundary is inherited history')
      ) {
        // Everything before the side conversation boundary is inherited parent history — reset so we never double-count parent turns or leak parent titles
        isSideChat = true;
        firstUserTitle = '';
        turnHistory.length = 0;
        startedAt = '';
        continue;
      }
      if (!firstUserTitle) {
        const candidate = cleanCodexUserTitle(rawUserText);
        if (candidate) firstUserTitle = candidate;
      }
      continue;
    }

    if (obj.type === 'event_msg' && payload.type === 'user_message' && !firstUserTitle) {
      const candidate = cleanCodexUserTitle(String(payload.message || payload.text || ''));
      if (candidate) firstUserTitle = candidate;
      continue;
    }

    if (obj.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info;
      if (!info || typeof info !== 'object') continue;

      const totalUsage = info.total_token_usage;
      const lastUsage = info.last_token_usage;

      if (totalUsage && typeof totalUsage === 'object') {
        const sig = `${totalUsage.input_tokens ?? 0}:${totalUsage.cached_input_tokens ?? 0}:${totalUsage.output_tokens ?? 0}:${totalUsage.total_tokens ?? 0}`;
        if (sig === prevTotalTokensSig) continue;
        prevTotalTokensSig = sig;
      }

      let rawInput = 0;
      let cachedInput = 0;
      let outputTokens = 0;

      if (lastUsage && typeof lastUsage === 'object') {
        rawInput = Math.max(0, Number(lastUsage.input_tokens ?? 0));
        cachedInput = Math.max(0, Number(lastUsage.cached_input_tokens ?? lastUsage.cache_read_input_tokens ?? 0));
        outputTokens = Math.max(0, Number(lastUsage.output_tokens ?? 0));
        if (totalUsage && typeof totalUsage === 'object') {
          prevTotalInput = Math.max(prevTotalInput, Number(totalUsage.input_tokens ?? 0));
          prevTotalCached = Math.max(prevTotalCached, Number(totalUsage.cached_input_tokens ?? 0));
          prevTotalOutput = Math.max(prevTotalOutput, Number(totalUsage.output_tokens ?? 0));
        }
      } else if (totalUsage && typeof totalUsage === 'object') {
        const curIn = Math.max(0, Number(totalUsage.input_tokens ?? 0));
        const curCached = Math.max(0, Number(totalUsage.cached_input_tokens ?? totalUsage.cache_read_input_tokens ?? 0));
        const curOut = Math.max(0, Number(totalUsage.output_tokens ?? 0));
        rawInput = Math.max(0, curIn - prevTotalInput);
        cachedInput = Math.max(0, curCached - prevTotalCached);
        outputTokens = Math.max(0, curOut - prevTotalOutput);
        prevTotalInput = curIn;
        prevTotalCached = curCached;
        prevTotalOutput = curOut;
      } else {
        continue;
      }

      const nonCachedInput = rawInput >= cachedInput ? rawInput - cachedInput : rawInput;
      const totalTokens = nonCachedInput + cachedInput + outputTokens;
      if (totalTokens <= 0) continue;

      const baseTurnModel =
        (typeof info.model === 'string' && info.model.trim()) ||
        (typeof payload.model === 'string' && payload.model.trim()) ||
        currentModel;
      const turnEffort = normalizeCodexEffort(info.effort ?? info.reasoning_effort) || currentEffort;
      const turnModel =
        turnEffort && !/(?:[-_\s]+|\()(?:max|xhigh|high|medium|low|minimal)\)?$/i.test(baseTurnModel)
          ? `${baseTurnModel}-${turnEffort}`
          : baseTurnModel;

      const costCalc = calculateTurnCost(
        {
          rawModel: turnModel,
          source: 'codex',
          timestamp,
          inputTokens: nonCachedInput,
          outputTokens,
          cacheReadTokens: cachedInput,
          cacheWriteTokens: 0,
        },
        pricing
      );

      turnHistory.push({
        timestamp,
        model: turnModel,
        normalizedModel: costCalc.normalizedModel,
        modelLabel: costCalc.modelLabel,
        inputTokens: nonCachedInput,
        outputTokens,
        cacheReadTokens: cachedInput,
        cacheWriteTokens: 0,
        totalTokens,
        costUSD: costCalc.costUSD,
        cacheSavingsUSD: costCalc.cacheSavingsUSD,
        estimated: false,
      });
    }
  }

  const resolvedSideParent =
    forkedFromId ||
    parentThreadId ||
    (rootSessionId && rootSessionId !== sessionId ? rootSessionId : '');
  const relation: CodexThreadRelation | null = isSideChat
    ? {
        sessionId,
        parentSessionId: resolvedSideParent && resolvedSideParent !== sessionId ? resolvedSideParent : undefined,
        isSideChat: true,
        workspace: workspace !== 'Global / CLI' ? workspace : undefined,
      }
    : parentThreadId && parentThreadId !== sessionId
      ? {
          sessionId,
          parentSessionId: parentThreadId,
          isSideChat: false,
          subagentName: agentName || 'subagent',
          workspace: workspace !== 'Global / CLI' ? workspace : undefined,
        }
      : null;

  if (turnHistory.length === 0) return { session: null, relation };

  const indexedTitle = codexTitles?.get(sessionId);
  const resolvedTitle = indexedTitle || firstUserTitle || sessionId;

  const session = summarizeSession({
    sessionId,
    sessionTitle: resolvedTitle,
    source: 'codex',
    workspace: toRelativeHomePath(workspace),
    filePath: toRelativeHomePath(filePath),
    startedAt: startedAt || turnHistory[0]?.timestamp || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    lastActiveAt: lastActiveAt || new Date(stat.mtimeMs).toISOString(),
    turnHistory,
  });

  return { session, relation };
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
  antigravityWorkspaces?: Map<string, string>,
  codexTitles?: Map<string, string>
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
    if (cached.session && source === 'antigravity' && resolvedTitles) {
      const dbTitle = resolvedTitles.get(cached.session.sessionId);
      if (dbTitle) cached.session.sessionTitle = dbTitle;
    }
    if (cached.session && source === 'antigravity' && resolvedWorkspaces && cached.session.workspace === 'Global / CLI') {
      const dbWs = resolvedWorkspaces.get(cached.session.sessionId);
      if (dbWs) {
        const rel = toRelativeHomePath(dbWs);
        cached.session.workspace = rel;
        cached.session.workspaceName = formatWorkspaceName(rel);
      }
    }
    if (cached.session && source === 'codex' && codexTitles) {
      const idxTitle = codexTitles.get(cached.session.sessionId);
      if (idxTitle) cached.session.sessionTitle = idxTitle;
    }
    return cached.session;
  }

  let session: SessionStats | null = null;
  let codexRelation: CodexThreadRelation | null = null;
  if (source === 'antigravity') {
    session = parseAntigravityFile(filePath, stat, pricing, resolvedTitles, resolvedWorkspaces);
  } else if (source === 'claude') {
    session = parseClaudeFile(filePath, stat, pricing);
  } else {
    const parsedCodex = parseCodexFile(filePath, stat, pricing, codexTitles);
    session = parsedCodex.session;
    codexRelation = parsedCodex.relation;
  }

  fileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    session,
    ...(codexRelation ? { codexRelation } : {}),
  });

  return session;
}

export function syncSingleTranscriptToLedger(hookPayload?: Record<string, any> | null): boolean {
  const { geminiDir, claudeDir, codexDir } = getWatchRoots();
  const pricing = loadPricing(false);

  const rawTranscriptPath =
    (typeof hookPayload?.agent_transcript_path === 'string' && hookPayload.agent_transcript_path.trim()) ||
    (typeof hookPayload?.transcriptPath === 'string' && hookPayload.transcriptPath.trim()) ||
    (typeof hookPayload?.transcript_path === 'string' && hookPayload.transcript_path.trim()) ||
    '';

  const conversationId =
    (typeof hookPayload?.conversationId === 'string' && hookPayload.conversationId.trim()) ||
    (typeof hookPayload?.session_id === 'string' && hookPayload.session_id.trim()) ||
    '';

  const candidates: Array<{ filePath: string; source: ToolSource }> = [];

  if (rawTranscriptPath) {
    let resolvedTranscriptPath = rawTranscriptPath;
    if (path.basename(resolvedTranscriptPath).toLowerCase() === 'transcript_full.jsonl') {
      const siblingCompact = path.join(path.dirname(resolvedTranscriptPath), 'transcript.jsonl');
      if (fs.existsSync(siblingCompact)) {
        resolvedTranscriptPath = siblingCompact;
      }
    }
    const norm = path.resolve(resolvedTranscriptPath).replace(/\\/g, '/').toLowerCase();
    const normClaude = normalizePathKey(claudeDir);
    const normCodex = normalizePathKey(codexDir);
    const normGemini = normalizePathKey(geminiDir);
    const isSnakeCaseClaudeHook =
      (typeof hookPayload?.transcript_path === 'string' || typeof hookPayload?.agent_transcript_path === 'string') &&
      typeof hookPayload?.transcriptPath !== 'string';

    const detectedSource: ToolSource =
      norm.startsWith(`${normClaude}/`) || norm.includes('/.claude/')
        ? 'claude'
        : norm.startsWith(`${normCodex}/`) || norm.includes('/.codex/')
          ? 'codex'
          : norm.startsWith(`${normGemini}/`) || norm.includes('/.gemini/')
            ? 'antigravity'
            : isSnakeCaseClaudeHook
              ? 'claude'
              : 'antigravity';
    if (fs.existsSync(resolvedTranscriptPath)) {
      candidates.push({ filePath: resolvedTranscriptPath, source: detectedSource });
    }
  }

  if (candidates.length === 0 && conversationId) {
    for (const sub of ['antigravity-cli', 'antigravity', 'antigravity-ide']) {
      for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) {
        const p = path.join(geminiDir, sub, 'brain', conversationId, '.system_generated', 'logs', name);
        if (fs.existsSync(p)) {
          candidates.push({ filePath: p, source: 'antigravity' });
          break;
        }
      }
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length > 0) {
    const { filePath, source } = candidates[0];
    const antigravityMeta = source === 'antigravity' ? loadAntigravityMetadata(geminiDir) : null;
    const codexTitles = source === 'codex' ? loadCodexSessionTitles(codexDir) : undefined;
    const session = parseSingleFile(
      filePath,
      source,
      pricing,
      antigravityMeta?.titles,
      antigravityMeta?.workspaces,
      codexTitles
    );
    if (session) {
      let requiresParentSubagentMerge = false;
      const btwEntries = loadBtwHistoryEntries(geminiDir, claudeDir, codexDir);
      const codexRel = source === 'codex' ? fileCache.get(filePath)?.codexRelation : null;
      if (codexRel?.isSideChat || codexRel?.parentSessionId) {
        requiresParentSubagentMerge = true;
      } else if (matchBtwParent(session, btwEntries, antigravityMeta)) {
        requiresParentSubagentMerge = true;
      } else if (
        btwEntries.some(
          (entry) => entry.source === session.source && entry.parentSessionId === session.sessionId
        )
      ) {
        requiresParentSubagentMerge = true;
      } else if (source === 'antigravity' && antigravityMeta) {
        if (antigravityMeta.parentIds.has(session.sessionId)) {
          requiresParentSubagentMerge = true;
        } else {
          for (const parentId of antigravityMeta.parentIds.values()) {
            if (parentId === session.sessionId) {
              requiresParentSubagentMerge = true;
              break;
            }
          }
        }
      } else if (source === 'claude') {
        const normPath = filePath.replace(/\\/g, '/');
        if (
          normPath.includes('/subagents/') ||
          session.turnHistory.some((t) => Boolean(t.subagentId)) ||
          fs.existsSync(path.join(path.dirname(filePath), session.sessionId, 'subagents'))
        ) {
          requiresParentSubagentMerge = true;
        }
      }

      if (!requiresParentSubagentMerge) {
        const hintWorkspace =
          (Array.isArray(hookPayload?.workspacePaths) && typeof hookPayload.workspacePaths[0] === 'string'
            ? hookPayload.workspacePaths[0]
            : undefined) ||
          (typeof hookPayload?.cwd === 'string' ? hookPayload.cwd : undefined);

        if (hintWorkspace && session.workspace === 'Global / CLI') {
          const rel = toRelativeHomePath(hintWorkspace);
          session.workspace = rel;
          session.workspaceName = formatWorkspaceName(rel);
        }
        return upsertSingleSessionToLedger(session);
      }
    }
  }

  // Fallback: full lightweight reconciliation updates all current sessions in ledger
  scanAllLogs(false);
  return true;
}

interface BtwHistoryEntry {
  source: ToolSource;
  parentSessionId: string;
  promptTitle: string;
  promptTitleNorm: string;
  timestampMs: number;
  workspaceNorm: string;
  rawWorkspace: string;
}

function normalizeComparableTitle(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[…]+$/g, '')
    .replace(/\.{3,}$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWorkspaceForMatch(ws: string | undefined): string {
  if (!ws || ws === 'Global / CLI') return '';
  const rel = toRelativeHomePath(ws);
  return rel.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function loadBtwHistoryEntries(
  geminiDir: string,
  claudeDir: string,
  codexDir?: string
): BtwHistoryEntry[] {
  const entries: BtwHistoryEntry[] = [];
  const MAX_BYTES = 25 * 1024 * 1024;

  const sources: Array<{ source: ToolSource; filePath: string }> = [
    { source: 'antigravity', filePath: path.join(geminiDir, 'antigravity-cli', 'history.jsonl') },
    { source: 'antigravity', filePath: path.join(geminiDir, 'antigravity', 'history.jsonl') },
    { source: 'claude', filePath: path.join(claudeDir, 'history.jsonl') },
  ];
  if (codexDir) {
    sources.push(
      { source: 'codex', filePath: path.join(codexDir, 'history.jsonl') },
      { source: 'codex', filePath: path.join(codexDir, 'history', 'history.jsonl') }
    );
  }

  for (const { source, filePath } of sources) {
    if (!fs.existsSync(filePath)) continue;
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
      for (const raw of lines) {
        if (!raw.trim()) continue;
        if (!raw.includes('/btw') && !(source === 'codex' && raw.includes('/side'))) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        const display =
          (typeof obj.display === 'string' && obj.display.trim()) ||
          (typeof obj.text === 'string' && obj.text.trim()) ||
          '';
        const btwMatch =
          source === 'codex'
            ? display.match(/^\/(?:btw|side)(?:\s+([\s\S]+))?$/i)
            : display.match(/^\/btw(?:\s+([\s\S]+))?$/i);
        if (!btwMatch) continue;
        const parentSessionId =
          (typeof obj.conversationId === 'string' && obj.conversationId.trim()) ||
          (typeof obj.sessionId === 'string' && obj.sessionId.trim()) ||
          (typeof obj.session_id === 'string' && obj.session_id.trim()) ||
          '';
        const rawTs =
          typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)
            ? obj.timestamp
            : typeof obj.ts === 'number' && Number.isFinite(obj.ts)
              ? obj.ts
              : 0;
        const timestampMs = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
        if (!parentSessionId || !timestampMs) continue;

        const promptBody = (btwMatch[1] || '').trim();
        const promptTitle = promptBody ? cleanChatTitle(promptBody) : '';
        const rawWs =
          (typeof obj.workspace === 'string' && obj.workspace.trim()) ||
          (typeof obj.project === 'string' && obj.project.trim()) ||
          (typeof obj.cwd === 'string' && obj.cwd.trim()) ||
          '';

        entries.push({
          source,
          parentSessionId,
          promptTitle,
          promptTitleNorm: normalizeComparableTitle(promptTitle),
          timestampMs,
          workspaceNorm: normalizeWorkspaceForMatch(rawWs),
          rawWorkspace: rawWs,
        });
      }
    } catch {
      // Ignore unreadable history.jsonl
    }
  }

  return entries;
}

function matchBtwParent(
  session: SessionStats,
  btwEntries: BtwHistoryEntry[],
  antigravityMeta?: AntigravityMetadata | null,
  codexMeta?: CodexMetadata | null
): {
  parentKey: string;
  subagentId: string;
  subagentName: string;
  subagentTitle?: string;
  workspace?: string;
} | null {
  if (session.untrackedHistory || btwEntries.length === 0) return null;

  const startStr = session.startedAt || session.turnHistory[0]?.timestamp || '';
  const startedMs = startStr ? new Date(startStr).getTime() : NaN;
  if (Number.isNaN(startedMs)) return null;

  const sessTitleNorm = normalizeComparableTitle(session.sessionTitle);
  const hasUuidTitle =
    !sessTitleNorm || sessTitleNorm === session.sessionId.toLowerCase();
  const sessWsNorm = normalizeWorkspaceForMatch(session.workspace);
  const isKnownCodexSide = Boolean(
    session.source === 'codex' && codexMeta?.sideChatIds.has(session.sessionId)
  );

  let bestEntry: BtwHistoryEntry | null = null;
  let bestScore = Infinity; // Lower is better; title matches get priority over timestamp-only fallback

  for (const entry of btwEntries) {
    if (entry.source !== session.source) continue;
    if (entry.parentSessionId === session.sessionId) continue;

    const deltaMs = startedMs - entry.timestampMs;
    const diffMs = Math.abs(deltaMs);
    if (diffMs > 180_000) continue;

    let matchTier = 0; // 1 = title match, 2 = tight timestamp+workspace fallback
    if (!hasUuidTitle && entry.promptTitleNorm.length >= 4 && sessTitleNorm.length >= 4) {
      if (
        sessTitleNorm === entry.promptTitleNorm ||
        sessTitleNorm.startsWith(entry.promptTitleNorm) ||
        entry.promptTitleNorm.startsWith(sessTitleNorm)
      ) {
        matchTier = 1;
      }
    }

    const entryWsNorm =
      entry.workspaceNorm ||
      (entry.source === 'codex' ? normalizeWorkspaceForMatch(codexMeta?.workspaces.get(entry.parentSessionId)) : '');

    if (matchTier === 0 && deltaMs >= -5_000 && deltaMs <= (isKnownCodexSide ? 180_000 : 15_000)) {
      const wsMatches =
        Boolean(entryWsNorm && sessWsNorm) &&
        (sessWsNorm === entryWsNorm ||
          sessWsNorm.startsWith(`${entryWsNorm}/`) ||
          entryWsNorm.startsWith(`${sessWsNorm}/`));
      if (wsMatches || ((!entryWsNorm || !sessWsNorm) && (isKnownCodexSide || diffMs <= 5_000))) {
        matchTier = 2;
      }
    }

    if (matchTier > 0) {
      const score = matchTier * 1_000_000 + diffMs;
      if (score < bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
  }

  if (!bestEntry) return null;

  const rootParentId =
    session.source === 'antigravity' && antigravityMeta
      ? resolveRootParentId(bestEntry.parentSessionId, antigravityMeta.parentIds) ||
        bestEntry.parentSessionId
      : session.source === 'codex' && codexMeta
        ? resolveRootParentId(bestEntry.parentSessionId, codexMeta.parentIds) ||
          bestEntry.parentSessionId
        : bestEntry.parentSessionId;

  const resolvedBtwTitle =
    (!hasUuidTitle && session.sessionTitle ? session.sessionTitle.trim() : '') ||
    bestEntry.promptTitle ||
    undefined;

  const resolvedWs =
    bestEntry.rawWorkspace ||
    (session.source === 'codex' ? codexMeta?.workspaces.get(rootParentId) : undefined) ||
    undefined;

  return {
    parentKey: getSessionKey(session.source, rootParentId),
    subagentId: `btw:${session.sessionId}`,
    subagentName: '/btw',
    subagentTitle: resolvedBtwTitle,
    workspace: resolvedWs,
  };
}

function resolveRootParentId(sessionId: string, parentIds: Map<string, string>): string | null {
  let cur = parentIds.get(sessionId);
  if (!cur) return null;
  const visited = new Set<string>([sessionId]);
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const next = parentIds.get(cur);
    if (!next) return cur;
    cur = next;
  }
  return null;
}

function mergeSessionsAndSubagents(
  rawSessions: SessionStats[],
  antigravityMeta: AntigravityMetadata,
  btwEntries: BtwHistoryEntry[],
  codexMeta?: CodexMetadata
): {
  merged: SessionStats[];
  mergedSubagentKeys: Set<string>;
} {
  const byKey = new Map<string, SessionStats>();
  const subagentBuckets = new Map<string, UsageTurn[]>();
  const mergedSubagentKeys = new Set<string>();

  // Separate root sessions from child/subagent & /btw sessions
  const pendingChildren: Array<{
    parentKey: string;
    session: SessionStats;
    subagentId: string;
    subagentName: string;
    subagentTitle?: string;
    workspace?: string;
  }> = [];

  for (const s of rawSessions) {
    const key = getSessionKey(s.source, s.sessionId);

    // 1. Antigravity subagent detected via conversation_summaries.parent_conversation_id / conversation_parents
    if (s.source === 'antigravity') {
      const rootParentId = resolveRootParentId(s.sessionId, antigravityMeta.parentIds);
      if (rootParentId) {
        const subName = antigravityMeta.agentNames.get(s.sessionId) || 'subagent';
        const subTitle =
          antigravityMeta.titles.get(s.sessionId) ||
          (s.sessionTitle && s.sessionTitle !== s.sessionId ? s.sessionTitle : undefined);
        pendingChildren.push({
          parentKey: getSessionKey('antigravity', rootParentId),
          session: s,
          subagentId: s.sessionId,
          subagentName: subName,
          subagentTitle: subTitle,
        });
        continue;
      }
    }

    // 1b. Codex /btw (/side) forked side-chats & multi-agent subagents detected via SessionMeta lineage
    if (s.source === 'codex' && codexMeta) {
      const rootParentId = resolveRootParentId(s.sessionId, codexMeta.parentIds);
      if (rootParentId) {
        const isSide = codexMeta.sideChatIds.has(s.sessionId);
        const subTitle =
          codexMeta.titles.get(s.sessionId) ||
          (s.sessionTitle && s.sessionTitle !== s.sessionId ? s.sessionTitle : undefined);
        pendingChildren.push({
          parentKey: getSessionKey('codex', rootParentId),
          session: s,
          subagentId: isSide ? `btw:${s.sessionId}` : s.sessionId,
          subagentName: isSide ? '/btw' : codexMeta.agentNames.get(s.sessionId) || 'subagent',
          subagentTitle: subTitle,
          workspace: codexMeta.workspaces.get(rootParentId) || codexMeta.workspaces.get(s.sessionId),
        });
        continue;
      }
    }

    // 2. Ephemeral /btw side-chat detected via history.jsonl (`/btw <prompt>` or Codex `/side`)
    const btwParent = matchBtwParent(s, btwEntries, antigravityMeta, codexMeta);
    if (btwParent) {
      pendingChildren.push({
        parentKey: btwParent.parentKey,
        session: s,
        subagentId: btwParent.subagentId,
        subagentName: btwParent.subagentName,
        subagentTitle: btwParent.subagentTitle,
        workspace: btwParent.workspace,
      });
      continue;
    }

    // 3. Claude subagent file (already carries parent sessionId and turns tagged with subagentId)
    const isClaudeSubagentFile =
      s.source === 'claude' &&
      s.turnHistory.length > 0 &&
      s.turnHistory.every((t) => Boolean(t.subagentId));

    if (isClaudeSubagentFile) {
      const existing = subagentBuckets.get(key) || [];
      existing.push(...s.turnHistory);
      subagentBuckets.set(key, existing);
      continue;
    }

    const existing = byKey.get(key);
    if (!existing || s.turns >= existing.turns) {
      byKey.set(key, { ...s, turnHistory: [...s.turnHistory] });
    }
  }

  // Attach subagents & /btw side-chats to their parent session when parent exists; otherwise give clean readable title
  for (const child of pendingChildren) {
    const parent = byKey.get(child.parentKey);
    if (parent) {
      const taggedTurns = child.session.turnHistory.map((t) => {
        const resolvedTitle = t.subagentTitle || child.subagentTitle;
        return {
          ...t,
          subagentId: t.subagentId || child.subagentId,
          subagentName: t.subagentName || child.subagentName,
          ...(resolvedTitle ? { subagentTitle: resolvedTitle } : {}),
        };
      });
      const bucket = subagentBuckets.get(child.parentKey) || [];
      bucket.push(...taggedTurns);
      subagentBuckets.set(child.parentKey, bucket);
      mergedSubagentKeys.add(getSessionKey(child.session.source, child.session.sessionId));
    } else {
      // Standalone subagent or /btw whose parent has no turns yet: preserve project workspace & readable title
      const childKey = getSessionKey(child.session.source, child.session.sessionId);
      const hasUuidTitle =
        !child.session.sessionTitle || child.session.sessionTitle === child.session.sessionId;
      const resolvedWs =
        child.session.workspace === 'Global / CLI' && child.workspace
          ? toRelativeHomePath(child.workspace)
          : child.session.workspace;
      byKey.set(childKey, {
        ...child.session,
        workspace: resolvedWs,
        workspaceName: formatWorkspaceName(resolvedWs),
        sessionTitle: hasUuidTitle ? `Subagent: ${child.subagentName}` : child.session.sessionTitle,
      });
    }
  }

  // Re-summarize any parent sessions that absorbed subagent turns
  const merged: SessionStats[] = [];
  for (const [key, base] of byKey.entries()) {
    const extraTurns = subagentBuckets.get(key);
    if (!extraTurns || extraTurns.length === 0) {
      merged.push(base);
      continue;
    }
    const combinedTurns = [...base.turnHistory, ...extraTurns].sort((a, b) =>
      a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0
    );
    let startedAt = base.startedAt;
    let lastActiveAt = base.lastActiveAt;
    for (const t of extraTurns) {
      if (t.timestamp) {
        if (!startedAt || t.timestamp < startedAt) startedAt = t.timestamp;
        if (!lastActiveAt || t.timestamp > lastActiveAt) lastActiveAt = t.timestamp;
      }
    }
    merged.push(
      summarizeSession({
        sessionId: base.sessionId,
        sessionTitle: base.sessionTitle,
        source: base.source,
        workspace: base.workspace,
        filePath: base.filePath,
        startedAt,
        lastActiveAt,
        turnHistory: combinedTurns,
      })
    );
  }

  return { merged, mergedSubagentKeys };
}

export function scanAllLogs(forceClearCache = false): BurnrateSnapshot {
  if (forceClearCache) {
    fileCache.clear();
  }

  const pricing = loadPricing(forceClearCache);
  const { geminiDir, claudeDir, codexDir } = getWatchRoots();
  const antigravityMeta = loadAntigravityMetadata(geminiDir);

  const geminiFiles = collectJsonlFiles(geminiDir, 'antigravity');
  const claudeFiles = collectJsonlFiles(claudeDir, 'claude');
  const codexLiveDir = path.join(codexDir, 'sessions');
  const codexArchivedDir = path.join(codexDir, 'archived_sessions');
  const codexLiveFiles = collectJsonlFiles(codexLiveDir, 'codex');
  const codexArchivedFiles = collectJsonlFiles(codexArchivedDir, 'codex');

  // Purge stale entries from fileCache for files deleted from disk
  const seenFiles = new Set<string>([
    ...geminiFiles,
    ...claudeFiles,
    ...codexLiveFiles,
    ...codexArchivedFiles,
  ]);
  for (const cachedPath of fileCache.keys()) {
    if (!seenFiles.has(cachedPath)) {
      fileCache.delete(cachedPath);
    }
  }

  const rawLiveSessions: SessionStats[] = [];
  const rawOrphanedDeletedSessions: SessionStats[] = [];

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
      rawOrphanedDeletedSessions.push(session);
    } else {
      rawLiveSessions.push(session);
    }
  }

  for (const file of claudeFiles) {
    const session = parseSingleFile(file, 'claude', pricing);
    if (session) rawLiveSessions.push(session);
  }

  const codexMeta: CodexMetadata = {
    titles: loadCodexSessionTitles(codexDir),
    parentIds: new Map<string, string>(),
    sideChatIds: new Set<string>(),
    agentNames: new Map<string, string>(),
    workspaces: new Map<string, string>(),
  };

  const recordCodexSessionMeta = (file: string, session: SessionStats | null) => {
    const rel = fileCache.get(file)?.codexRelation;
    if (rel) {
      if (rel.isSideChat) codexMeta.sideChatIds.add(rel.sessionId);
      if (rel.parentSessionId && rel.parentSessionId !== rel.sessionId) {
        codexMeta.parentIds.set(rel.sessionId, rel.parentSessionId);
      }
      if (rel.subagentName) codexMeta.agentNames.set(rel.sessionId, rel.subagentName);
      if (rel.workspace) codexMeta.workspaces.set(rel.sessionId, rel.workspace);
    }
    if (session && session.workspace && session.workspace !== 'Global / CLI') {
      codexMeta.workspaces.set(session.sessionId, session.workspace);
    }
  };

  for (const file of codexLiveFiles) {
    const session = parseSingleFile(file, 'codex', pricing, undefined, undefined, codexMeta.titles);
    recordCodexSessionMeta(file, session);
    if (session) rawLiveSessions.push(session);
  }

  for (const file of codexArchivedFiles) {
    const session = parseSingleFile(file, 'codex', pricing, undefined, undefined, codexMeta.titles);
    recordCodexSessionMeta(file, session);
    if (session) rawOrphanedDeletedSessions.push(session);
  }

  const btwEntries = loadBtwHistoryEntries(geminiDir, claudeDir, codexDir);

  const { merged: liveSessions, mergedSubagentKeys: liveMergedSubKeys } = mergeSessionsAndSubagents(
    rawLiveSessions,
    antigravityMeta,
    btwEntries,
    codexMeta
  );
  const { merged: orphanedDeletedSessions, mergedSubagentKeys: orphanMergedSubKeys } =
    mergeSessionsAndSubagents(rawOrphanedDeletedSessions, antigravityMeta, btwEntries, codexMeta);

  const mergedSubagentKeys = new Set<string>([...liveMergedSubKeys, ...orphanMergedSubKeys]);
  const codexDirExists = fs.existsSync(codexDir);

  const resolveRolledUpParent = (candidate: SessionStats) => {
    if (candidate.source === 'antigravity') {
      const rootParentId = resolveRootParentId(candidate.sessionId, antigravityMeta.parentIds);
      if (rootParentId) {
        const subTitle =
          antigravityMeta.titles.get(candidate.sessionId) ||
          (candidate.sessionTitle && candidate.sessionTitle !== candidate.sessionId
            ? candidate.sessionTitle
            : undefined);
        return {
          parentKey: getSessionKey('antigravity', rootParentId),
          subagentId: candidate.sessionId,
          subagentName: antigravityMeta.agentNames.get(candidate.sessionId) || 'subagent',
          subagentTitle: subTitle,
        };
      }
    }
    if (candidate.source === 'codex') {
      const rootParentId = resolveRootParentId(candidate.sessionId, codexMeta.parentIds);
      if (rootParentId) {
        const isSide = codexMeta.sideChatIds.has(candidate.sessionId);
        const subTitle =
          codexMeta.titles.get(candidate.sessionId) ||
          (candidate.sessionTitle && candidate.sessionTitle !== candidate.sessionId
            ? candidate.sessionTitle
            : undefined);
        return {
          parentKey: getSessionKey('codex', rootParentId),
          subagentId: isSide ? `btw:${candidate.sessionId}` : candidate.sessionId,
          subagentName: isSide ? '/btw' : codexMeta.agentNames.get(candidate.sessionId) || 'subagent',
          subagentTitle: subTitle,
        };
      }
    }
    return matchBtwParent(candidate, btwEntries, antigravityMeta, codexMeta);
  };

  const resolveBtwTurnTitle = (
    parent: SessionStats,
    subagentId: string,
    earliestTimestamp: string
  ): string | undefined => {
    if (parent.source === 'codex' && subagentId.startsWith('btw:')) {
      const rawId = subagentId.slice(4);
      const indexed = codexMeta.titles.get(rawId);
      if (indexed) return indexed;
    }
    const targetMs = earliestTimestamp ? new Date(earliestTimestamp).getTime() : NaN;
    if (Number.isNaN(targetMs) || btwEntries.length === 0) return undefined;
    let bestTitle: string | undefined;
    let bestDiff = Infinity;
    for (const entry of btwEntries) {
      if (entry.source !== parent.source || !entry.promptTitle) continue;
      const rootId =
        parent.source === 'antigravity'
          ? resolveRootParentId(entry.parentSessionId, antigravityMeta.parentIds) || entry.parentSessionId
          : parent.source === 'codex'
            ? resolveRootParentId(entry.parentSessionId, codexMeta.parentIds) || entry.parentSessionId
            : entry.parentSessionId;
      if (rootId !== parent.sessionId) continue;
      const diffMs = Math.abs(targetMs - entry.timestampMs);
      if (diffMs <= 180_000 && diffMs < bestDiff) {
        bestDiff = diffMs;
        bestTitle = entry.promptTitle;
      }
    }
    return bestTitle;
  };

  const {
    activeSessions,
    deletedSessions: ledgerDeleted,
    absorbedKeys,
  } = reconcileSessionLedger({
    liveSessions,
    orphanedDeletedSessions,
    mergedSubagentKeys,
    resolveRolledUpParent,
    resolveBtwTurnTitle,
    geminiDirExists: fs.existsSync(geminiDir),
    claudeDirExists: fs.existsSync(claudeDir),
    codexDirExists,
  });

  const knownKeys = new Set<string>();
  for (const s of activeSessions) knownKeys.add(getSessionKey(s.source, s.sessionId));
  for (const s of ledgerDeleted) knownKeys.add(getSessionKey(s.source, s.sessionId));
  for (const key of mergedSubagentKeys) knownKeys.add(key);
  for (const key of absorbedKeys) knownKeys.add(key);
  for (const key of getDismissedLegacyKeys()) knownKeys.add(key);

  const legacyDeleted = collectLegacyDeletedSessions(geminiDir, claudeDir, antigravityMeta, knownKeys);
  const deletedSessions = [...ledgerDeleted, ...legacyDeleted].sort((a, b) => {
    const aKey = a.deletedAt || a.lastActiveAt || '';
    const bKey = b.deletedAt || b.lastActiveAt || '';
    return bKey > aKey ? 1 : -1;
  });

  const watchedPaths = [toRelativeHomePath(geminiDir), toRelativeHomePath(claudeDir)];
  if (codexDirExists) watchedPaths.push(toRelativeHomePath(codexDir));

  return {
    generatedAt: new Date().toISOString(),
    watchedPaths,
    pricing,
    sessions: activeSessions,
    deletedSessions,
    dismissedLegacyCount: getDismissedLegacyCount(),
    settings: loadUserSettings(),
    hooksStatus: getHooksStatus(),
  };
}
