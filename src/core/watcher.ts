import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { getWatchRoots, scanAllLogs, toRelativeHomePath } from './parser.js';
import { defaultQuotaEngine } from './quota/engine.js';
import { getQuotaStatePath } from './quota/store.js';
import type { BurnrateSnapshot, ToolSource } from './types.js';

export interface LogWatcherHandle {
  watcher: FSWatcher;
  close: () => Promise<void>;
}

function stableQuotasFingerprint(quotas: BurnrateSnapshot['quotas']): string {
  if (!quotas) return 'null';
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(quotas)) {
    if (!v) continue;
    const { serverNowMs: _ignoreNow, ...rest } = v;
    normalized[k] = rest;
  }
  return JSON.stringify(normalized);
}

function computeSnapshotFingerprint(snapshot: BurnrateSnapshot): string {
  const activePart = snapshot.sessions
    .map(
      (s) =>
        `${s.source}:${s.sessionId}:${s.turns}:${s.totalTokens}:${Number(s.costUSD || 0).toFixed(4)}:${s.sessionTitle}`
    )
    .join('|');
  const deletedPart = (snapshot.deletedSessions || [])
    .map(
      (s) =>
        `${s.source}:${s.sessionId}:${s.turns}:${s.totalTokens}:${Number(s.costUSD || 0).toFixed(4)}:${s.deletedAt || ''}`
    )
    .join('|');
  const settingsPart = JSON.stringify(snapshot.settings || null);
  const quotaPart = stableQuotasFingerprint(snapshot.quotas);
  return `${snapshot.sessions.length}#${(snapshot.deletedSessions || []).length}#${activePart}##${deletedPart}##${settingsPart}##${quotaPart}`;
}

function isRelevantWatchEvent(filePath: string, eventType: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  if (norm.endsWith('/transcript_full.jsonl') || norm.includes('/chunks/')) {
    return false;
  }
  if (eventType === 'unlinkDir') {
    return (
      norm.includes('/brain/') ||
      norm.includes('/projects/') ||
      norm.includes('/sessions/') ||
      norm.endsWith('/brain') ||
      norm.endsWith('/projects') ||
      norm.endsWith('/sessions')
    );
  }
  if (norm.endsWith('.jsonl')) {
    return true;
  }
  if (norm.includes('/conversations/') && (norm.endsWith('.db') || norm.endsWith('.pb'))) {
    return eventType === 'unlink' || eventType === 'add';
  }
  if (
    norm.endsWith('/conversation_summaries.db') ||
    norm.endsWith('/conversation_summaries.db-wal') ||
    norm.endsWith('/quota-state.json')
  ) {
    return true;
  }
  return false;
}

export function startLogWatcher(
  onUpdate: (snapshot: BurnrateSnapshot, changedPath: string) => void
): LogWatcherHandle {
  const { geminiDir, claudeDir, codexDir } = getWatchRoots();
  const quotaStateDir = path.dirname(getQuotaStatePath());
  try {
    fs.mkdirSync(quotaStateDir, { recursive: true });
  } catch {
    // ignore if readonly or invalid env path
  }
  const watchTargets = [geminiDir, claudeDir, codexDir, quotaStateDir].filter((dir) => fs.existsSync(dir));

  let debounceTimer: NodeJS.Timeout | null = null;
  let lastChangedPath = '';
  let lastFingerprint = '';
  try {
    lastFingerprint = computeSnapshotFingerprint(scanAllLogs(false));
  } catch {
    lastFingerprint = '';
  }

  const runScanAndNotify = (changedLabel: string, onlyIfChanged: boolean) => {
    try {
      const snapshot = scanAllLogs(false);
      const nextFingerprint = computeSnapshotFingerprint(snapshot);
      if (onlyIfChanged && nextFingerprint === lastFingerprint) {
        return;
      }
      lastFingerprint = nextFingerprint;
      onUpdate(snapshot, changedLabel);
    } catch {
      // Ignore transient read errors while files are being written or removed
    }
  };

  const detectChangedProvider = (filePath: string): ToolSource | null => {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (norm.includes('/.gemini/')) return 'antigravity';
    if (norm.includes('/.claude/')) return 'claude';
    if (norm.includes('/.codex/')) return 'codex';
    return null;
  };

  const triggerUpdate = (eventType: string) => (filePath: string) => {
    if (!isRelevantWatchEvent(filePath, eventType)) return;

    const changedTool = detectChangedProvider(filePath);
    if (changedTool === 'antigravity' && (eventType === 'add' || eventType === 'change')) {
      defaultQuotaEngine.notifyActivity('antigravity');
    } else if (changedTool === 'codex' && (eventType === 'add' || eventType === 'change')) {
      defaultQuotaEngine.notifyActivity('codex');
    }

    lastChangedPath = toRelativeHomePath(filePath);
    if (debounceTimer) clearTimeout(debounceTimer);
    const isNoiseProne =
      eventType === 'change' && filePath.toLowerCase().includes('conversation_summaries.db');
    debounceTimer = setTimeout(() => {
      runScanAndNotify(lastChangedPath, isNoiseProne);
    }, 180);
  };

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    persistent: true,
    ignorePermissionErrors: true,
    ignored: (testPath: string) => {
      const norm = testPath.replace(/\\/g, '/').toLowerCase();
      if (
        norm.includes('/node_modules/') ||
        norm.includes('/.git/') ||
        norm.includes('/cache/') ||
        norm.includes('/paste-cache/') ||
        norm.includes('/downloads/') ||
        norm.includes('/chunks/')
      ) {
        return true;
      }
      return false;
    },
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('add', triggerUpdate('add'));
  watcher.on('change', triggerUpdate('change'));
  watcher.on('unlink', triggerUpdate('unlink'));
  watcher.on('unlinkDir', triggerUpdate('unlinkDir'));

  // Lightweight periodic safety net for Windows fs.watch missed directory/DB deletion events
  const reconcileInterval = setInterval(() => {
    runScanAndNotify('sync', true);
  }, 5000);
  reconcileInterval.unref?.();

  return {
    watcher,
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(reconcileInterval);
      await watcher.close();
    },
  };
}
