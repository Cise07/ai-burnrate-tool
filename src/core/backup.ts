import fs from 'node:fs';
import path from 'node:path';
import { getPackageRoot, importPricingLedger, loadPricing } from './pricing.js';
import {
  exportSessionLedgerSnapshot,
  importSessionLedgerSnapshot,
  type SessionLedgerFile,
} from './session-ledger.js';
import {
  DEFAULT_USER_SETTINGS,
  loadUserSettings,
  sanitizeUserSettings,
  saveUserSettings,
} from './settings.js';
import type { PricingConfig, UserSettings } from './types.js';

export const BACKUP_FORMAT = 'ai-burnrate-backup' as const;
export const BACKUP_VERSION = 1 as const;

export type BackupImportMode = 'merge' | 'replace';

export interface BurnrateBackupBundle {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  appVersion: string;
  settings: UserSettings;
  sessionsLedger: SessionLedgerFile;
  pricingLedger: PricingConfig | null;
}

export interface BackupImportResult {
  mode: BackupImportMode;
  exportedAt: string;
  importedSessions: number;
  mergedSessions: number;
  totalSessionsInBackup: number;
  dismissedLegacyCount: number;
  pricingSnapshotsAdded: number;
  pricingModelsMerged: number;
  settingsRestored: boolean;
}

function readAppVersion(): string {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function getDefaultBackupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `burnrate-backup-${stamp}.json`;
}

export function createBackupBundle(): BurnrateBackupBundle {
  const settings = loadUserSettings();
  const sessionsLedger = exportSessionLedgerSnapshot();
  let pricingLedger: PricingConfig | null = null;
  try {
    pricingLedger = structuredClone(loadPricing(false));
  } catch {
    pricingLedger = null;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: readAppVersion(),
    settings,
    sessionsLedger,
    pricingLedger,
  };
}

export function validateBackupBundle(raw: unknown): BurnrateBackupBundle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Backup file must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== BACKUP_FORMAT) {
    throw new Error(
      `Unsupported backup format. Expected format "${BACKUP_FORMAT}" (is this a Burnrate backup file?).`
    );
  }
  if (obj.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version "${String(obj.version)}". Expected version ${BACKUP_VERSION}.`);
  }
  if (
    !obj.sessionsLedger ||
    typeof obj.sessionsLedger !== 'object' ||
    Array.isArray(obj.sessionsLedger) ||
    !(obj.sessionsLedger as Record<string, unknown>).sessions ||
    typeof (obj.sessionsLedger as Record<string, unknown>).sessions !== 'object' ||
    Array.isArray((obj.sessionsLedger as Record<string, unknown>).sessions)
  ) {
    throw new Error('Backup file is missing a valid sessionsLedger.sessions object.');
  }

  const exportedAt =
    typeof obj.exportedAt === 'string' && !Number.isNaN(new Date(obj.exportedAt).getTime())
      ? obj.exportedAt
      : new Date().toISOString();

  const settings = sanitizeUserSettings(obj.settings, DEFAULT_USER_SETTINGS);
  const pricingLedger =
    obj.pricingLedger && typeof obj.pricingLedger === 'object' && !Array.isArray(obj.pricingLedger)
      ? (obj.pricingLedger as PricingConfig)
      : null;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : 'unknown',
    settings,
    sessionsLedger: obj.sessionsLedger as SessionLedgerFile,
    pricingLedger,
  };
}

export function importBackupBundle(
  raw: unknown,
  options: { mode?: BackupImportMode } = {}
): BackupImportResult {
  const mode: BackupImportMode = options.mode === 'replace' ? 'replace' : 'merge';
  const bundle = validateBackupBundle(raw);

  // Restore user settings (subscriptions, layout, includeDeletedInTotals, trackingStartAt)
  let settingsRestored = false;
  if (bundle.settings) {
    const targetSettings =
      mode === 'replace'
        ? sanitizeUserSettings(bundle.settings, DEFAULT_USER_SETTINGS)
        : bundle.settings;
    saveUserSettings(targetSettings);
    settingsRestored = true;
  }

  // Restore or merge historical pricing ledger
  const pricingRes = bundle.pricingLedger
    ? importPricingLedger(bundle.pricingLedger, mode)
    : { snapshotsAdded: 0, modelsMerged: 0 };

  // Restore or merge sessions ledger (archived sessions + deleted chats + /btw turns + dismissed legacy keys)
  const sessionsRes = importSessionLedgerSnapshot(bundle.sessionsLedger, mode, bundle.exportedAt);

  return {
    mode,
    exportedAt: bundle.exportedAt,
    importedSessions: sessionsRes.importedSessions,
    mergedSessions: sessionsRes.mergedSessions,
    totalSessionsInBackup: sessionsRes.totalSessionsInBackup,
    dismissedLegacyCount: sessionsRes.dismissedLegacyCount,
    pricingSnapshotsAdded: pricingRes.snapshotsAdded,
    pricingModelsMerged: pricingRes.modelsMerged,
    settingsRestored,
  };
}

export function exportBackupToFile(targetPath?: string): {
  filePath: string;
  sizeBytes: number;
  sessionCount: number;
  pricingSnapshots: number;
  exportedAt: string;
} {
  const bundle = createBackupBundle();
  const defaultName = getDefaultBackupFilename(new Date(bundle.exportedAt));

  let resolvedPath: string;
  if (!targetPath || !targetPath.trim()) {
    resolvedPath = path.resolve(process.cwd(), defaultName);
  } else {
    const candidate = path.resolve(targetPath.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      resolvedPath = path.join(candidate, defaultName);
    } else {
      resolvedPath = candidate;
    }
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const serialized = JSON.stringify(bundle, null, 2);
  const tmpPath = `${resolvedPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, resolvedPath);
  } catch {
    fs.writeFileSync(resolvedPath, serialized, { encoding: 'utf-8', mode: 0o600 });
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }

  return {
    filePath: resolvedPath,
    sizeBytes: Buffer.byteLength(serialized, 'utf-8'),
    sessionCount: Object.keys(bundle.sessionsLedger.sessions).length,
    pricingSnapshots: bundle.pricingLedger?.history?.length || 0,
    exportedAt: bundle.exportedAt,
  };
}

export function importBackupFromFile(
  filePath: string,
  options: { mode?: BackupImportMode } = {}
): BackupImportResult {
  const resolved = path.resolve(filePath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Backup file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Expected a backup file, but got a directory: ${resolved}`);
  }
  if (stat.size > 100 * 1024 * 1024) {
    throw new Error('Backup file exceeds 100 MB safety limit.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch {
    throw new Error(`Failed to parse JSON in backup file: ${resolved}`);
  }

  return importBackupBundle(parsed, options);
}
