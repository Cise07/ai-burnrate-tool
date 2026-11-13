import pc from 'picocolors';
import { isPromoActive } from '../core/pricing.js';
import type { BurnrateSnapshot } from '../core/types.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function padRight(str: string, width: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= width) return str;
  return str + ' '.repeat(width - visible.length);
}

function padLeft(str: string, width: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= width) return str;
  return ' '.repeat(width - visible.length) + str;
}

export function printCliReport(snapshot: BurnrateSnapshot): void {
  const sessions = snapshot.sessions;
  let totalCost = 0;
  let totalCacheSavings = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalTokens = 0;

  const byTool = {
    antigravity: { sessions: 0, turns: 0, input: 0, cache: 0, output: 0, tokens: 0, cost: 0, savings: 0 },
    claude: { sessions: 0, turns: 0, input: 0, cache: 0, output: 0, tokens: 0, cost: 0, savings: 0 },
  };

  const byModel = new Map<
    string,
    { label: string; normalizedModel: string; turns: number; input: number; cache: number; output: number; tokens: number; cost: number; savings: number }
  >();

  for (const s of sessions) {
    totalCost += s.costUSD;
    totalCacheSavings += s.cacheSavingsUSD;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    totalTokens += s.totalTokens;

    const bucket = byTool[s.source];
    bucket.sessions += 1;
    bucket.turns += s.turns;
    bucket.input += s.inputTokens;
    bucket.cache += s.cacheReadTokens;
    bucket.output += s.outputTokens;
    bucket.tokens += s.totalTokens;
    bucket.cost += s.costUSD;
    bucket.savings += s.cacheSavingsUSD;

    for (const t of s.turnHistory) {
      const m = byModel.get(t.modelLabel) || {
        label: t.modelLabel,
        normalizedModel: t.normalizedModel,
        turns: 0,
        input: 0,
        cache: 0,
        output: 0,
        tokens: 0,
        cost: 0,
        savings: 0,
      };
      m.turns += 1;
      m.input += t.inputTokens;
      m.cache += t.cacheReadTokens;
      m.output += t.outputTokens;
      m.tokens += t.totalTokens;
      m.cost += t.costUSD;
      m.savings += t.cacheSavingsUSD;
      byModel.set(t.modelLabel, m);
    }
  }

  const subMonthly = snapshot.pricing.subscriptions.combinedMonthlyUSD || 40;
  const subRatio = subMonthly > 0 ? ((totalCost / subMonthly) * 100).toFixed(0) : '0';

  console.log('');
  console.log(
    `${pc.bgGreen(pc.black(pc.bold(' AI-BURNRATE ')))} ${pc.bold('Local Token & API Equivalent Cost Report')}`
  );
  console.log(pc.dim(`Scanned: ${snapshot.watchedPaths.join('  •  ')}`));
  console.log(pc.dim('─'.repeat(98)));

  console.log(
    `  ${pc.bold('API Equiv. Spend:')} ${pc.green(pc.bold(fmtUSD(totalCost)))} ${pc.dim(`(${subRatio}% of $${subMonthly}/mo sub)`)}   ` +
      `${pc.bold('Cache Saved:')} ${pc.cyan(pc.bold(fmtUSD(totalCacheSavings)))}   ` +
      `${pc.bold('Total Tokens:')} ${pc.yellow(pc.bold(fmtTokens(totalTokens)))}   ` +
      `${pc.bold('Sessions:')} ${pc.white(pc.bold(String(sessions.length)))}`
  );
  console.log(
    `  ${pc.dim(`Input (Uncached): ${fmtTokens(totalInput)}  •  Cache Read (Context): ${fmtTokens(totalCacheRead)}  •  Output (Think+Resp): ${fmtTokens(totalOutput)}`)}`
  );
  console.log(pc.dim('─'.repeat(98)));

  // Tool Summary Table
  console.log(`\n${pc.bold(pc.white('  TOOL BREAKDOWN'))}`);
  console.log(
    `  ${padRight(pc.dim('Tool'), 18)} ${padLeft(pc.dim('Sess'), 6)} ${padLeft(pc.dim('Turns'), 7)} ${padLeft(pc.dim('Input'), 10)} ${padLeft(pc.dim('Cache Read'), 12)} ${padLeft(pc.dim('Output'), 10)} ${padLeft(pc.dim('Total Tok'), 11)} ${padLeft(pc.dim('Cache Saved'), 12)} ${padLeft(pc.dim('API Cost'), 10)}`
  );
  console.log(`  ${pc.dim('─'.repeat(96))}`);

  const toolRows: Array<{ label: string; data: typeof byTool.antigravity }> = [
    { label: pc.cyan('Antigravity CLI'), data: byTool.antigravity },
    { label: pc.magenta('Claude Code'), data: byTool.claude },
  ];

  for (const row of toolRows) {
    console.log(
      `  ${padRight(row.label, 18)} ${padLeft(String(row.data.sessions), 6)} ${padLeft(String(row.data.turns), 7)} ${padLeft(fmtTokens(row.data.input), 10)} ${padLeft(pc.cyan(fmtTokens(row.data.cache)), 12)} ${padLeft(pc.yellow(fmtTokens(row.data.output)), 10)} ${padLeft(fmtTokens(row.data.tokens), 11)} ${padLeft(pc.cyan(fmtUSD(row.data.savings)), 12)} ${padLeft(pc.green(pc.bold(fmtUSD(row.data.cost))), 10)}`
    );
  }

  // Model Breakdown Table
  if (byModel.size > 0) {
    console.log(`\n${pc.bold(pc.white('  MODEL BREAKDOWN'))}`);
    console.log(
      `  ${padRight(pc.dim('Model'), 25)} ${padLeft(pc.dim('Turns'), 7)} ${padLeft(pc.dim('Input'), 10)} ${padLeft(pc.dim('Cache Read'), 12)} ${padLeft(pc.dim('Output'), 10)} ${padLeft(pc.dim('Total Tok'), 11)} ${padLeft(pc.dim('Cache Saved'), 12)} ${padLeft(pc.dim('API Cost'), 10)}`
    );
    console.log(`  ${pc.dim('─'.repeat(96))}`);

    const sortedModels = Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);
    let hasPromo = false;
    for (const m of sortedModels) {
      const rate =
        snapshot.pricing.models[m.normalizedModel] ||
        Object.values(snapshot.pricing.models).find(
          (r) => r.label === m.label || m.label.startsWith(r.label)
        );
      const isPromo = isPromoActive(rate);
      if (isPromo) hasPromo = true;
      const displayLabel = isPromo ? `${m.label} ${pc.yellow('★PROMO')}` : m.label;
      console.log(
        `  ${padRight(displayLabel, 32)} ${padLeft(String(m.turns), 7)} ${padLeft(fmtTokens(m.input), 10)} ${padLeft(pc.cyan(fmtTokens(m.cache)), 12)} ${padLeft(pc.yellow(fmtTokens(m.output)), 10)} ${padLeft(fmtTokens(m.tokens), 11)} ${padLeft(pc.cyan(fmtUSD(m.savings)), 12)} ${padLeft(pc.green(fmtUSD(m.cost)), 10)}`
      );
    }
    if (hasPromo) {
      console.log(`  ${pc.yellow('★')} ${pc.dim('Modelli con tariffe promozionali Google AI Studio attive.')}`);
    }
  }

  // Recent Sessions Table
  console.log(`\n${pc.bold(pc.white('  RECENT SESSIONS / WORKSPACES (Top 12)'))}`);
  console.log(
    `  ${padRight(pc.dim('Tool'), 13)} ${padRight(pc.dim('Workspace'), 22)} ${padRight(pc.dim('Model'), 18)} ${padLeft(pc.dim('Input'), 8)} ${padLeft(pc.dim('Cache'), 8)} ${padLeft(pc.dim('Output'), 7)} ${padLeft(pc.dim('Cost'), 7)} ${padLeft(pc.dim('Created'), 11)} ${padLeft(pc.dim('Modified'), 11)}`
  );
  console.log(`  ${pc.dim('─'.repeat(108))}`);

  for (const s of sessions.slice(0, 12)) {
    const toolTag = s.source === 'antigravity' ? pc.cyan('Antigravity') : pc.magenta('Claude Code');
    const ws = s.workspaceName.length > 20 ? '…' + s.workspaceName.slice(-19) : s.workspaceName;
    const mod = s.primaryModelLabel.length > 16 ? s.primaryModelLabel.slice(0, 16) : s.primaryModelLabel;
    const createdStr = s.startedAt ? s.startedAt.slice(0, 10) : '-';
    const activeStr = s.lastActiveAt ? s.lastActiveAt.slice(0, 10) : '-';
    console.log(
      `  ${padRight(toolTag, 13)} ${padRight(ws, 22)} ${padRight(mod, 18)} ${padLeft(fmtTokens(s.inputTokens), 8)} ${padLeft(pc.cyan(fmtTokens(s.cacheReadTokens)), 8)} ${padLeft(pc.yellow(fmtTokens(s.outputTokens)), 7)} ${padLeft(pc.green(fmtUSD(s.costUSD)), 7)} ${padLeft(pc.dim(createdStr), 11)} ${padLeft(pc.dim(activeStr), 11)}`
    );
  }

  console.log('');
}
