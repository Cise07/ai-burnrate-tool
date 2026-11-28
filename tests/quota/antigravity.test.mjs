import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const agyMod = await import(
  pathToFileURL(
    path.resolve(process.cwd(), 'dist', 'core', 'quota', 'providers', 'antigravity.js')
  ).href
);

const {
  parseAntigravityCliUsageJson,
  parseAntigravityCreditsJson,
  parseAntigravityStatuslinePayload,
  projectAntigravitySnapshotAtTime,
} = agyMod;

const REAL_USAGE_FIXTURE = {
  conversation_id: '',
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          description:
            'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.5351267457008362,
              reset_time: '2026-12-03T14:43:26Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.9037924408912659,
              reset_time: '2026-11-27T23:46:48Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.9981310367584229,
              reset_time: '2026-12-01T22:17:59Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '1970-01-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  },
};

test('parseAntigravityCliUsageJson separates pools, preserves exact fractions and maps Go 1970 sentinel to null resetAtMs', () => {
  const fetchedAtMs = Date.UTC(2026, 10, 27, 18, 52, 20);
  const snap = parseAntigravityCliUsageJson(REAL_USAGE_FIXTURE, {
    fetchedAtMs,
    creditsBalance: 0,
  });

  assert.equal(snap.provider, 'antigravity');
  assert.equal(snap.status, 'ok');
  assert.equal('accountId' in snap, false);
  assert.equal(snap.creditsBalance, 0);
  assert.equal(snap.windows.length, 4);

  const gemini7d = snap.windows.find((w) => w.id === 'antigravity:gemini-weekly');
  const gemini5h = snap.windows.find((w) => w.id === 'antigravity:gemini-5h');
  const third7d = snap.windows.find((w) => w.id === 'antigravity:3p-weekly');
  const third5h = snap.windows.find((w) => w.id === 'antigravity:3p-5h');

  assert.ok(gemini7d && gemini5h && third7d && third5h);
  assert.equal(gemini7d.groupId, 'gemini');
  assert.equal(third7d.groupId, 'claude_gpt');
  assert.equal(gemini7d.remainingPercent, 53.5127);
  assert.equal(gemini7d.usedPercent, 46.4873);
  assert.equal(gemini7d.resetAtMs, Date.UTC(2026, 11, 3, 14, 43, 26));
  assert.equal(gemini5h.remainingPercent, 90.3792);
  assert.equal(gemini5h.resetAtMs, Date.UTC(2026, 10, 27, 23, 46, 48));

  // Unused 100% bucket with Go 1970 zero-time MUST yield resetAtMs = null
  assert.equal(third5h.remainingPercent, 100);
  assert.equal(third5h.usedPercent, 0);
  assert.equal(third5h.resetAtMs, null);
  assert.equal(third5h.accuracy, 'exact');
  assert.equal(third5h.source, 'agy_cli_usage');
});

test('Antigravity handles 3 window states (100% idle, partial, 0% exhausted), statusLine, account mismatch & errors', () => {
  const now = Date.UTC(2026, 10, 27, 19, 0, 0);

  // Exhausted Gemini bucket -> snapshot status = 'exhausted'
  const exhaustedPayload = structuredClone(REAL_USAGE_FIXTURE);
  exhaustedPayload.command.data.groups[0].buckets[1].remaining_fraction = 0;
  const exSnap = parseAntigravityCliUsageJson(exhaustedPayload, { fetchedAtMs: now });
  assert.equal(exSnap.status, 'exhausted');
  const ex5h = exSnap.windows.find((w) => w.id === 'antigravity:gemini-5h');
  assert.equal(ex5h.remainingPercent, 0);
  assert.equal(ex5h.usedPercent, 100);

  // Exhausted Claude & GPT (3p) bucket while Gemini still has quota -> status stays 'ok'
  const only3pPayload = structuredClone(REAL_USAGE_FIXTURE);
  if (only3pPayload.command.data.groups.length > 1) {
    only3pPayload.command.data.groups[1].buckets[0].remaining_fraction = 0;
  }
  const okWith3pZero = parseAntigravityCliUsageJson(only3pPayload, { fetchedAtMs: now });
  assert.equal(okWith3pZero.status, 'ok');

  // Legacy cached snapshot saved as 'exhausted' when only non-Gemini is 0% heals on projection
  const legacyCached = {
    ...okWith3pZero,
    status: 'exhausted',
    windows: okWith3pZero.windows.map((w) =>
      w.groupId === 'gemini' ? w : { ...w, remainingPercent: 0, usedPercent: 100 }
    ),
  };
  const healed = projectAntigravitySnapshotAtTime(legacyCached, now + 1000);
  assert.equal(healed.snapshot.status, 'ok');

  // statusLine payload
  const slSnap = parseAntigravityStatuslinePayload(
    {
      product: 'antigravity',
      email: 'dev@example.com',
      plan_tier: 'Pro',
      quota: {
        'gemini-weekly': {
          remaining_fraction: 0.9378,
          reset_time: '2026-12-03T14:43:26Z',
        },
        '3p-5h': {
          remaining_fraction: 1,
          reset_time: '1970-01-01T00:00:00Z',
        },
      },
    },
    { fetchedAtMs: now }
  );
  assert.equal(slSnap.planLabel, 'Pro');
  assert.equal('accountId' in slSnap, false);
  assert.equal(slSnap.windows[0].source, 'agy_statusline');

  // Credits extraction
  assert.equal(
    parseAntigravityCreditsJson({ command: { name: 'credits', data: { remaining_credits: 42 } } }),
    42
  );

  // Stale detection when reset boundary expires without reading user account files
  const expiredAt = exSnap.windows.find((w) => w.id === 'antigravity:gemini-5h').resetAtMs + 1000;
  const expiredProj = projectAntigravitySnapshotAtTime(exSnap, expiredAt);
  assert.equal(expiredProj.snapshot.status, 'stale');
  assert.equal(expiredProj.needsRefresh, true);

  // Auth error & malformed JSON fallbacks
  const authErr = parseAntigravityCliUsageJson(
    { status: 'ERROR', error: 'authentication required: sign in again' },
    { fetchedAtMs: now }
  );
  assert.equal(authErr.status, 'auth_error');
  assert.equal(authErr.windows.length, 0);

  const malformed = parseAntigravityCliUsageJson(null, { fetchedAtMs: now });
  assert.equal(malformed.status, 'unavailable');
  assert.equal(malformed.windows.length, 0);
});
