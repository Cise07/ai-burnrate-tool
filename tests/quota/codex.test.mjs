import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const codexMod = await import(
  pathToFileURL(path.resolve(process.cwd(), 'dist', 'core', 'quota', 'providers', 'codex.js')).href
);
const timeMod = await import(
  pathToFileURL(path.resolve(process.cwd(), 'dist', 'core', 'quota', 'time.js')).href
);

const { parseCodexRateLimitsEvent, scanLatestCodexQuota, projectCodexSnapshotAtTime } = codexMod;
const { evaluateCountdown } = timeMod;

test('parseCodexRateLimitsEvent preserves primary & secondary windows separately and anchors resets_in_seconds to eventTimestampMs', () => {
  const nowMs = Date.UTC(2026, 10, 27, 19, 0, 0);
  // Event is 17 minutes old!
  const eventMs = nowMs - 17 * 60_000;

  const snap = parseCodexRateLimitsEvent(
    {
      timestamp: new Date(eventMs).toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'plus',
          primary: {
            used_percent: 27.3,
            window_minutes: 300,
            resets_in_seconds: 3600, // 60m from eventMs => 43m remaining at nowMs!
          },
          secondary: {
            used_percent: 14.0,
            window_minutes: 10080,
            resets_at: Math.floor((nowMs + 3 * 86400_000) / 1000), // Unix seconds
          },
          credits: { has_credits: true, unlimited: false, balance: '14.50' },
        },
      },
    },
    { eventTimestampMs: eventMs, serverNowMs: nowMs }
  );

  assert.ok(snap);
  assert.equal(snap.provider, 'codex');
  assert.equal(snap.planLabel, 'Plus');
  assert.equal(snap.creditsBalance, 14.5);
  assert.equal(snap.sourceUpdatedAtMs, eventMs);

  const primary = snap.windows.find((w) => w.id === 'codex:primary');
  const secondary = snap.windows.find((w) => w.id === 'codex:secondary');
  assert.ok(primary && secondary);

  // Floating-point exact complement 100 - 27.3 = 72.7
  assert.equal(primary.usedPercent, 27.3);
  assert.equal(primary.remainingPercent, 72.7);
  assert.equal(primary.resetAtMs, eventMs + 3600 * 1000);
  // Old event scaled by 17m -> countdown must be 43m, NOT 60m!
  assert.equal(evaluateCountdown(primary.resetAtMs, nowMs).formatted, '43m');

  assert.equal(secondary.remainingPercent, 86);
  assert.equal(secondary.resetAtMs, Math.floor((nowMs + 3 * 86400_000) / 1000) * 1000);
});

test('scanLatestCodexQuota picks freshest event by numeric UTC timestamp across sessions, offsets & corrupted lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnrate-codex-test-'));
  try {
    const sessDir = path.join(tmpDir, 'sessions', '2026', '11', '27');
    fs.mkdirSync(sessDir, { recursive: true });

    const nowMs = Date.UTC(2026, 10, 27, 20, 0, 0);
    // File A has older event (18:00Z) written LATER to test mtime is not blindly trusted over event timestamp
    const fileB = path.join(sessDir, 'rollout-newer-event.jsonl');
    const fileA = path.join(sessDir, 'rollout-older-event.jsonl');

    // File B uses +01:00 offset: 20:50+01:00 === 19:50Z (fresher than 18:00Z!)
    fs.writeFileSync(
      fileB,
      [
        '{broken-json-line',
        JSON.stringify({
          timestamp: '2026-11-27T20:50:00+01:00',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: null,
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-27T20:50:00+01:00',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              plan_type: 'pro',
              primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 1800 },
              secondary: { used_percent: 20, window_minutes: 10080, resets_at: Math.floor((nowMs + 2 * 86400_000) / 1000) },
            },
          },
        }),
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      fileA,
      JSON.stringify({
        timestamp: '2026-11-27T18:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 95, window_minutes: 300, resets_in_seconds: 300 },
            secondary: { used_percent: 90, window_minutes: 10080, resets_at: Math.floor((nowMs + 86400_000) / 1000) },
          },
        },
      }) + '\n',
      'utf-8'
    );

    const { snapshot } = scanLatestCodexQuota(tmpDir, nowMs);
    assert.ok(snapshot);
    assert.equal(snapshot.sourceUpdatedAtMs, Date.UTC(2026, 10, 27, 19, 50, 0));
    const p = snapshot.windows.find((w) => w.id === 'codex:primary');
    assert.equal(p.remainingPercent, 60);
    // 19:50Z + 30m = 20:20Z -> at 20:00Z countdown is 20m!
    assert.equal(evaluateCountdown(p.resetAtMs, nowMs).formatted, '20m');

    // Past reset invalidation on stale exhausted event
    const expired = projectCodexSnapshotAtTime(snapshot, Date.UTC(2026, 10, 30, 0, 0, 0));
    assert.equal(expired.status, 'stale');
    assert.ok(expired.windows.every((w) => w.remainingPercent === 100 && w.resetAtMs === null && w.accuracy === 'derived'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
