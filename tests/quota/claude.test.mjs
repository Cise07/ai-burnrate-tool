import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const claudeMod = await import(
  pathToFileURL(path.resolve(process.cwd(), 'dist', 'core', 'quota', 'providers', 'claude.js')).href
);

const {
  parseClaudeStatuslinePayload,
  parseClaudeRateLimitHeaders,
  projectClaudeSnapshotAtTime,
} = claudeMod;

test('parseClaudeStatuslinePayload supports multiple windows (5h, 7d, 7d_sonnet, nullable 7d_opus) without 0..1 vs 0..100 confusion', () => {
  const capturedAtMs = Date.UTC(2026, 10, 27, 18, 0, 0);
  const reset5hSec = Math.floor((capturedAtMs + 3 * 3600_000) / 1000);
  const reset7dSec = Math.floor((capturedAtMs + 4 * 86400_000) / 1000);

  const snap = parseClaudeStatuslinePayload(
    {
      model: { display_name: 'Claude Sonnet 4.5' },
      rate_limits: {
        five_hour: { used_percentage: 0.5, resets_at: reset5hSec }, // 0.5% on 0..100 scale, NOT 50%!
        seven_day: { used_percentage: 18.25, resets_at: reset7dSec },
        seven_day_sonnet: { used_percentage: 12.5, resets_at: reset7dSec },
        seven_day_opus: null,
      },
    },
    { capturedAtMs }
  );

  assert.ok(snap);
  assert.equal(snap.provider, 'claude');
  assert.equal(snap.status, 'ok');
  assert.equal(snap.windows.length, 3);
  assert.deepEqual(
    snap.windows.map((w) => w.id),
    ['claude:7d', 'claude:7d-sonnet', 'claude:5h']
  );

  const five = snap.windows.find((w) => w.id === 'claude:5h');
  assert.equal(five.usedPercent, 0.5);
  assert.equal(five.remainingPercent, 99.5);
  assert.equal(five.resetAtMs, reset5hSec * 1000);
  assert.equal(five.accuracy, 'exact');
});

test('parseClaudeRateLimitHeaders converts 0..1 utilization and computes HTTP Date clockSkewMs', () => {
  const capturedAtMs = Date.UTC(2026, 10, 27, 18, 0, 0);
  const serverNow = capturedAtMs + 45_000; // Server clock 45s ahead of local
  const reset5h = Math.floor((serverNow + 2 * 3600_000) / 1000);
  const reset7d = Math.floor((serverNow + 5 * 86400_000) / 1000);

  const snap = parseClaudeRateLimitHeaders(
    {
      date: new Date(serverNow).toUTCString(),
      'anthropic-ratelimit-unified-5h-utilization': '0.425',
      'anthropic-ratelimit-unified-5h-reset': String(reset5h),
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String(reset7d),
    },
    { capturedAtMs }
  );

  assert.ok(snap);
  assert.equal(snap.clockSkewMs, 45_000);
  assert.equal(snap.status, 'exhausted');
  const w5 = snap.windows.find((w) => w.id === 'claude:5h');
  const w7 = snap.windows.find((w) => w.id === 'claude:7d');
  assert.equal(w5.usedPercent, 42.5);
  assert.equal(w5.remainingPercent, 57.5);
  assert.equal(w7.remainingPercent, 0);
  assert.equal(w7.usedPercent, 100);
});

test('projectClaudeSnapshotAtTime rolls over cleanly past resetAtMs without negative values or 0m hang', () => {
  const capturedAtMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const reset5hMs = capturedAtMs + 2 * 3600_000;
  const reset7dMs = capturedAtMs + 4 * 86400_000;

  const snap = parseClaudeStatuslinePayload(
    {
      rate_limits: {
        five_hour: { used_percentage: 80, resets_at: Math.floor(reset5hMs / 1000) },
        seven_day: { used_percentage: 25, resets_at: Math.floor(reset7dMs / 1000) },
      },
    },
    { capturedAtMs }
  );

  // Evaluate 10 minutes after 5h window expired while 7d is still active
  const postReset = projectClaudeSnapshotAtTime(snap, reset5hMs + 600_000);
  assert.equal(postReset.status, 'stale');
  const w5 = postReset.windows.find((w) => w.id === 'claude:5h');
  const w7 = postReset.windows.find((w) => w.id === 'claude:7d');

  assert.equal(w5.remainingPercent, 100);
  assert.equal(w5.resetAtMs, null);
  assert.equal(w5.accuracy, 'derived');
  assert.equal(w5.source, 'claude_statusline:post_reset');

  assert.equal(w7.remainingPercent, 75);
  assert.equal(w7.accuracy, 'exact');

  // Corrupt / missing payload safety
  assert.equal(parseClaudeStatuslinePayload(null, { capturedAtMs }), null);
  assert.equal(parseClaudeStatuslinePayload({ rate_limits: {} }, { capturedAtMs }), null);
});
