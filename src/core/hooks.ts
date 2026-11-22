import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPackageRoot } from './pricing.js';
import type { HooksStatus } from './types.js';

const AGY_HOOK_NAME = 'ai-burnrate-ledger';
const BURNRATE_HOOK_MARKER = '--sync-ledger';

function resolveHooksHomeDir(): string | null {
  if (process.env.BURNRATE_DISABLE_HOOKS === '1' || process.env.BURNRATE_DISABLE_HOOKS === 'true') {
    return null;
  }
  if (process.env.BURNRATE_HOOKS_HOME) {
    return path.resolve(process.env.BURNRATE_HOOKS_HOME);
  }
  // Never mutate real user home tool configs during isolated test sandboxes
  if (process.env.BURNRATE_GEMINI_DIR || process.env.BURNRATE_CLAUDE_DIR || process.env.BURNRATE_CODEX_DIR) {
    return null;
  }
  return os.homedir();
}

export function getSyncLedgerCommand(): string {
  const cliEntry = path.join(getPackageRoot(), 'dist', 'cli', 'index.js').replace(/\\/g, '/');
  return `node "${cliEntry}" --sync-ledger`;
}

function writeJsonAtomic(filePath: string, data: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, serialized, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, serialized, 'utf-8');
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isBurnrateHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes(BURNRATE_HOOK_MARKER) && cmd.toLowerCase().includes('burnrate');
}

function installAntigravityHook(homeDir: string, command: string): boolean {
  const geminiDir = path.join(homeDir, '.gemini');
  if (!fs.existsSync(geminiDir)) return false;

  const hooksPath = path.join(geminiDir, 'config', 'hooks.json');
  let hooksObj: Record<string, any> = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hooksObj = parsed;
      }
    } catch {
      return false;
    }
  }

  const desiredSpec = {
    enabled: true,
    Stop: [
      {
        type: 'command',
        command,
        timeout: 5,
      },
    ],
  };

  const existing = hooksObj[AGY_HOOK_NAME];
  if (existing && JSON.stringify(existing) === JSON.stringify(desiredSpec)) {
    return true;
  }

  hooksObj[AGY_HOOK_NAME] = desiredSpec;
  return writeJsonAtomic(hooksPath, hooksObj);
}

function installClaudeHook(homeDir: string, command: string): boolean {
  const claudeDir = path.join(homeDir, '.claude');
  if (!fs.existsSync(claudeDir)) return false;

  const settingsPath = path.join(claudeDir, 'settings.json');
  let settingsObj: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settingsObj = parsed;
      }
    } catch {
      return false;
    }
  }

  const hooksSection =
    settingsObj.hooks && typeof settingsObj.hooks === 'object' && !Array.isArray(settingsObj.hooks)
      ? { ...settingsObj.hooks }
      : {};

  let changed = false;
  const targetEvents = ['Stop', 'SessionEnd'] as const;

  for (const eventName of targetEvents) {
    const existingList = Array.isArray(hooksSection[eventName]) ? [...hooksSection[eventName]] : [];
    const filtered = existingList.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      if (isBurnrateHookCommand(entry.command)) return false;
      if (Array.isArray(entry.hooks) && entry.hooks.some((h: any) => isBurnrateHookCommand(h?.command))) {
        return false;
      }
      return true;
    });

    const desiredEntry = {
      hooks: [
        {
          type: 'command',
          command,
          timeout: 5,
        },
      ],
    };

    const nextList = [...filtered, desiredEntry];
    if (JSON.stringify(existingList) !== JSON.stringify(nextList)) {
      hooksSection[eventName] = nextList;
      changed = true;
    }
  }

  if (!changed) return true;
  settingsObj.hooks = hooksSection;
  return writeJsonAtomic(settingsPath, settingsObj);
}

export function installAutoArchiveHooks(): HooksStatus {
  const homeDir = resolveHooksHomeDir();
  if (!homeDir) return { antigravity: false, claude: false };

  const command = getSyncLedgerCommand();
  return {
    antigravity: installAntigravityHook(homeDir, command),
    claude: installClaudeHook(homeDir, command),
  };
}

export function uninstallAutoArchiveHooks(): void {
  const homeDir = resolveHooksHomeDir();
  if (!homeDir) return;

  // 1. Clean Antigravity hooks.json
  const agyHooksPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  if (fs.existsSync(agyHooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agyHooksPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && AGY_HOOK_NAME in parsed) {
        delete parsed[AGY_HOOK_NAME];
        writeJsonAtomic(agyHooksPath, parsed);
      }
    } catch {
      // ignore
    }
  }

  // 2. Clean Claude settings.json
  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.hooks && typeof parsed.hooks === 'object') {
        let changed = false;
        for (const eventName of ['Stop', 'SessionEnd']) {
          const list = parsed.hooks[eventName];
          if (!Array.isArray(list)) continue;
          const cleaned = list.filter((entry: any) => {
            if (!entry || typeof entry !== 'object') return true;
            if (isBurnrateHookCommand(entry.command)) return false;
            if (Array.isArray(entry.hooks) && entry.hooks.some((h: any) => isBurnrateHookCommand(h?.command))) {
              return false;
            }
            return true;
          });
          if (cleaned.length !== list.length) {
            changed = true;
            if (cleaned.length > 0) {
              parsed.hooks[eventName] = cleaned;
            } else {
              delete parsed.hooks[eventName];
            }
          }
        }
        if (Object.keys(parsed.hooks).length === 0) {
          delete parsed.hooks;
        }
        if (changed) {
          writeJsonAtomic(claudeSettingsPath, parsed);
        }
      }
    } catch {
      // ignore
    }
  }
}

export function getHooksStatus(): HooksStatus {
  const homeDir = resolveHooksHomeDir();
  if (!homeDir) return { antigravity: false, claude: false };

  let antigravity = false;
  const agyHooksPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  if (fs.existsSync(agyHooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agyHooksPath, 'utf-8'));
      const spec = parsed?.[AGY_HOOK_NAME];
      antigravity = Boolean(
        spec &&
          spec.enabled !== false &&
          Array.isArray(spec.Stop) &&
          spec.Stop.some((h: any) => isBurnrateHookCommand(h?.command))
      );
    } catch {
      antigravity = false;
    }
  }

  let claude = false;
  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      const stopList = parsed?.hooks?.Stop;
      claude = Boolean(
        Array.isArray(stopList) &&
          stopList.some(
            (entry: any) =>
              isBurnrateHookCommand(entry?.command) ||
              (Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => isBurnrateHookCommand(h?.command)))
          )
      );
    } catch {
      claude = false;
    }
  }

  return { antigravity, claude };
}
