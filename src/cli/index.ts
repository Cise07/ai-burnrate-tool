#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import pc from 'picocolors';
import QRCode from 'qrcode';
import { filterSessions, type TimeRange, type ToolFilter } from '../core/analytics.js';
import { exportBackupToFile, importBackupFromFile } from '../core/backup.js';
import { resolveNpmUpdateSpec, runGlobalNpmCommand } from '../core/cli-security.js';
import { installAutoArchiveHooks, uninstallAutoArchiveHooks } from '../core/hooks.js';
import { scanAllLogs, syncSingleTranscriptToLedger } from '../core/parser.js';
import {
  getPackageRoot,
  PRICING_SYNC_TTL_MS,
  releasePricingSyncLock,
  syncOfficialPricing,
  tryClaimBackgroundPricingSync,
} from '../core/pricing.js';
import {
  defaultQuotaEngine,
  evaluateCountdown,
  formatDisplayPercent,
  parseAntigravityStatuslinePayload,
  parseClaudeStatuslinePayload,
  sanitizeRawPayload,
  saveProviderQuotaSnapshot,
} from '../core/quota/index.js';
import { loadUserSettings, parseUserDateInput, saveUserSettings } from '../core/settings.js';
import type { ToolSource } from '../core/types.js';
import { startLogWatcher } from '../core/watcher.js';
import { startServer, type LaunchDefaults } from '../server/index.js';
import { printCliReport } from './reporter.js';

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function openBrowserSilently(url: string): Promise<void> {
  if (
    process.platform === 'win32' &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(url)
  ) {
    return new Promise((resolve, reject) => {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => {
        open(url).then(() => resolve(), reject);
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
  return open(url).then(() => undefined);
}

function renderTerminalQr(url: string, indent = '  '): string[] {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const isDark = (r: number, c: number): boolean =>
    r >= 0 && r < size && c >= 0 && c < size ? Boolean(data[r * size + c]) : false;

  const lines: string[] = [];
  for (let r = -2; r < size + 2; r += 2) {
    let row = '';
    for (let c = -2; c < size + 2; c++) {
      const top = isDark(r, c);
      const bottom = isDark(r + 1, c);
      if (top && bottom) row += '\u2588';
      else if (top && !bottom) row += '\u2580';
      else if (!top && bottom) row += '\u2584';
      else row += ' ';
    }
    lines.push(`${indent}${pc.bgWhite(pc.black(row))}`);
  }
  return lines;
}

const program = new Command();

program
  .name('burn')
  .description('Real-time local token & API equivalent cost tracker for Antigravity, Claude Code and Codex CLI')
  .version(getPackageVersion())
  .option('--cli', 'Print the usage report in ANSI tables in the terminal and exit immediately', false)
  .option('--eur', 'Display costs in EUR (€) instead of USD ($) in Web UI and --cli mode', false)
  .option('--tool <tool>', 'Filter Web UI and --cli report by tool (all, antigravity, claude, codex)', 'all')
  .option('--range <range>', 'Filter Web UI and --cli report by time range (24h, 7d, 30d, all)', 'all')
  .option('--json', 'Print --cli report as JSON instead of ANSI tables', false)
  .option('--no-open', 'Start the live server and file watcher without automatically opening the browser')
  .option('--no-lan', 'Bind dashboard server strictly to 127.0.0.1 and disable mDNS/QR LAN exposure')
  .option('--no-hooks', 'Skip automatic installation of Antigravity/Claude/Codex offline archive hooks')
  .option('--sync-ledger', 'Fast hook mode: snapshot current session to ledger and exit silently', false)
  .option(
    '--claude-statusline',
    'Optional Claude Code statusLine helper: cache exact rate_limits JSON from stdin and print compact quota summary',
    false
  )
  .option(
    '--antigravity-statusline',
    'Optional Antigravity CLI statusLine helper: cache live quota JSON from stdin and print compact summary',
    false
  )
  .option('--quota-debug', 'Print sanitized raw payloads, UTC resetAtMs, local times & countdown diagnostics', false)
  .option('--sync-pricing', 'Background mode: refresh official pricing ledger using ETag and exit silently', false)
  .option('--uninstall-hooks', 'Remove ai-burnrate-tool offline archive hooks from Antigravity/Claude/Codex configs', false)
  .option(
    '--reset-tool <tool>',
    'Start counting spend & stats from now (or --since <date>) for a tool (antigravity, claude, codex, all) without touching tool files'
  )
  .option(
    '--since <date>',
    'Optional start date/timestamp (YYYY-MM-DD or ISO-8601) used with --reset-tool or --restore-tool'
  )
  .option(
    '--restore-tool <tool>',
    'Restore spend history from the beginning (or from --since <date>) for a tool (antigravity, claude, codex, all)'
  )
  .option(
    '--export-backup [file]',
    'Export a portable JSON backup of ~/.burnrate (sessions ledger, pricing history & settings)'
  )
  .option(
    '--import-backup <file>',
    'Import a portable Burnrate backup JSON file (merges safely by default; add --replace to overwrite)'
  )
  .option('--replace', 'Used with --import-backup to replace local ~/.burnrate data instead of merging', false)
  .option('-p, --port <number>', 'Specify a custom port for the dashboard server', '4321')
  .option('--update', 'Update ai-burnrate-tool to the latest version from npm', false)
  .option('--uninstall', 'Uninstall ai-burnrate-tool globally from your system', false);

program.parse(process.argv);

const opts = program.opts<{
  cli?: boolean;
  eur?: boolean;
  tool?: string;
  range?: string;
  json?: boolean;
  open?: boolean;
  lan?: boolean;
  hooks?: boolean;
  syncLedger?: boolean;
  claudeStatusline?: boolean;
  antigravityStatusline?: boolean;
  quotaDebug?: boolean;
  syncPricing?: boolean;
  uninstallHooks?: boolean;
  resetTool?: string;
  since?: string;
  restoreTool?: string;
  exportBackup?: string | boolean;
  importBackup?: string;
  replace?: boolean;
  port?: string;
  update?: boolean;
  uninstall?: boolean;
}>();

const VALID_TOOLS: ReadonlySet<string> = new Set(['all', 'antigravity', 'claude', 'codex']);
const VALID_RANGES: ReadonlySet<string> = new Set(['24h', '7d', '30d', 'all']);

async function readStdinJsonWithTimeout(timeoutMs = 150): Promise<Record<string, any> | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (raw: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      const trimmed = raw.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf-8')), timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 256 * 1024) {
        finish(Buffer.concat(chunks).toString('utf-8'));
      }
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => finish(''));
    process.stdin.resume();
  });
}

async function main() {
  if (opts.syncPricing) {
    try {
      await syncOfficialPricing();
    } catch {
      // Never surface background sync errors
    } finally {
      releasePricingSyncLock();
    }
    process.exit(0);
  }

  if (opts.syncLedger) {
    try {
      const hookPayload = await readStdinJsonWithTimeout(150);
      syncSingleTranscriptToLedger(hookPayload);
      if (tryClaimBackgroundPricingSync()) {
        try {
          const cliEntry = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
          const child = spawn(process.execPath, [cliEntry, '--sync-pricing'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        } catch {
          releasePricingSyncLock();
        }
      }
      if (hookPayload) {
        process.stdout.write('{}\n');
      }
    } catch {
      if (!process.stdin.isTTY) {
        process.stdout.write('{}\n');
      }
    }
    process.exit(0);
  }

  if (opts.claudeStatusline) {
    try {
      const payload = await readStdinJsonWithTimeout(150);
      if (payload) {
        const nowMs = Date.now();
        const parsed = parseClaudeStatuslinePayload(payload, {
          capturedAtMs: nowMs,
          serverNowMs: nowMs,
        });
        const parts: string[] = [];

        const modelObj = (payload as any).model;
        const modelName =
          (typeof modelObj?.display_name === 'string' && modelObj.display_name.trim()) ||
          (typeof modelObj?.id === 'string' && modelObj.id.trim()) ||
          undefined;
        if (modelName) parts.push(modelName);

        const ctxPct = Number((payload as any).context_window?.used_percentage);
        if (Number.isFinite(ctxPct) && ctxPct >= 0) {
          parts.push(`ctx ${Math.round(ctxPct)}%`);
        }

        if (parsed) {
          saveProviderQuotaSnapshot(parsed, sanitizeRawPayload(payload));
          const skew = parsed.clockSkewMs ?? 0;
          const fiveW = parsed.windows.find((w) => w.id === 'claude:5h');
          const sevenW = parsed.windows.find((w) => w.id === 'claude:7d');
          for (const [shortLabel, w] of [
            ['5h', fiveW],
            ['7d', sevenW],
          ] as const) {
            if (!w || w.remainingPercent === null) continue;
            const cd = evaluateCountdown(w.resetAtMs, nowMs, skew);
            const cdSuffix = cd.state === 'idle' ? '' : ` (${cd.formatted})`;
            parts.push(`${shortLabel} ${formatDisplayPercent(w.remainingPercent)}${cdSuffix}`);
          }
        }

        if (parts.length > 0) {
          process.stdout.write(parts.join(' · '));
        }
      }
    } catch {
      // Never block or break Claude Code statusLine rendering
    }
    process.exit(0);
  }

  if (opts.antigravityStatusline) {
    try {
      const payload = await readStdinJsonWithTimeout(150);
      if (payload) {
        const nowMs = Date.now();
        const parsed = parseAntigravityStatuslinePayload(payload, {
          fetchedAtMs: nowMs,
          serverNowMs: nowMs,
        });
        const parts: string[] = [];

        const modelObj = (payload as any).model;
        const modelName =
          (typeof modelObj?.display_name === 'string' && modelObj.display_name.trim()) ||
          (typeof modelObj?.id === 'string' && modelObj.id.trim()) ||
          undefined;
        if (modelName) parts.push(modelName);

        if (parsed) {
          saveProviderQuotaSnapshot(parsed, sanitizeRawPayload(payload));
          for (const w of parsed.windows) {
            if (w.remainingPercent === null) continue;
            const cd = evaluateCountdown(w.resetAtMs, nowMs);
            const cdSuffix = cd.state === 'idle' ? '' : ` (${cd.formatted})`;
            parts.push(`${w.id.replace('antigravity:', '')} ${formatDisplayPercent(w.remainingPercent)}${cdSuffix}`);
          }
        }

        if (parts.length > 0) {
          process.stdout.write(parts.join(' · '));
        }
      }
    } catch {
      // Never block Antigravity statusLine rendering
    }
    process.exit(0);
  }

  if (opts.uninstallHooks) {
    uninstallAutoArchiveHooks();
    console.log(`\n  ${pc.green('✓')} Removed ai-burnrate-tool offline archive hooks from Antigravity, Claude Code & Codex CLI.\n`);
    process.exit(0);
  }

  if (opts.exportBackup && opts.importBackup) {
    console.error(pc.red('Cannot combine --export-backup and --import-backup in the same command.'));
    process.exit(1);
  }

  if (opts.replace && !opts.importBackup) {
    console.error(pc.red('Option --replace requires --import-backup <file>.'));
    process.exit(1);
  }

  if (opts.exportBackup) {
    try {
      // Reconcile current live transcripts into the ledger first so the backup is complete
      scanAllLogs(false);
      const targetArg = typeof opts.exportBackup === 'string' ? opts.exportBackup : undefined;
      const exported = exportBackupToFile(targetArg);
      const sizeKb = (exported.sizeBytes / 1024).toFixed(1);
      console.log(
        `\n  ${pc.green('✓')} Exported portable backup to ${pc.cyan(exported.filePath)} ${pc.dim(`(${sizeKb} KB)`)}`
      );
      console.log(
        `  ${pc.dim(`Included: ${exported.sessionCount} archived sessions • ${exported.pricingSnapshots} pricing snapshots • user settings`)}\n`
      );
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${pc.red('✗')} Backup export failed: ${message}`);
      process.exit(1);
    }
  }

  if (opts.importBackup) {
    try {
      const mode = opts.replace ? 'replace' : 'merge';
      const result = importBackupFromFile(opts.importBackup, { mode });
      // Immediately reconcile live local transcripts so active chats on this PC stay active
      scanAllLogs(true);
      console.log(
        `\n  ${pc.green('✓')} Imported Burnrate backup (${pc.bold(result.mode)} mode) from ${pc.cyan(path.resolve(opts.importBackup))}.`
      );
      console.log(
        `  ${pc.dim(`Sessions added: ${result.importedSessions} • merged: ${result.mergedSessions} • pricing snapshots added: ${result.pricingSnapshotsAdded} • settings restored: ${result.settingsRestored ? 'yes' : 'no'}`)}\n`
      );
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${pc.red('✗')} Backup import failed: ${message}`);
      process.exit(1);
    }
  }

  if (opts.resetTool && opts.restoreTool) {
    console.error(pc.red('Cannot combine --reset-tool and --restore-tool in the same command.'));
    process.exit(1);
  }

  if (opts.since && !opts.resetTool && !opts.restoreTool) {
    console.error(
      pc.red('Option --since requires --reset-tool or --restore-tool <antigravity|claude|codex|all>.')
    );
    process.exit(1);
  }

  const resolveToolTargets = (rawTool: string, flagName: string): ToolSource[] => {
    const lower = rawTool.trim().toLowerCase();
    if (!VALID_TOOLS.has(lower)) {
      console.error(pc.red(`Invalid ${flagName} "${rawTool}". Expected: all, antigravity, claude, or codex.`));
      process.exit(1);
    }
    return lower === 'all' ? ['antigravity', 'claude', 'codex'] : [lower as ToolSource];
  };

  if (opts.resetTool) {
    const targets = resolveToolTargets(opts.resetTool, '--reset-tool');
    let cutoffIso: string;
    if (opts.since) {
      const parsed = parseUserDateInput(opts.since);
      if (!parsed) {
        console.error(
          pc.red(`Invalid --since "${opts.since}". Expected YYYY-MM-DD or an ISO-8601 timestamp (e.g. 2026-11-23T10:30:00).`)
        );
        process.exit(1);
      }
      cutoffIso = parsed;
    } else {
      cutoffIso = new Date().toISOString();
    }
    const patch: Partial<Record<ToolSource, string | null>> = {};
    for (const t of targets) patch[t] = cutoffIso;
    saveUserSettings({ trackingStartAt: patch });
    const displayDate = new Date(cutoffIso).toLocaleString();
    console.log(
      `\n  ${pc.green('✓')} Tracking reset active for ${pc.bold(targets.join(', '))} from ${pc.cyan(displayDate)} ${pc.dim(`(${cutoffIso})`)}.`
    );
    console.log(
      `  ${pc.dim(`Turns before this timestamp are excluded from KPIs, charts & deleted totals. Tool files are untouched; restore anytime with: burn --restore-tool ${opts.resetTool.trim().toLowerCase()} [--since YYYY-MM-DD]`)}\n`
    );
    process.exit(0);
  }

  if (opts.restoreTool) {
    const targets = resolveToolTargets(opts.restoreTool, '--restore-tool');
    const patch: Partial<Record<ToolSource, string | null>> = {};
    if (opts.since) {
      const parsed = parseUserDateInput(opts.since);
      if (!parsed) {
        console.error(
          pc.red(`Invalid --since "${opts.since}". Expected YYYY-MM-DD or an ISO-8601 timestamp (e.g. 2026-11-20T09:00:00).`)
        );
        process.exit(1);
      }
      for (const t of targets) patch[t] = parsed;
      saveUserSettings({ trackingStartAt: patch });
      const displayDate = new Date(parsed).toLocaleString();
      console.log(
        `\n  ${pc.green('✓')} Restored tracking history for ${pc.bold(targets.join(', '))} starting from ${pc.cyan(displayDate)} ${pc.dim(`(${parsed})`)}.\n`
      );
      process.exit(0);
    }
    for (const t of targets) patch[t] = null;
    saveUserSettings({ trackingStartAt: patch });
    console.log(
      `\n  ${pc.green('✓')} Restored full tracking history for ${pc.bold(targets.join(', '))} (from the beginning).\n`
    );
    process.exit(0);
  }

  if (opts.update) {
    let targetSpec: string;
    try {
      targetSpec = resolveNpmUpdateSpec(process.env.BURNRATE_VERSION);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid BURNRATE_VERSION';
      console.error(`  ${pc.red('✗')} ${msg}\n`);
      process.exit(1);
    }
    console.log(`\n  ${pc.cyan('●')} Updating ${pc.bold(targetSpec)} from npm...`);
    try {
      runGlobalNpmCommand(['install', '-g', targetSpec], {
        BURNRATE_POSTINSTALL_FORCE: '1',
      });
      console.log(`  ${pc.green('✓')} ${pc.bold(targetSpec)} updated successfully!\n`);
      process.exit(0);
    } catch {
      console.error(
        `  ${pc.red('✗')} Failed to update automatically. Try running:\n  ${pc.cyan(`npm install -g ${targetSpec}`)}\n`
      );
      process.exit(1);
    }
  }

  if (opts.uninstall) {
    console.log(`\n  ${pc.yellow('●')} Uninstalling ${pc.bold('ai-burnrate-tool')} globally...`);
    uninstallAutoArchiveHooks();
    try {
      runGlobalNpmCommand(['uninstall', '-g', 'ai-burnrate-tool']);
      console.log(`  ${pc.green('✓')} ${pc.bold('ai-burnrate-tool')} has been completely removed from your system.\n`);
      process.exit(0);
    } catch {
      console.error(`  ${pc.red('✗')} Failed to uninstall automatically. Run: ${pc.cyan('npm uninstall -g ai-burnrate-tool')}`);
      process.exit(1);
    }
  }

  const toolFilter = String(opts.tool || 'all').toLowerCase();
  const timeRange = String(opts.range || 'all').toLowerCase();

  if (!VALID_TOOLS.has(toolFilter)) {
    console.error(pc.red(`Invalid --tool "${opts.tool}". Expected: all, antigravity, claude, or codex.`));
    process.exit(1);
  }
  if (!VALID_RANGES.has(timeRange)) {
    console.error(pc.red(`Invalid --range "${opts.range}". Expected: 24h, 7d, 30d, or all.`));
    process.exit(1);
  }

  if (opts.quotaDebug || process.env.BURNRATE_QUOTA_DEBUG === '1') {
    const entries = await defaultQuotaEngine.collectDiagnostics({ force: true });
    if (opts.json) {
      console.log(JSON.stringify({ serverNowMs: Date.now(), entries }, null, 2));
      process.exit(0);
    }
    console.log(`\n  ${pc.bold(pc.white('QUOTA DIAGNOSTICS [EXPERIMENTAL]'))}`);
    console.log(`  ${pc.dim('─'.repeat(96))}`);
    for (const entry of entries) {
      console.log(
        `\n  ${pc.bold(pc.cyan(entry.provider.toUpperCase()))}  status=${pc.bold(entry.snapshot.status)}  source=${pc.dim(entry.source)}  fetchedAtMs=${entry.snapshot.fetchedAtMs}`
      );
      if (entry.snapshot.error) {
        console.log(`    ${pc.yellow('error')}: [${entry.snapshot.error.code}] ${entry.snapshot.error.message}`);
      }
      for (const w of entry.computedWindows) {
        console.log(
          `    • ${w.id} (${w.label}) | rem=${formatDisplayPercent(w.remainingPercent)} (exact=${w.remainingPercent}) | acc=${w.accuracy} | resetAtMs=${w.resetAtMs} | local=${w.resetAtIsoLocal || 'Ready'} | countdown=${pc.green(w.countdown)}`
        );
      }
      console.log(`    ${pc.dim('rawPayload (sanitized)')}: ${JSON.stringify(entry.rawPayloadSanitized)}`);
    }
    console.log('');
    process.exit(0);
  }

  if (opts.hooks !== false) {
    installAutoArchiveHooks();
  }

  if (opts.cli) {
    const quotaEnabled = loadUserSettings().experimentalQuota !== false;
    const [, pricingOutcome] = await Promise.allSettled([
      quotaEnabled
        ? defaultQuotaEngine.refreshAll({ force: false, reason: 'cli' })
        : Promise.resolve(null),
      syncOfficialPricing(),
    ]);
    if (
      pricingOutcome.status === 'fulfilled' &&
      pricingOutcome.value.updated &&
      pricingOutcome.value.effectiveFrom &&
      !opts.json
    ) {
      console.log(
        `  ${pc.cyan('↻')} Official pricing updated (new tariff active for turns from ${pc.bold(pricingOutcome.value.effectiveFrom)}; past turns preserved).`
      );
    }
    const cliSnapshot = scanAllLogs(true);
    printCliReport(cliSnapshot, {
      currency: opts.eur ? 'EUR' : 'USD',
      toolFilter: toolFilter as ToolFilter,
      timeRange: timeRange as TimeRange,
      json: Boolean(opts.json),
    });
    process.exit(0);
  }

  const snapshot = scanAllLogs(true);

  const preferredPort = Number.parseInt(String(opts.port || '4321'), 10) || 4321;
  const launchDefaults: LaunchDefaults = {};
  const urlParams = new URLSearchParams();

  if (program.getOptionValueSource('eur') === 'cli') {
    launchDefaults.currency = opts.eur ? 'EUR' : 'USD';
    urlParams.set('currency', launchDefaults.currency);
  }
  if (program.getOptionValueSource('tool') === 'cli') {
    launchDefaults.toolFilter = toolFilter as ToolFilter;
    urlParams.set('tool', launchDefaults.toolFilter);
  }
  if (program.getOptionValueSource('range') === 'cli') {
    launchDefaults.timeRange = timeRange as TimeRange;
    urlParams.set('range', launchDefaults.timeRange);
  }

  const localOnly = opts.lan === false || process.env.BURNRATE_NO_LAN === '1';
  const server = await startServer(preferredPort, snapshot, launchDefaults, { localOnly });
  const dashboardUrl = urlParams.toString() ? `${server.url}/?${urlParams.toString()}` : server.url;
  const preferredMobileBaseUrl = server.localOnly ? null : server.mdnsUrl || server.lanUrl;
  let mobileUrl: string | null = null;
  if (preferredMobileBaseUrl) {
    const mobileParams = new URLSearchParams(urlParams);
    mobileParams.set('qr', server.qrToken);
    mobileUrl = `${preferredMobileBaseUrl}/?${mobileParams.toString()}`;
  }

  const watcherHandle = startLogWatcher((updatedSnapshot, changedPath) => {
    server.broadcast(updatedSnapshot, changedPath);
    const timeStr = new Date().toLocaleTimeString();
    console.log(
      `${pc.dim(`[${timeStr}]`)} ${pc.green('● SSE Sync')} ${pc.dim('←')} ${pc.cyan(changedPath)}`
    );
  });

  // Periodic background pricing check (ETag 304 -> zero bytes when unchanged)
  const pricingRefreshInterval = setInterval(() => {
    void syncOfficialPricing()
      .then((res) => {
        if (res.updated) {
          const fresh = scanAllLogs(true);
          server.broadcast(fresh, 'pricing-sync');
        }
      })
      .catch(() => undefined);
  }, PRICING_SYNC_TTL_MS);
  pricingRefreshInterval.unref?.();

  console.log('');
  console.log(
    `  ${pc.bgGreen(pc.black(pc.bold(' AI-BURNRATE-TOOL ')))} ${pc.green('● LIVE')} ${pc.bold('Real-Time Token & Cost Tracker')}`
  );
  console.log(`  ${pc.dim('─'.repeat(58))}`);
  console.log(`  ${pc.bold('Dashboard URL:')}  ${pc.cyan(pc.underline(dashboardUrl))}`);
  if (server.port !== preferredPort) {
    console.log(
      `  ${pc.yellow('!')} ${pc.yellow(`Port ${preferredPort} busy → bound to ${server.port} (close any older running \`burn\` terminal).`)}`
    );
  }
  if (server.localOnly) {
    console.log(`  ${pc.bold('Network Bind:')}   ${pc.dim(`127.0.0.1:${server.port} (local-only mode · --no-lan)`)}`);
  } else if (server.mdnsUrl) {
    console.log(`  ${pc.bold('Mobile URL:')}     ${pc.cyan(pc.underline(server.mdnsUrl))} ${pc.dim('(mDNS · Bonjour)')}`);
    if (server.lanUrl) {
      console.log(`  ${pc.bold('Fallback IP:')}    ${pc.dim(server.lanUrl)} ${pc.dim('(0.0.0.0)')}`);
    }
    console.log(
      `  ${pc.bold('Phone Code:')}     ${pc.bgBlack(pc.green(pc.bold(` ${server.mobileCode} `)))} ${pc.dim('(enter on phone or scan QR)')}`
    );
  } else if (server.lanUrl) {
    console.log(`  ${pc.bold('Network (LAN):')}  ${pc.cyan(pc.underline(server.lanUrl))} ${pc.dim('(0.0.0.0)')}`);
    console.log(
      `  ${pc.bold('Phone Code:')}     ${pc.bgBlack(pc.green(pc.bold(` ${server.mobileCode} `)))} ${pc.dim('(enter on phone or scan QR)')}`
    );
  } else {
    console.log(`  ${pc.bold('Network Bind:')}   ${pc.dim(`0.0.0.0:${server.port} (no external LAN IP detected)`)}`);
    console.log(`  ${pc.bold('Phone Code:')}     ${pc.green(pc.bold(server.mobileCode))}`);
  }
  console.log(`  ${pc.bold('SSE Stream:')}     ${pc.dim(`${server.url}/api/events`)}`);
  console.log(`  ${pc.bold('Watching:')}       ${pc.dim(snapshot.watchedPaths.join(' & '))}`);
  const visibleSessionsCount = filterSessions(snapshot.sessions, {
    trackingStartAt: snapshot.settings?.trackingStartAt,
  }).length;
  console.log(`  ${pc.bold('Sessions Found:')} ${pc.yellow(String(visibleSessionsCount))}`);
  if (mobileUrl) {
    console.log(`  ${pc.dim('─'.repeat(58))}`);
    console.log(`  ${pc.bold('Scan from phone:')}`);
    for (const line of renderTerminalQr(mobileUrl, '  ')) {
      console.log(line);
    }
  }
  console.log(`  ${pc.dim('─'.repeat(58))}`);
  console.log(`  ${pc.dim('Press Ctrl+C to stop the live watcher and exit.')}\n`);

  if (opts.open !== false) {
    try {
      await openBrowserSilently(dashboardUrl);
    } catch {
      console.log(`  ${pc.yellow('!')} Could not auto-open browser. Open ${pc.cyan(dashboardUrl)} manually.`);
    }
  }

  // Non-blocking background sync for fresh telemetry & tariffs right after opening UI
  if (loadUserSettings().experimentalQuota !== false) {
    void defaultQuotaEngine
      .refreshAll({ force: false, reason: 'startup' })
      .then(() => server.broadcast(scanAllLogs(false), 'quota-startup'))
      .catch(() => undefined);
  }

  void syncOfficialPricing()
    .then((syncRes) => {
      if (syncRes.updated) {
        server.broadcast(scanAllLogs(true), 'pricing-startup');
      }
    })
    .catch(() => undefined);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pricingRefreshInterval);
    console.log(`\n  ${pc.yellow('●')} Received ${signal}. Closing file watcher and SSE connections...`);
    try {
      await Promise.all([watcherHandle.close(), server.close()]);
    } catch {
      // ignore
    }
    console.log(`  ${pc.green('✓')} ai-burnrate-tool stopped cleanly.`);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(pc.red('Fatal error starting ai-burnrate-tool:'), err);
  process.exit(1);
});
