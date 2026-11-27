import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'burnrate-engine-test-'));
const geminiDir = path.join(tmpRoot, 'gemini');
const claudeDir = path.join(tmpRoot, 'claude');
const codexDir = path.join(tmpRoot, 'codex');
const hooksHome = path.join(tmpRoot, 'hooks-home');
const quotaPath = path.join(tmpRoot, 'quota-state.json');
const settingsPath = path.join(tmpRoot, 'settings.json');
const fixturePath = path.join(tmpRoot, 'agy-usage.json');

fs.mkdirSync(geminiDir, { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(path.join(codexDir, 'sessions', '2026', '11', '27'), { recursive: true });
fs.mkdirSync(path.join(hooksHome, '.claude'), { recursive: true });
fs.mkdirSync(path.join(hooksHome, '.gemini', 'config'), { recursive: true });
fs.mkdirSync(path.join(hooksHome, '.codex'), { recursive: true });

process.env.BURNRATE_GEMINI_DIR = geminiDir;
process.env.BURNRATE_CLAUDE_DIR = claudeDir;
process.env.BURNRATE_CODEX_DIR = codexDir;
process.env.BURNRATE_QUOTA_PATH = quotaPath;
process.env.BURNRATE_SETTINGS_PATH = settingsPath;
process.env.BURNRATE_AGY_USAGE_FIXTURE = fixturePath;

const importCore = (rel) =>
  import(pathToFileURL(path.resolve(process.cwd(), 'dist', 'core', rel)).href);

const { QuotaEngine } = await importCore('quota/engine.js');
const { loadQuotaStore, sanitizeQuotaStore, sanitizeRawPayload } = await importCore('quota/store.js');
const { installAutoArchiveHooks, uninstallAutoArchiveHooks, getClaudeStatuslineCommand } =
  await importCore('hooks.js');
const { saveUserSettings, loadUserSettings } = await importCore('settings.js');

test.after(() => {
  delete process.env.BURNRATE_GEMINI_DIR;
  delete process.env.BURNRATE_CLAUDE_DIR;
  delete process.env.BURNRATE_CODEX_DIR;
  delete process.env.BURNRATE_QUOTA_PATH;
  delete process.env.BURNRATE_SETTINGS_PATH;
  delete process.env.BURNRATE_AGY_USAGE_FIXTURE;
  delete process.env.BURNRATE_HOOKS_HOME;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('QuotaEngine deduplicates concurrent refreshes, redacts secrets, migrates v3 store, and gates experimental hooks cleanly', async () => {
  // 1. Secret redaction in diagnostics
  const dirty = {
    access_token: 'secret-value-1',
    nested: { authorization: 'Bearer ya29.abc123456', email: 'user@example.com' },
    groups: [{ name: 'Gemini Models', remaining_fraction: 0.9 }],
  };
  const clean = sanitizeRawPayload(dirty);
  assert.equal(clean.access_token, '[REDACTED]');
  assert.equal(clean.nested.authorization, '[REDACTED]');
  assert.equal(clean.nested.email, '[REDACTED]');

  // 2. Legacy v3 schema strips old heuristic calibrations cleanly while keeping v4 clean
  const migrated = sanitizeQuotaStore({
    schemaVersion: 3,
    calibrations: { antigravity: { learnedFiveHourCapUSD: 25 } },
    telemetry: {
      claude: {
        capturedAt: new Date().toISOString(),
        fiveHour: { usedPct: 30, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), windowMinutes: 300 },
      },
    },
  });
  assert.equal(migrated.schemaVersion, 4);
  assert.equal('calibrations' in migrated, false);
  assert.equal(migrated.providers.claude?.windows[0]?.remainingPercent, 70);

  // 3. Antigravity fixture + single-flight deduplication
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini 4 Neon',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.75,
                  reset_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
                },
              ],
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  const engine = new QuotaEngine({ antigravityTtlMs: 60_000 });
  const [r1, r2] = await Promise.all([
    engine.refreshProvider('antigravity', { force: true }),
    engine.refreshProvider('antigravity', { force: true }),
  ]);
  assert.equal(r1.fetchedAtMs, r2.fetchedAtMs);
  assert.equal(r1.windows[0].remainingPercent, 75);
  assert.equal(loadQuotaStore().providers.antigravity?.windows[0]?.remainingPercent, 75);

  const diagnostics = await engine.collectDiagnostics({ force: false });
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].provider, 'antigravity');
  assert.equal(diagnostics[0].computedWindows[0].remainingPercent, 75);

  // 4. Experimental quota toggle cleanly adds/removes Claude statusLine hook without touching Stop hooks
  process.env.BURNRATE_HOOKS_HOME = hooksHome;
  fs.writeFileSync(
    path.join(hooksHome, '.claude', 'settings.json'),
    JSON.stringify({ theme: 'dark' }),
    'utf-8'
  );
  saveUserSettings({ experimentalQuota: true });
  assert.equal(loadUserSettings().experimentalQuota, true);
  assert.equal(installAutoArchiveHooks().claude, true);
  let claudeCfg = JSON.parse(fs.readFileSync(path.join(hooksHome, '.claude', 'settings.json'), 'utf-8'));
  assert.equal(claudeCfg.statusLine?.command, getClaudeStatuslineCommand());
  assert.ok(Array.isArray(claudeCfg.hooks?.Stop));

  saveUserSettings({ experimentalQuota: false });
  installAutoArchiveHooks();
  claudeCfg = JSON.parse(fs.readFileSync(path.join(hooksHome, '.claude', 'settings.json'), 'utf-8'));
  assert.equal(claudeCfg.statusLine, undefined);
  assert.ok(Array.isArray(claudeCfg.hooks?.Stop));

  uninstallAutoArchiveHooks();
});
