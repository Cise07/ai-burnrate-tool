#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import pc from 'picocolors';
import { scanAllLogs } from '../core/parser.js';
import type { TimeRange, ToolFilter } from '../core/analytics.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
import { startLogWatcher } from '../core/watcher.js';
import { startServer } from '../server/index.js';
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

const program = new Command();

program
  .name('burnrate')
  .description('Real-time local token & API equivalent cost tracker for Antigravity CLI and Claude Code')
  .version(getPackageVersion())
  .option('--cli', 'Print the usage report in ANSI tables in the terminal and exit immediately', false)
  .option('--eur', 'Display costs in EUR (€) instead of USD ($) in --cli mode', false)
  .option('--tool <tool>', 'Filter --cli report by tool (all, antigravity, claude)', 'all')
  .option('--range <range>', 'Filter --cli report by time range (24h, 7d, 30d, all)', 'all')
  .option('--json', 'Print --cli report as JSON instead of ANSI tables', false)
  .option('--no-open', 'Start the live server and file watcher without automatically opening the browser')
  .option('-p, --port <number>', 'Specify a custom port for the dashboard server', '4321')
  .option('--update', 'Update ai-burnrate-tool to the latest version from npm', false)
  .option('--uninstall', 'Uninstall ai-burnrate globally from your system', false);

program.parse(process.argv);

const opts = program.opts<{
  cli?: boolean;
  eur?: boolean;
  tool?: string;
  range?: string;
  json?: boolean;
  open?: boolean;
  port?: string;
  update?: boolean;
  uninstall?: boolean;
}>();

const VALID_TOOLS: ReadonlySet<string> = new Set(['all', 'antigravity', 'claude']);
const VALID_RANGES: ReadonlySet<string> = new Set(['24h', '7d', '30d', 'all']);

async function main() {
  if (opts.update) {
    const targetSpec = resolveNpmUpdateSpec();
    console.log(`\n  ${pc.cyan('●')} Updating ${pc.bold(targetSpec)} from npm...`);
    try {
      execSync(`npm install -g ${targetSpec}`, {
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
    console.log(`\n  ${pc.yellow('●')} Uninstalling ${pc.bold('ai-burnrate')} globally...`);
    try {
      execSync('npm uninstall -g ai-burnrate-tool', { stdio: 'inherit' });
      console.log(`  ${pc.green('✓')} ${pc.bold('ai-burnrate')} has been completely removed from your system.\n`);
      process.exit(0);
    } catch {
      console.error(`  ${pc.red('✗')} Failed to uninstall automatically. Run: ${pc.cyan('npm uninstall -g ai-burnrate-tool')}`);
      process.exit(1);
    }
  }

  const toolFilter = String(opts.tool || 'all').toLowerCase();
  const timeRange = String(opts.range || 'all').toLowerCase();

  if (!VALID_TOOLS.has(toolFilter)) {
    console.error(pc.red(`Invalid --tool "${opts.tool}". Expected: all, antigravity, or claude.`));
    process.exit(1);
  }
  if (!VALID_RANGES.has(timeRange)) {
    console.error(pc.red(`Invalid --range "${opts.range}". Expected: 24h, 7d, 30d, or all.`));
    process.exit(1);
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
  const server = await startServer(preferredPort, snapshot);

  const watcherHandle = startLogWatcher((updatedSnapshot, changedPath) => {
    server.broadcast(updatedSnapshot, changedPath);
    const timeStr = new Date().toLocaleTimeString();
    console.log(
      `${pc.dim(`[${timeStr}]`)} ${pc.green('● SSE Sync')} ${pc.dim('←')} ${pc.cyan(changedPath)}`
    );
  });

  console.log('');
  console.log(
    `  ${pc.bgGreen(pc.black(pc.bold(' AI-BURNRATE ')))} ${pc.green('● LIVE')} ${pc.bold('Real-Time Token & Cost Tracker')}`
  );
  console.log(`  ${pc.dim('─'.repeat(58))}`);
  console.log(`  ${pc.bold('Dashboard URL:')}  ${pc.cyan(pc.underline(server.url))}`);
  console.log(`  ${pc.bold('SSE Stream:')}     ${pc.dim(`${server.url}/api/events`)}`);
  console.log(`  ${pc.bold('Watching:')}       ${pc.dim(snapshot.watchedPaths.join(' & '))}`);
  console.log(`  ${pc.bold('Sessions Found:')} ${pc.yellow(String(snapshot.sessions.length))}`);
  console.log(`  ${pc.dim('─'.repeat(58))}`);
  console.log(`  ${pc.dim('Press Ctrl+C to stop the live watcher and exit.')}\n`);

  if (opts.open !== false) {
    try {
      await open(server.url);
    } catch {
      console.log(`  ${pc.yellow('!')} Could not auto-open browser. Open ${pc.cyan(server.url)} manually.`);
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
    console.log(`  ${pc.green('✓')} ai-burnrate stopped cleanly.`);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(pc.red('Fatal error starting ai-burnrate:'), err);
  process.exit(1);
});
