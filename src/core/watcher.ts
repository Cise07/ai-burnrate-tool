import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import { getWatchRoots, scanAllLogs, toRelativeHomePath } from './parser.js';
import type { BurnrateSnapshot } from './types.js';

export interface LogWatcherHandle {
  watcher: FSWatcher;
  close: () => Promise<void>;
}

export function startLogWatcher(
  onUpdate: (snapshot: BurnrateSnapshot, changedPath: string) => void
): LogWatcherHandle {
  const { geminiDir, claudeDir } = getWatchRoots();
  const watchTargets = [geminiDir, claudeDir].filter((dir) => fs.existsSync(dir));

  let debounceTimer: NodeJS.Timeout | null = null;
  let lastChangedPath = '';

  const triggerUpdate = (filePath: string) => {
    if (!filePath.toLowerCase().endsWith('.jsonl')) return;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.endsWith('/transcript_full.jsonl') || normalized.includes('/chunks/')) {
      return;
    }

    lastChangedPath = toRelativeHomePath(filePath);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const snapshot = scanAllLogs(false);
        onUpdate(snapshot, lastChangedPath);
      } catch {
        // Ignore transient read errors while file is being written
      }
    }, 150);
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

  watcher.on('add', triggerUpdate);
  watcher.on('change', triggerUpdate);
  watcher.on('unlink', triggerUpdate);

  return {
    watcher,
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await watcher.close();
    },
  };
}
