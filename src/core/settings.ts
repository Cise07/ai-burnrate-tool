import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DashboardSectionId, UserSettings } from './types.js';

export const DEFAULT_SECTION_ORDER: DashboardSectionId[] = [
  'kpis',
  'charts',
  'modelUsage',
  'heatmapWorkspaces',
  'sessions',
];

const VALID_SECTION_IDS = new Set<string>(DEFAULT_SECTION_ORDER);

export const DEFAULT_USER_SETTINGS: UserSettings = {
  subscriptions: {
    antigravity: 19.99,
    claude: 20,
    codex: 0,
  },
  includeDeletedInTotals: true,
  layout: {
    order: [...DEFAULT_SECTION_ORDER],
    hidden: [],
  },
  trackingStartAt: {
    antigravity: null,
    claude: null,
    codex: null,
  },
};

let memorySettings: UserSettings | null = null;

function isPersistentSettingsEnabled(): boolean {
  if (process.env.BURNRATE_SETTINGS_PATH) return true;
  if (process.env.BURNRATE_GEMINI_DIR || process.env.BURNRATE_CLAUDE_DIR || process.env.BURNRATE_CODEX_DIR) {
    return false;
  }
  return true;
}

export function getSettingsPath(): string {
  if (process.env.BURNRATE_SETTINGS_PATH) {
    return path.resolve(process.env.BURNRATE_SETTINGS_PATH);
  }
  return path.join(os.homedir(), '.burnrate', 'settings.json');
}

function clampNonNegative(val: unknown, fallback: number, max = 100_000): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(0, Number(val.toFixed(4))));
}

function sanitizeLayout(rawLayout: unknown, baseLayout: UserSettings['layout']): UserSettings['layout'] {
  const layoutObj =
    rawLayout && typeof rawLayout === 'object' ? (rawLayout as Record<string, unknown>) : null;

  let order: DashboardSectionId[];
  if (layoutObj && Array.isArray(layoutObj.order)) {
    const seen = new Set<DashboardSectionId>();
    order = [];
    for (const item of layoutObj.order) {
      if (typeof item === 'string' && VALID_SECTION_IDS.has(item)) {
        const id = item as DashboardSectionId;
        if (!seen.has(id)) {
          seen.add(id);
          order.push(id);
        }
      }
    }
    for (const id of DEFAULT_SECTION_ORDER) {
      if (!seen.has(id)) order.push(id);
    }
  } else {
    order = [...baseLayout.order];
  }

  let hidden: DashboardSectionId[];
  if (layoutObj && Array.isArray(layoutObj.hidden)) {
    const seen = new Set<DashboardSectionId>();
    hidden = [];
    for (const item of layoutObj.hidden) {
      if (typeof item === 'string' && VALID_SECTION_IDS.has(item)) {
        const id = item as DashboardSectionId;
        if (!seen.has(id)) {
          seen.add(id);
          hidden.push(id);
        }
      }
    }
  } else {
    hidden = [...baseLayout.hidden];
  }

  return { order, hidden };
}

export function parseUserDateInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    const localDate = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (
      localDate.getFullYear() !== year ||
      localDate.getMonth() !== month - 1 ||
      localDate.getDate() !== day
    ) {
      return null;
    }
    return localDate.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sanitizeTrackingTimestamp(val: unknown, fallback: string | null): string | null {
  if (val === null || val === '') return null;
  if (typeof val === 'string') {
    const parsed = parseUserDateInput(val);
    if (parsed) return parsed;
  }
  return fallback;
}

export function sanitizeUserSettings(raw: unknown, base: UserSettings = DEFAULT_USER_SETTINGS): UserSettings {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const subs = obj.subscriptions && typeof obj.subscriptions === 'object' ? obj.subscriptions : {};
  const rawTracking =
    obj.trackingStartAt && typeof obj.trackingStartAt === 'object'
      ? (obj.trackingStartAt as Record<string, unknown>)
      : null;
  const baseTracking = base.trackingStartAt ?? DEFAULT_USER_SETTINGS.trackingStartAt;

  return {
    subscriptions: {
      antigravity: clampNonNegative(subs.antigravity, base.subscriptions.antigravity),
      claude: clampNonNegative(subs.claude, base.subscriptions.claude),
      codex: clampNonNegative(subs.codex, base.subscriptions.codex),
    },
    includeDeletedInTotals:
      typeof obj.includeDeletedInTotals === 'boolean'
        ? obj.includeDeletedInTotals
        : base.includeDeletedInTotals,
    layout: sanitizeLayout(obj.layout, base.layout),
    trackingStartAt: {
      antigravity:
        rawTracking && 'antigravity' in rawTracking
          ? sanitizeTrackingTimestamp(rawTracking.antigravity, baseTracking.antigravity)
          : baseTracking.antigravity,
      claude:
        rawTracking && 'claude' in rawTracking
          ? sanitizeTrackingTimestamp(rawTracking.claude, baseTracking.claude)
          : baseTracking.claude,
      codex:
        rawTracking && 'codex' in rawTracking
          ? sanitizeTrackingTimestamp(rawTracking.codex, baseTracking.codex)
          : baseTracking.codex,
    },
  };
}

export function loadUserSettings(): UserSettings {
  if (!isPersistentSettingsEnabled()) {
    return structuredClone(memorySettings ?? DEFAULT_USER_SETTINGS);
  }

  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return structuredClone(DEFAULT_USER_SETTINGS);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return sanitizeUserSettings(raw, DEFAULT_USER_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_USER_SETTINGS);
  }
}

export function saveUserSettings(patch: unknown): UserSettings {
  const current = loadUserSettings();
  const next = sanitizeUserSettings(patch, current);

  if (!isPersistentSettingsEnabled()) {
    memorySettings = structuredClone(next);
    return next;
  }

  try {
    const settingsPath = getSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(next, null, 2);
    const tmpPath = `${settingsPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, settingsPath);
    } catch {
      fs.writeFileSync(settingsPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore read-only FS errors
  }

  return next;
}

export function resetMemoryUserSettings(): void {
  memorySettings = null;
}
