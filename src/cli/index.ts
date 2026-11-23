#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import pc from 'picocolors';
import QRCode from 'qrcode';
import { scanAllLogs, syncSingleTranscriptToLedger } from '../core/parser.js';
import type { TimeRange, ToolFilter } from '../core/analytics.js';
import { installAutoArchiveHooks, uninstallAutoArchiveHooks } from '../core/hooks.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
import { startLogWatcher } from '../core/watcher.js';
import { startServer, type LaunchDefaults } from '../server/index.js';
import { printCliReport } from './reporter.js';

const NPM_PACKAGE = 'ai-burnrate-tool';

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function resolveNpmUpdateSpec(): string {
  const requested = process.env.BURNRATE_VERSION?.trim();
  if (requested) {
    const version = requested.replace(/^v/, '');
    return `${NPM_PACKAGE}@${version}`;
  }
  return `${NPM_PACKAGE}@latest`;
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
  .option('--no-hooks', 'Skip automatic installation of Antigravity/Claude/Codex offline archive hooks')
  .option('--sync-ledger', 'Fast hook mode: snapshot current session to ledger and exit silently', false)
  .option('--uninstall-hooks', 'Remove ai-burnrate-tool offline archive hooks from Antigravity/Claude/Codex configs', false)
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
  hooks?: boolean;
  syncLedger?: boolean;
  uninstallHooks?: boolean;
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
  if (opts.syncLedger) {
    try {
      const hookPayload = await readStdinJsonWithTimeout(150);
      syncSingleTranscriptToLedger(hookPayload);
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

  if (opts.uninstallHooks) {
    uninstallAutoArchiveHooks();
    console.log(`\n  ${pc.green('✓')} Removed ai-burnrate-tool offline archive hooks from Antigravity, Claude Code & Codex CLI.\n`);
    process.exit(0);
  }

  if (opts.update) {
    const targetSpec = resolveNpmUpdateSpec();
    console.log(`\n  ${pc.cyan('●')} Updating ${pc.bold(targetSpec)} from npm...`);
    try {
      execSync(`npm install -g --foreground-scripts ${targetSpec}`, {
        stdio: 'inherit',
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
      execSync('npm uninstall -g ai-burnrate-tool', { stdio: 'inherit' });
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

  if (opts.hooks !== false) {
    installAutoArchiveHooks();
  }

  const syncResult = await syncOfficialPricing();
  if (syncResult.updated && syncResult.effectiveFrom && !(opts.cli && opts.json)) {
    console.log(
      `  ${pc.cyan('↻')} Official pricing updated (new tariff active for turns from ${pc.bold(syncResult.effectiveFrom)}; past turns preserved).`
    );
  }

  const snapshot = scanAllLogs(true);

  if (opts.cli) {
    printCliReport(snapshot, {
      currency: opts.eur ? 'EUR' : 'USD',
      toolFilter: toolFilter as ToolFilter,
      timeRange: timeRange as TimeRange,
      json: Boolean(opts.json),
    });
    process.exit(0);
  }

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

  const server = await startServer(preferredPort, snapshot, launchDefaults);
  const dashboardUrl = urlParams.toString() ? `${server.url}/?${urlParams.toString()}` : server.url;
  const preferredMobileBaseUrl = server.mdnsUrl || server.lanUrl;
  let mobileUrl: string | null = null;
  if (preferredMobileBaseUrl) {
    const mobileParams = new URLSearchParams(urlParams);
    mobileParams.set('code', server.mobileCode);
    mobileUrl = `${preferredMobileBaseUrl}/?${mobileParams.toString()}`;
  }

  const watcherHandle = startLogWatcher((updatedSnapshot, changedPath) => {
    server.broadcast(updatedSnapshot, changedPath);
    const timeStr = new Date().toLocaleTimeString();
    console.log(
      `${pc.dim(`[${timeStr}]`)} ${pc.green('● SSE Sync')} ${pc.dim('←')} ${pc.cyan(changedPath)}`
    );
  });

  console.log('');
  console.log(
    `  ${pc.bgGreen(pc.black(pc.bold(' AI-BURNRATE-TOOL ')))} ${pc.green('● LIVE')} ${pc.bold('Real-Time Token & Cost Tracker')}`
  );
  console.log(`  ${pc.dim('─'.repeat(58))}`);
  console.log(`  ${pc.bold('Dashboard URL:')}  ${pc.cyan(pc.underline(dashboardUrl))}`);
  if (server.mdnsUrl) {
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
  console.log(`  ${pc.bold('Sessions Found:')} ${pc.yellow(String(snapshot.sessions.length))}`);
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
      await open(dashboardUrl);
    } catch {
      console.log(`  ${pc.yellow('!')} Could not auto-open browser. Open ${pc.cyan(dashboardUrl)} manually.`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
