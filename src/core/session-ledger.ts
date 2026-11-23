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

function countTaggedTurns(session: SessionStats | undefined): number {
  if (!session || !Array.isArray(session.turnHistory)) return 0;
  let count = 0;
  for (const t of session.turnHistory) {
    if (t.subagentId || t.subagentName) count++;
  }
  return count;
}

function countTitledSubagentTurns(session: SessionStats | undefined): number {
  if (!session || !Array.isArray(session.turnHistory)) return 0;
  let count = 0;
  for (const t of session.turnHistory) {
    if (t.subagentTitle) count++;
  }
  return count;
}

function isEphemeralSubagentTurn(t: SessionStats['turnHistory'][number]): boolean {
  return Boolean(
    t.subagentName === '/btw' || (typeof t.subagentId === 'string' && t.subagentId.startsWith('btw:'))
  );
}

function turnSignature(t: SessionStats['turnHistory'][number]): string {
  return `${t.timestamp}|${t.normalizedModel}|${t.totalTokens}|${t.subagentId || ''}`;
}

function recomputeSessionFromTurns(base: SessionStats, turns: SessionStats['turnHistory']): SessionStats {
  const sorted = [...turns].sort((a, b) =>
    a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let costUSD = 0;
  let cacheSavingsUSD = 0;
  let estimatedTurns = 0;
  let startedAt = base.startedAt;
  let lastActiveAt = base.lastActiveAt;

  const modelCounts = new Map<string, { label: string; count: number }>();
  for (const t of sorted) {
    inputTokens += t.inputTokens;
    outputTokens += t.outputTokens;
    cacheReadTokens += t.cacheReadTokens;
    cacheWriteTokens += t.cacheWriteTokens;
    totalTokens += t.totalTokens;
    costUSD += t.costUSD;
    cacheSavingsUSD += t.cacheSavingsUSD;
    if (t.estimated) estimatedTurns++;
    if (t.timestamp) {
      if (!startedAt || t.timestamp < startedAt) startedAt = t.timestamp;
      if (!lastActiveAt || t.timestamp > lastActiveAt) lastActiveAt = t.timestamp;
    }
    const existing = modelCounts.get(t.normalizedModel);
    if (existing) existing.count += 1;
    else modelCounts.set(t.normalizedModel, { label: t.modelLabel, count: 1 });
  }

  let primaryModel = base.primaryModel;
  let primaryModelLabel = base.primaryModelLabel;
  let maxCount = -1;
  for (const [mKey, info] of modelCounts.entries()) {
    if (info.count > maxCount) {
      maxCount = info.count;
      primaryModel = mKey;
      primaryModelLabel = info.label;
    }
  }

  return {
    ...base,
    startedAt,
    lastActiveAt,
    primaryModel,
    primaryModelLabel,
    turns: sorted.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUSD,
    cacheSavingsUSD,
    estimatedTurns,
    turnHistory: sorted,
  };
}

function mergePreservedEphemeralTurns(live: SessionStats, prev: SessionStats | undefined): SessionStats {
  if (!prev || !Array.isArray(prev.turnHistory) || prev.turnHistory.length === 0) return live;

  const liveSubIds = new Set<string>();
  const liveSigs = new Set<string>();
  for (const t of live.turnHistory) {
    if (t.subagentId) liveSubIds.add(t.subagentId);
    liveSigs.add(turnSignature(t));
  }

  const preserved: SessionStats['turnHistory'] = [];
  for (const t of prev.turnHistory) {
    if (!isEphemeralSubagentTurn(t)) continue;
    // If this ephemeral subagent (/btw) is currently active on disk, live already has its freshest turns
    if (t.subagentId && liveSubIds.has(t.subagentId)) continue;
    const sig = turnSignature(t);
    if (liveSigs.has(sig)) continue;
    liveSigs.add(sig);
    preserved.push(t);
  }

  if (preserved.length === 0) return live;
  return recomputeSessionFromTurns(live, [...live.turnHistory, ...preserved]);
}

function absorbChildTurnsIntoParent(
  parent: SessionStats,
  childTurns: SessionStats['turnHistory'],
  childSubagentId: string,
  childSubagentName: string,
  childSubagentTitle?: string
): SessionStats {
  if (childTurns.length === 0) return parent;
  // Drop any stale copy of this exact childSubagentId from parent before adding the absorbed turns
  const retained = parent.turnHistory.filter((t) => t.subagentId !== childSubagentId);
  const existingSigs = new Set(retained.map(turnSignature));
  const toAdd: SessionStats['turnHistory'] = [];
  for (const t of childTurns) {
    const resolvedTitle = t.subagentTitle || childSubagentTitle;
    const tagged = {
      ...t,
      subagentId: t.subagentId || childSubagentId,
      subagentName: t.subagentName || childSubagentName,
      ...(resolvedTitle ? { subagentTitle: resolvedTitle } : {}),
    };
    const sig = turnSignature(tagged);
    if (!existingSigs.has(sig)) {
      existingSigs.add(sig);
      toAdd.push(tagged);
    }
  }
  if (toAdd.length === 0) return parent;
  return recomputeSessionFromTurns(parent, [...retained, ...toAdd]);
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
  if (countTaggedTurns(prev) !== countTaggedTurns(next)) return true;
  if (countTitledSubagentTurns(prev) !== countTitledSubagentTurns(next)) return true;
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

export interface RolledUpParentResolution {
  parentKey: string;
  subagentId: string;
  subagentName: string;
  subagentTitle?: string;
}

export function reconcileSessionLedger(params: {
  liveSessions: SessionStats[];
  orphanedDeletedSessions: SessionStats[];
  mergedSubagentKeys?: Set<string>;
  resolveRolledUpParent?: (session: SessionStats) => RolledUpParentResolution | null;
  resolveBtwTurnTitle?: (parent: SessionStats, subagentId: string, earliestTimestamp: string) => string | undefined;
  geminiDirExists: boolean;
  claudeDirExists: boolean;
  codexDirExists?: boolean;
}): {
  activeSessions: SessionStats[];
  deletedSessions: SessionStats[];
  absorbedKeys: Set<string>;
} {
  const ledgerState = loadLedgerState();
  const ledger = ledgerState.sessions;
  const nowIso = new Date().toISOString();
  const absorbedKeys = new Set<string>();
  let dirty = false;

  // Purge obsolete separate entries for subagents now rolled up into their parent chat
  if (params.mergedSubagentKeys && params.mergedSubagentKeys.size > 0) {
    for (const subKey of params.mergedSubagentKeys) {
      absorbedKeys.add(subKey);
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

  // 0. Preserve previously persisted ephemeral turns (/btw) on active sessions BEFORE checking absorbed entries
  for (const [key, live] of liveMap.entries()) {
    const prev = ledger.get(key);
    const withPreserved = mergePreservedEphemeralTurns(live, prev);
    if (withPreserved !== live) {
      liveMap.set(key, withPreserved);
    }
  }

  // 0b. Roll up orphaned-on-disk or previously-archived /btw & subagent entries into their parent chat
  if (params.resolveRolledUpParent) {
    const tryAbsorb = (key: string, candidate: SessionStats): boolean => {
      if (candidate.untrackedHistory || candidate.turnHistory.length === 0) return false;
      const target = params.resolveRolledUpParent!(candidate);
      if (!target || target.parentKey === key) return false;

      const liveParent = liveMap.get(target.parentKey);
      if (liveParent) {
        const updatedParent = absorbChildTurnsIntoParent(
          liveParent,
          candidate.turnHistory,
          target.subagentId,
          target.subagentName,
          target.subagentTitle
        );
        liveMap.set(target.parentKey, updatedParent);
        absorbedKeys.add(key);
        if (ledger.delete(key)) dirty = true;
        dirty = true;
        return true;
      }

      const ledgerParent = ledger.get(target.parentKey);
      if (ledgerParent && !ledgerParent.untrackedHistory) {
        const updatedParent = absorbChildTurnsIntoParent(
          ledgerParent,
          candidate.turnHistory,
          target.subagentId,
          target.subagentName,
          target.subagentTitle
        );
        ledger.set(target.parentKey, updatedParent);
        absorbedKeys.add(key);
        ledger.delete(key);
        dirty = true;
        return true;
      }
      return false;
    };

    for (const [key, orphan] of Array.from(orphanMap.entries())) {
      if (tryAbsorb(key, orphan)) {
        orphanMap.delete(key);
      }
    }
    for (const [key, prev] of Array.from(ledger.entries())) {
      if (liveMap.has(key) || orphanMap.has(key)) continue;
      tryAbsorb(key, prev);
    }
  }

  // 0c. Backfill missing subagentTitle on previously preserved /btw runs from history.jsonl
  if (params.resolveBtwTurnTitle) {
    const backfillSessionBtwTitles = (session: SessionStats): SessionStats => {
      const untitledEarliest = new Map<string, string>();
      for (const t of session.turnHistory) {
        if (!isEphemeralSubagentTurn(t) || t.subagentTitle) continue;
        const id = t.subagentId || '/btw';
        const prevTs = untitledEarliest.get(id);
        if (!prevTs || (t.timestamp && t.timestamp < prevTs)) {
          untitledEarliest.set(id, t.timestamp || '');
        }
      }
      if (untitledEarliest.size === 0) return session;
      const resolved = new Map<string, string>();
      for (const [subId, earliestTs] of untitledEarliest.entries()) {
        const title = params.resolveBtwTurnTitle!(session, subId, earliestTs);
        if (title) resolved.set(subId, title);
      }
      if (resolved.size === 0) return session;
      return {
        ...session,
        turnHistory: session.turnHistory.map((t) => {
          if (!isEphemeralSubagentTurn(t) || t.subagentTitle) return t;
          const title = resolved.get(t.subagentId || '/btw');
          return title ? { ...t, subagentTitle: title } : t;
        }),
      };
    };

    for (const [key, live] of liveMap.entries()) {
      const updated = backfillSessionBtwTitles(live);
      if (updated !== live) liveMap.set(key, updated);
    }
    for (const [key, prev] of ledger.entries()) {
      if (liveMap.has(key)) continue;
      const updated = backfillSessionBtwTitles(prev);
      if (updated !== prev) {
        ledger.set(key, updated);
        dirty = true;
      }
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
    const merged = mergeOrphanedSession(prev, mergePreservedEphemeralTurns(orphan, prev), nowIso);
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

  return { activeSessions, deletedSessions, absorbedKeys };
}

export function upsertSingleSessionToLedger(session: SessionStats): boolean {
  const ledgerState = loadLedgerState();
  const key = getSessionKey(session.source, session.sessionId);
  const prev = ledgerState.sessions.get(key);
  const preservedSession = mergePreservedEphemeralTurns(session, prev);

  // Never downgrade an already richer snapshot in the ledger
  if (prev && prev.turns > preservedSession.turns && prev.totalTokens >= preservedSession.totalTokens) {
    return false;
  }

  const cleanSession: SessionStats = {
    ...preservedSession,
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

function isValidLedgerSession(v: unknown): v is SessionStats {
  if (!v || typeof v !== 'object') return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec.source === 'string' &&
    VALID_TOOL_SOURCES.has(rec.source) &&
    typeof rec.sessionId === 'string' &&
    rec.sessionId.trim().length > 0 &&
    typeof rec.turns === 'number' &&
    Number.isFinite(rec.turns) &&
    typeof rec.totalTokens === 'number' &&
    Number.isFinite(rec.totalTokens) &&
    typeof rec.costUSD === 'number' &&
    Number.isFinite(rec.costUSD) &&
    typeof rec.cacheSavingsUSD === 'number' &&
    Number.isFinite(rec.cacheSavingsUSD) &&
    Array.isArray(rec.turnHistory)
  );
}

function mergeTwoSessions(existing: SessionStats, incoming: SessionStats): SessionStats {
  const existingSigs = new Set(existing.turnHistory.map(turnSignature));
  const extraTurns: SessionStats['turnHistory'] = [];
  for (const t of incoming.turnHistory) {
    const sig = turnSignature(t);
    if (!existingSigs.has(sig)) {
      existingSigs.add(sig);
      extraTurns.push(t);
    }
  }
  const hasBetterTitle =
    (!existing.sessionTitle || existing.sessionTitle === existing.sessionId) &&
    Boolean(incoming.sessionTitle && incoming.sessionTitle !== incoming.sessionId);

  if (extraTurns.length === 0) {
    return hasBetterTitle ? { ...existing, sessionTitle: incoming.sessionTitle } : existing;
  }

  const base = hasBetterTitle ? { ...existing, sessionTitle: incoming.sessionTitle } : existing;
  return recomputeSessionFromTurns(base, [...existing.turnHistory, ...extraTurns]);
}

export function exportSessionLedgerSnapshot(): SessionLedgerFile {
  const state = loadLedgerState();
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: Object.fromEntries(
      Array.from(state.sessions.entries()).map(([k, v]) => [k, structuredClone(v)])
    ),
    ...(state.dismissedLegacyKeys.size > 0
      ? { dismissedLegacyKeys: Array.from(state.dismissedLegacyKeys) }
      : {}),
  };
}

export function importSessionLedgerSnapshot(
  raw: unknown,
  mode: 'merge' | 'replace' = 'merge',
  fallbackArchiveIso?: string
): {
  importedSessions: number;
  mergedSessions: number;
  totalSessionsInBackup: number;
  dismissedLegacyCount: number;
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid sessionsLedger payload in backup');
  }
  const parsed = raw as Partial<SessionLedgerFile>;
  if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
    throw new Error('Backup sessionsLedger.sessions must be an object');
  }

  const nowIso = fallbackArchiveIso || new Date().toISOString();
  const validIncoming = new Map<string, SessionStats>();
  for (const val of Object.values(parsed.sessions)) {
    if (!isValidLedgerSession(val)) continue;
    const key = getSessionKey(val.source, val.sessionId);
    // Mark imported entries as archived until live disk reconciliation confirms active files on this PC
    const normalized: SessionStats = {
      ...structuredClone(val),
      deleted: true,
      deletedAt: val.deletedAt || val.lastActiveAt || nowIso,
    };
    validIncoming.set(key, normalized);
  }

  const incomingDismissed = new Set<string>();
  if (Array.isArray(parsed.dismissedLegacyKeys)) {
    for (const item of parsed.dismissedLegacyKeys) {
      if (typeof item === 'string' && isValidSessionKey(item)) {
        incomingDismissed.add(item);
      }
    }
  }

  const current = loadLedgerState();
  let importedSessions = 0;
  let mergedSessions = 0;

  if (mode === 'replace') {
    const nextState: LedgerState = {
      sessions: validIncoming,
      dismissedLegacyKeys: incomingDismissed,
    };
    saveLedgerState(nextState);
    return {
      importedSessions: validIncoming.size,
      mergedSessions: 0,
      totalSessionsInBackup: validIncoming.size,
      dismissedLegacyCount: incomingDismissed.size,
    };
  }

  // Merge mode: preserve active/local sessions and merge any missing sessions or turns from backup
  const nextSessions = new Map(current.sessions);
  for (const [key, inc] of validIncoming.entries()) {
    const prev = nextSessions.get(key);
    if (!prev) {
      nextSessions.set(key, inc);
      importedSessions++;
    } else {
      const merged = mergeTwoSessions(prev, inc);
      if (hasSessionChanged(prev, merged)) {
        nextSessions.set(key, merged);
        mergedSessions++;
      }
    }
  }

  const nextDismissed = new Set(current.dismissedLegacyKeys);
  for (const key of incomingDismissed) {
    nextDismissed.add(key);
  }

  saveLedgerState({
    sessions: nextSessions,
    dismissedLegacyKeys: nextDismissed,
  });

  return {
    importedSessions,
    mergedSessions,
    totalSessionsInBackup: validIncoming.size,
    dismissedLegacyCount: nextDismissed.size,
  };
}
