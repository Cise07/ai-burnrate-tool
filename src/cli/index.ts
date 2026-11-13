#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import pc from 'picocolors';
import { scanAllLogs } from '../core/parser.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
import { startLogWatcher } from '../core/watcher.js';
import { startServer } from '../server/index.js';
import { printCliReport } from './reporter.js';

const REPO_SLUG = 'Cise07/ai-burnrate-tool';

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

async function resolveUpdateTarget(): Promise<{ label: string; url: string }> {
  const requested = process.env.BURNRATE_VERSION?.trim();
  if (requested) {
    const tag = requested.startsWith('v') ? requested : `v${requested}`;
    return {
      label: tag,
      url: `https://github.com/${REPO_SLUG}/archive/refs/tags/${tag}.tar.gz`,
    };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
      headers: { 'User-Agent': 'ai-burnrate-cli' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      if (data.tag_name) {
        return {
          label: data.tag_name,
          url: `https://github.com/${REPO_SLUG}/archive/refs/tags/${data.tag_name}.tar.gz`,
        };
      }
    }
  } catch {
    // Fallback to main branch if no GitHub Release exists yet or offline
  }

  return {
    label: 'main',
    url: `https://github.com/${REPO_SLUG}/archive/refs/heads/main.tar.gz`,
  };
}

const program = new Command();

program
  .name('burnrate')
  .description('Real-time local token & API equivalent cost tracker for Antigravity CLI and Claude Code')
  .version(getPackageVersion())
  .option('--cli', 'Print the usage report in ANSI tables in the terminal and exit immediately', false)
  .option('--no-open', 'Start the live server and file watcher without automatically opening the browser')
  .option('-p, --port <number>', 'Specify a custom port for the dashboard server', '4321')
  .option('--update', 'Update ai-burnrate to the latest release from GitHub', false)
  .option('--uninstall', 'Uninstall ai-burnrate globally from your system', false);

program.parse(process.argv);

const opts = program.opts<{
  cli?: boolean;
  open?: boolean;
  port?: string;
  update?: boolean;
  uninstall?: boolean;
}>();

async function main() {
  if (opts.update) {
    const target = await resolveUpdateTarget();
    console.log(`\n  ${pc.cyan('●')} Updating ${pc.bold('ai-burnrate')} (${pc.cyan(target.label)}) from GitHub...`);
    try {
      execSync(`npm install -g ${target.url}`, {
        stdio: 'inherit',
      });
      console.log(`  ${pc.green('✓')} ${pc.bold('ai-burnrate')} updated successfully to ${pc.bold(target.label)}!\n`);
      process.exit(0);
    } catch {
      console.error(
        `  ${pc.red('✗')} Failed to update automatically. Try running:\n  ${pc.cyan(`npm install -g ${target.url}`)}\n`
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

  const syncResult = await syncOfficialPricing();
  if (syncResult.updated && syncResult.effectiveFrom) {
    console.log(
      `  ${pc.cyan('↻')} Official pricing updated (new tariff active for turns from ${pc.bold(syncResult.effectiveFrom)}; past turns preserved).`
    );
  }

  const snapshot = scanAllLogs(true);

  if (opts.cli) {
    printCliReport(snapshot);
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
