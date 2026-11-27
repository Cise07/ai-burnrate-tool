import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const timeMod = await import(
  pathToFileURL(path.resolve(process.cwd(), 'dist', 'core', 'quota', 'time.js')).href
);

const {
  computeClockSkewMs,
  computePercentPair,
  computeResetAtFromRelativeSeconds,
  evaluateCountdown,
  formatDisplayPercent,
  formatResetLocalTime,
  msUntilNextAlignedTick,
  normalizeEpochMs,
} = timeMod;

test('normalizeEpochMs handles Unix seconds, milliseconds, ISO-8601 offsets, DST & Go zero sentinels', () => {
  const sec = 1_795_800_000;
  assert.equal(normalizeEpochMs(sec), sec * 1000);
  assert.equal(normalizeEpochMs(String(sec)), sec * 1000);
  assert.equal(normalizeEpochMs(1_795_800_000.5), 1_795_800_000_500);
  assert.equal(normalizeEpochMs(sec * 1000), sec * 1000);
  assert.equal(normalizeEpochMs(String(sec * 1000)), sec * 1000);

  // ISO-8601 across offsets must resolve to identical UTC epoch ms
  const isoZ = '2026-11-27T18:00:00.000Z';
  const isoPlus1 = '2026-11-27T19:00:00+01:00';
  const isoMinus5 = '2026-11-27T13:00:00-05:00';
  const isoCompactOffset = '2026-11-27 19:00:00+0100';
  assert.equal(normalizeEpochMs(isoZ), Date.UTC(2026, 10, 27, 18, 0, 0));
  assert.equal(normalizeEpochMs(isoPlus1), normalizeEpochMs(isoZ));
  assert.equal(normalizeEpochMs(isoMinus5), normalizeEpochMs(isoZ));
  assert.equal(normalizeEpochMs(isoCompactOffset), normalizeEpochMs(isoZ));

  // DST transition in Europe/Rome: 2026-03-29T01:30Z is 03:30 CEST (+02:00) vs 2026-03-29T00:30Z (01:30 CET)
  const beforeDstMs = normalizeEpochMs('2026-03-29T01:30:00+01:00');
  const afterDstMs = normalizeEpochMs('2026-03-29T03:30:00+02:00');
  assert.equal(afterDstMs - beforeDstMs, 3_600_000);

  const formattedBefore = formatResetLocalTime(beforeDstMs, beforeDstMs, { timeZone: 'Europe/Rome' });
  const formattedAfter = formatResetLocalTime(afterDstMs, afterDstMs, { timeZone: 'Europe/Rome' });
  assert.equal(formattedBefore, '01:30');
  assert.equal(formattedAfter, '03:30');

  // Sentinels & corrupted dates must return null
  assert.equal(normalizeEpochMs(0), null);
  assert.equal(normalizeEpochMs(-1), null);
  assert.equal(normalizeEpochMs('0'), null);
  assert.equal(normalizeEpochMs('1970-01-01T00:00:00Z'), null);
  assert.equal(normalizeEpochMs('0001-01-01T00:00:00Z'), null);
  assert.equal(normalizeEpochMs('not-a-timestamp'), null);
  assert.equal(normalizeEpochMs(null), null);
});

test('computeResetAtFromRelativeSeconds strictly anchors to source anchor timestamp (no Date.now fallback)', () => {
  const anchorMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  assert.equal(computeResetAtFromRelativeSeconds(3600, anchorMs), anchorMs + 3_600_000);
  assert.equal(computeResetAtFromRelativeSeconds('120', anchorMs), anchorMs + 120_000);
  assert.equal(computeResetAtFromRelativeSeconds(0, anchorMs), null);
  assert.equal(computeResetAtFromRelativeSeconds(-5, anchorMs), null);
  assert.equal(computeResetAtFromRelativeSeconds(3600, null), null);
  assert.equal(computeResetAtFromRelativeSeconds(3600, 0), null);
});

test('evaluateCountdown edge cases: 0ms, 1ms, 59_000ms, 60_000ms, 61_000ms, 3_600_000ms, >24h & clockSkew', () => {
  const baseNow = Date.UTC(2026, 10, 27, 15, 0, 0);

  // null -> Ready (window inactive)
  assert.deepEqual(evaluateCountdown(null, baseNow), {
    state: 'idle',
    remainingMs: null,
    formatted: 'Ready',
    formattedDetailed: 'Ready',
    isExpired: false,
  });

  // 0ms & negative rollover -> Updating... (never negative or "0m")
  assert.equal(evaluateCountdown(baseNow, baseNow).formatted, 'Updating...');
  assert.equal(evaluateCountdown(baseNow, baseNow).isExpired, true);
  assert.equal(evaluateCountdown(baseNow - 5000, baseNow).formatted, 'Updating...');
  assert.equal(evaluateCountdown(baseNow - 5000, baseNow).remainingMs, 0);

  // Sub-minute bounds -> "< 1m" (NEVER "0m")
  const cd1ms = evaluateCountdown(baseNow + 1, baseNow);
  assert.equal(cd1ms.state, 'sub_minute');
  assert.equal(cd1ms.formatted, '< 1m');
  assert.equal(cd1ms.formattedDetailed, '< 1m (1s)');

  const cd59s = evaluateCountdown(baseNow + 59_000, baseNow);
  assert.equal(cd59s.state, 'sub_minute');
  assert.equal(cd59s.formatted, '< 1m');
  assert.equal(cd59s.formattedDetailed, '< 1m (59s)');

  // Minute boundaries -> floor(remainingMs / 60_000)
  assert.equal(evaluateCountdown(baseNow + 60_000, baseNow).formatted, '1m');
  assert.equal(evaluateCountdown(baseNow + 61_000, baseNow).formatted, '1m');
  assert.equal(evaluateCountdown(baseNow + 3_600_000, baseNow).formatted, '1h');
  assert.equal(evaluateCountdown(baseNow + (4 * 3600 + 54 * 60 + 25) * 1000, baseNow).formatted, '4h 54m');

  // > 24h formatting
  const gt24hMs = ((2 * 24 + 4) * 60 + 15) * 60_000;
  assert.equal(evaluateCountdown(baseNow + gt24hMs, baseNow).formatted, '2d 4h 15m');

  // Positive & negative clockSkewMs (server ahead +90s => 90s less left; server behind -90s => 90s more left)
  const target = baseNow + 10 * 60_000;
  assert.equal(computeClockSkewMs(baseNow + 90_000, baseNow), 90_000);
  assert.equal(evaluateCountdown(target, baseNow, +90_000).formatted, '8m');
  assert.equal(evaluateCountdown(target, baseNow, -90_000).formatted, '11m');
});

test('msUntilNextAlignedTick aligns to minute and second boundaries', () => {
  const atMidMinute = Date.UTC(2026, 10, 27, 15, 10, 52, 0); // 8s before :11:00
  assert.equal(msUntilNextAlignedTick(atMidMinute, 0, false), 8025);

  const farFromBoundary = Date.UTC(2026, 10, 27, 15, 10, 10, 0); // 50s before :11:00 -> capped at 15s for sleep wake
  assert.equal(msUntilNextAlignedTick(farFromBoundary, 0, false), 15_000);

  const atSubSecond = Date.UTC(2026, 10, 27, 15, 10, 10, 300);
  assert.equal(msUntilNextAlignedTick(atSubSecond, 0, true), 720);
});

test('computePercentPair and formatDisplayPercent preserve exact precision without 0/100 false rounding', () => {
  const pair = computePercentPair({ remainingPercent: 53.51267457 });
  assert.equal(pair.remainingPercent, 53.5127);
  assert.equal(pair.usedPercent, 46.4873);
  assert.equal(pair.remainingPercent + pair.usedPercent, 100);

  assert.equal(formatDisplayPercent(100), '100%');
  assert.equal(formatDisplayPercent(0), '0%');
  assert.equal(formatDisplayPercent(53.5127), '53.5%');
  assert.equal(formatDisplayPercent(99.98), '99.9%');
  assert.equal(formatDisplayPercent(0.02), '<0.1%');
  assert.equal(formatDisplayPercent(null), '—');
});
