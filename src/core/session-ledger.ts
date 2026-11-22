import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionStats } from './types.js';

export interface SessionLedgerFile {
  version: 1;
  updatedAt: string;
  sessions: Record<string, SessionStats>;
  dismissedLegacyKeys?: string[];
}

interface LedgerState {
  sessions: Map<string, SessionStats>;
  dismissedLegacyKeys: Set<string>;
}

const memoryLedger = new Map<string, SessionStats>();
const memoryDismissedLegacyKeys = new Set<string>();

const VALID_TOOL_SOURCES = new Set<string>(['antigravity', 'claude', 'codex']);

function isPersistentLedgerEnabled(): boolean {
  if (process.env.BURNRATE_SESSION_LEDGER_PATH) return true;
  if (process.env.BURNRATE_GEMINI_DIR || process.env.BURNRATE_CLAUDE_DIR || process.env.BURNRATE_CODEX_DIR) {
    return false;
  }
  return true;
}

export function getSessionLedgerPath(): string {
  if (process.env.BURNRATE_SESSION_LEDGER_PATH) {
    return path.resolve(process.env.BURNRATE_SESSION_LEDGER_PATH);
  }
  return path.join(os.homedir(), '.burnrate', 'sessions-ledger.json');
}

export function getSessionKey(source: SessionStats['source'], sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function isValidSessionKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) return false;
  const sep = key.indexOf(':');
  if (sep <= 0 || sep === key.length - 1) return false;
  const source = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (!VALID_TOOL_SOURCES.has(source)) return false;
  return id.trim().length > 0 && !/[\r\n\0]/.test(id);
}

function loadLedgerState(): LedgerState {
  if (!isPersistentLedgerEnabled()) {
    return {
      sessions: new Map(memoryLedger),
      dismissedLegacyKeys: new Set(memoryDismissedLegacyKeys),
    };
  }

  const ledgerPath = getSessionLedgerPath();
  if (!fs.existsSync(ledgerPath)) {
    return { sessions: new Map(), dismissedLegacyKeys: new Set() };
  }

  try {
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionLedgerFile>;
    const sessions = new Map<string, SessionStats>();
    const dismissedLegacyKeys = new Set<string>();
    if (parsed && parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [k, v] of Object.entries(parsed.sessions)) {
        if (
          v &&
          typeof v === 'object' &&
          VALID_TOOL_SOURCES.has(v.source) &&
          typeof v.sessionId === 'string' &&
          v.sessionId.length > 0 &&
          typeof v.turns === 'number' &&
          Number.isFinite(v.turns) &&
          typeof v.totalTokens === 'number' &&
          Number.isFinite(v.totalTokens) &&
          typeof v.costUSD === 'number' &&
          Number.isFinite(v.costUSD) &&
          typeof v.cacheSavingsUSD === 'number' &&
          Number.isFinite(v.cacheSavingsUSD) &&
          Array.isArray(v.turnHistory)
        ) {
          sessions.set(k, v);
        }
      }
    }
    if (parsed && Array.isArray(parsed.dismissedLegacyKeys)) {
      for (const item of parsed.dismissedLegacyKeys) {
        if (typeof item === 'string' && isValidSessionKey(item)) {
          dismissedLegacyKeys.add(item);
        }
      }
    }
    return { sessions, dismissedLegacyKeys };
  } catch {
    return { sessions: new Map(), dismissedLegacyKeys: new Set() };
  }
}

function saveLedgerState(state: LedgerState): void {
  if (!isPersistentLedgerEnabled()) {
    memoryLedger.clear();
    for (const [k, v] of state.sessions.entries()) {
      memoryLedger.set(k, structuredClone(v));
    }
    memoryDismissedLegacyKeys.clear();
    for (const key of state.dismissedLegacyKeys) {
      memoryDismissedLegacyKeys.add(key);
    }
    return;
  }

  try {
    const ledgerPath = getSessionLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    const payload: SessionLedgerFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: Object.fromEntries(state.sessions.entries()),
      ...(state.dismissedLegacyKeys.size > 0
        ? { dismissedLegacyKeys: Array.from(state.dismissedLegacyKeys) }
        : {}),
    };
    const serialized = JSON.stringify(payload);
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
    // Ignore write errors in read-only environments
  }
}

function hasSessionChanged(prev: SessionStats | undefined, next: SessionStats): boolean {
  if (!prev) return true;
  if (Boolean(prev.deleted) !== Boolean(next.deleted)) return true;
  if ((prev.deletedAt || '') !== (next.deletedAt || '')) return true;
  if (prev.turns !== next.turns) return true;
  if (prev.totalTokens !== next.totalTokens) return true;
  if (Math.abs(prev.costUSD - next.costUSD) > 1e-6) return true;
  if (Math.abs(prev.cacheSavingsUSD - next.cacheSavingsUSD) > 1e-6) return true;
  if (prev.lastActiveAt !== next.lastActiveAt) return true;
  if (prev.sessionTitle !== next.sessionTitle) return true;
  if (prev.workspace !== next.workspace) return true;
  if (prev.primaryModelLabel !== next.primaryModelLabel) return true;
  if (prev.turnHistory.length !== next.turnHistory.length) return true;
  return false;
}

function mergeOrphanedSession(prev: SessionStats | undefined, orphan: SessionStats, nowIso: string): SessionStats {
  const bestBase = prev && prev.turns > orphan.turns ? prev : orphan;
  const hasPrevTitle =
    prev?.sessionTitle &&
    prev.sessionTitle !== prev.sessionId &&
    (orphan.sessionTitle === orphan.sessionId || orphan.sessionTitle.length === 0);

  return {
    ...bestBase,
    sessionTitle: hasPrevTitle ? prev!.sessionTitle : bestBase.sessionTitle,
    deleted: true,
    deletedAt: prev?.deleted && prev.deletedAt ? prev.deletedAt : nowIso,
  };
}

export function reconcileSessionLedger(params: {
  liveSessions: SessionStats[];
  orphanedDeletedSessions: SessionStats[];
  mergedSubagentKeys?: Set<string>;
  geminiDirExists: boolean;
  claudeDirExists: boolean;
  codexDirExists?: boolean;
}): {
  activeSessions: SessionStats[];
  deletedSessions: SessionStats[];
} {
  const ledgerState = loadLedgerState();
  const ledger = ledgerState.sessions;
  const nowIso = new Date().toISOString();
  let dirty = false;

  // Purge obsolete separate entries for subagents now rolled up into their parent chat
  if (params.mergedSubagentKeys && params.mergedSubagentKeys.size > 0) {
    for (const subKey of params.mergedSubagentKeys) {
      if (ledger.delete(subKey)) {
        dirty = true;
      }
    }
  }

  const liveMap = new Map<string, SessionStats>();
  for (const s of params.liveSessions) {
    const key = getSessionKey(s.source, s.sessionId);
    const existingLive = liveMap.get(key);
    if (!existingLive || s.turns >= existingLive.turns) {
      const cleanLive: SessionStats = { ...s, deleted: false };
      delete cleanLive.deletedAt;
      liveMap.set(key, cleanLive);
    }
  }

  const orphanMap = new Map<string, SessionStats>();
  for (const s of params.orphanedDeletedSessions) {
    const key = getSessionKey(s.source, s.sessionId);
    if (liveMap.has(key)) continue;
    const existingOrphan = orphanMap.get(key);
    if (!existingOrphan || s.turns >= existingOrphan.turns) {
      orphanMap.set(key, s);
    }
  }

  // 1. Upsert active sessions (restoring previously deleted ones if they reappear on disk)
  for (const [key, live] of liveMap.entries()) {
    const prev = ledger.get(key);
    if (hasSessionChanged(prev, live)) {
      ledger.set(key, live);
      dirty = true;
    }
  }

  // 2. Archive orphaned deleted sessions (e.g. Antigravity brain/ left behind after conversation DB removal)
  for (const [key, orphan] of orphanMap.entries()) {
    const prev = ledger.get(key);
    const merged = mergeOrphanedSession(prev, orphan, nowIso);
    if (hasSessionChanged(prev, merged)) {
      ledger.set(key, merged);
      dirty = true;
    }
  }

  // 3. Mark previously recorded sessions that disappeared from disk as deleted
  for (const [key, prev] of ledger.entries()) {
    if (liveMap.has(key) || orphanMap.has(key)) continue;
    const toolRootExists =
      prev.source === 'antigravity'
        ? params.geminiDirExists
        : prev.source === 'claude'
          ? params.claudeDirExists
          : Boolean(params.codexDirExists);
    if (!toolRootExists) continue;

    if (!prev.deleted) {
      ledger.set(key, {
        ...prev,
        deleted: true,
        deletedAt: nowIso,
      });
      dirty = true;
    }
  }

  if (dirty) {
    saveLedgerState(ledgerState);
  }

  const activeSessions = Array.from(liveMap.values()).sort((a, b) =>
    b.lastActiveAt > a.lastActiveAt ? 1 : -1
  );

  const deletedSessions: SessionStats[] = [];
  for (const entry of ledger.values()) {
    if (entry.deleted) {
      deletedSessions.push(entry);
    }
  }
  deletedSessions.sort((a, b) => {
    const aKey = a.deletedAt || a.lastActiveAt || '';
    const bKey = b.deletedAt || b.lastActiveAt || '';
    return bKey > aKey ? 1 : -1;
  });

  return { activeSessions, deletedSessions };
}

export function upsertSingleSessionToLedger(session: SessionStats): boolean {
  const ledgerState = loadLedgerState();
  const key = getSessionKey(session.source, session.sessionId);
  const prev = ledgerState.sessions.get(key);

  // Never downgrade an already richer snapshot in the ledger
  if (prev && prev.turns > session.turns && prev.totalTokens >= session.totalTokens) {
    return false;
  }

  const cleanSession: SessionStats = {
    ...session,
    deleted: false,
  };
  delete cleanSession.deletedAt;

  if (!hasSessionChanged(prev, cleanSession)) {
    return false;
  }

  ledgerState.sessions.set(key, cleanSession);
  saveLedgerState(ledgerState);
  return true;
}

export function getDismissedLegacyKeys(): Set<string> {
  return loadLedgerState().dismissedLegacyKeys;
}

export function getDismissedLegacyCount(): number {
  return loadLedgerState().dismissedLegacyKeys.size;
}

export function dismissLegacySessions(keys: string[]): number {
  const validKeys = keys.filter(isValidSessionKey);
  if (validKeys.length === 0) return 0;

  const ledgerState = loadLedgerState();
  let added = 0;
  for (const key of validKeys) {
    if (!ledgerState.dismissedLegacyKeys.has(key)) {
      ledgerState.dismissedLegacyKeys.add(key);
      added++;
    }
  }

  if (added > 0) {
    saveLedgerState(ledgerState);
  }
  return added;
}

export function restoreDismissedLegacySessions(keys?: string[]): number {
  const ledgerState = loadLedgerState();
  if (ledgerState.dismissedLegacyKeys.size === 0) return 0;

  let restored = 0;
  if (!keys || keys.length === 0) {
    restored = ledgerState.dismissedLegacyKeys.size;
    ledgerState.dismissedLegacyKeys.clear();
  } else {
    for (const key of keys) {
      if (ledgerState.dismissedLegacyKeys.delete(key)) {
        restored++;
      }
    }
  }

  if (restored > 0) {
    saveLedgerState(ledgerState);
  }
  return restored;
}

export function resetMemorySessionLedger(): void {
  memoryLedger.clear();
  memoryDismissedLegacyKeys.clear();
}
