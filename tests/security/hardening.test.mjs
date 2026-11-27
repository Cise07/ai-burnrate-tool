import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'burnrate-security-test-'));
const geminiDir = path.join(tmpRoot, 'gemini');
const claudeDir = path.join(tmpRoot, 'claude');
const codexDir = path.join(tmpRoot, 'codex');
const outsideDir = path.join(tmpRoot, 'outside');
const quotaPath = path.join(tmpRoot, 'quota-state.json');
const settingsPath = path.join(tmpRoot, 'settings.json');
const pricingLedgerPath = path.join(tmpRoot, 'pricing-ledger.json');
const sessionLedgerPath = path.join(tmpRoot, 'sessions-ledger.json');

fs.mkdirSync(path.join(geminiDir, 'antigravity-cli', 'brain', 'valid-conv-123', '.system_generated', 'logs'), {
  recursive: true,
});
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(codexDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

process.env.BURNRATE_GEMINI_DIR = geminiDir;
process.env.BURNRATE_CLAUDE_DIR = claudeDir;
process.env.BURNRATE_CODEX_DIR = codexDir;
process.env.BURNRATE_QUOTA_PATH = quotaPath;
process.env.BURNRATE_SETTINGS_PATH = settingsPath;
process.env.BURNRATE_PRICING_LEDGER_PATH = pricingLedgerPath;
process.env.BURNRATE_SESSION_LEDGER_PATH = sessionLedgerPath;

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');

const { resolveNpmUpdateSpec, runGlobalNpmCommand } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'cli-security.js')).href
);
const { syncSingleTranscriptToLedger } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'parser.js')).href
);
const { importPricingLedger, sanitizeModelsRecord } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'pricing.js')).href
);
const { startServer, createAuthRateLimiter } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'server', 'index.js')).href
);

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function rawHttpRequest({ host = '127.0.0.1', port, method = 'GET', reqPath = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeDummySnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    serverNowMs: Date.now(),
    watchedPaths: [geminiDir, claudeDir, codexDir],
    pricing: {
      updatedAt: '2026-11-27',
      currency: 'USD',
      unit: '1M_tokens',
      subscriptions: {
        claude_max: { name: 'Claude Max', monthlyUSD: 100 },
        antigravity_pro: { name: 'Google AI Pro', monthlyUSD: 20 },
        combinedMonthlyUSD: 120,
      },
      models: {},
      defaults: { claude: 'claude-sonnet-4', antigravity: 'gemini-4-argon', codex: 'gpt-6.2-sol' },
    },
    sessions: [],
    deletedSessions: [],
    dismissedLegacyCount: 0,
    settings: {
      subscriptions: { antigravity: 20, claude: 100, codex: 20 },
      includeDeletedInTotals: true,
      experimentalQuota: false,
      layout: { order: ['kpis', 'charts', 'modelUsage', 'heatmapWorkspaces', 'sessions'], hidden: [] },
      trackingStartAt: { antigravity: null, claude: null, codex: null },
    },
  };
}

test('CLI update spec rejects command injection and accepts valid semver/tags', () => {
  assert.equal(resolveNpmUpdateSpec(undefined), 'ai-burnrate-tool@latest');
  assert.equal(resolveNpmUpdateSpec('v1.3.0'), 'ai-burnrate-tool@1.3.0');
  assert.equal(resolveNpmUpdateSpec('1.4.0-beta.1'), 'ai-burnrate-tool@1.4.0-beta.1');
  assert.equal(resolveNpmUpdateSpec('next'), 'ai-burnrate-tool@next');

  for (const malicious of [
    '1.3.0 && calc',
    '1.3.0; rm -rf /',
    'latest --registry=https://evil.example',
    '$(whoami)',
    '`id`',
    '%COMSPEC%',
    '1.3.0\nwhoami',
  ]) {
    assert.throws(() => resolveNpmUpdateSpec(malicious), /Unsafe or invalid/);
  }

  assert.throws(() => runGlobalNpmCommand(['install', '-g', 'foo && bar']), /Unsafe npm argument/);
});

test('Hook ledger sync confines transcript_path and conversationId to configured provider directories', () => {
  const outsideFile = path.join(outsideDir, 'secret.jsonl');
  fs.writeFileSync(
    outsideFile,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-27T12:00:00.000Z',
      sessionId: 'outside-secret-session',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })}\n`,
    'utf-8'
  );

  // Outside .jsonl file must never be parsed/ingested
  syncSingleTranscriptToLedger({ transcript_path: outsideFile });
  const afterOutside = fs.existsSync(sessionLedgerPath)
    ? JSON.parse(fs.readFileSync(sessionLedgerPath, 'utf-8'))
    : { sessions: {} };
  assert.equal(afterOutside.sessions['claude:outside-secret-session'], undefined);
  assert.equal(afterOutside.sessions['antigravity:outside-secret-session'], undefined);

  // Non-.jsonl file even inside claudeDir must be ignored
  const nonJsonlInside = path.join(claudeDir, 'notes.txt');
  fs.writeFileSync(
    nonJsonlInside,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-27T12:00:00.000Z',
      sessionId: 'non-jsonl-session',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })}\n`,
    'utf-8'
  );
  syncSingleTranscriptToLedger({ transcript_path: nonJsonlInside });
  const afterNonJsonl = fs.existsSync(sessionLedgerPath)
    ? JSON.parse(fs.readFileSync(sessionLedgerPath, 'utf-8'))
    : { sessions: {} };
  assert.equal(afterNonJsonl.sessions['claude:non-jsonl-session'], undefined);

  // Traversal in conversationId pointing to an existing outside transcript must be rejected
  const traversalTarget = path.join(outsideDir, 'escaped-conv', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(traversalTarget), { recursive: true });
  fs.writeFileSync(
    traversalTarget,
    `${JSON.stringify({
      timestamp: '2026-11-27T12:00:00.000Z',
      model: 'gemini-4-argon',
      usage: { input_tokens: 100, output_tokens: 50 },
    })}\n`,
    'utf-8'
  );
  syncSingleTranscriptToLedger({ conversationId: '../../../../outside/escaped-conv' });
  syncSingleTranscriptToLedger({ conversationId: 'valid-conv-123/../../../../outside/escaped-conv' });
  const afterTraversal = fs.existsSync(sessionLedgerPath)
    ? JSON.parse(fs.readFileSync(sessionLedgerPath, 'utf-8'))
    : { sessions: {} };
  assert.equal(afterTraversal.sessions['antigravity:escaped-conv'], undefined);

  // Valid transcript inside claudeDir succeeds and persists to ledger
  const validClaudeTranscript = path.join(claudeDir, 'projects', 'proj', 'session-1.jsonl');
  fs.mkdirSync(path.dirname(validClaudeTranscript), { recursive: true });
  fs.writeFileSync(
    validClaudeTranscript,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-27T12:00:00.000Z',
      sessionId: 'session-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
    })}\n`,
    'utf-8'
  );
  assert.equal(syncSingleTranscriptToLedger({ transcript_path: validClaudeTranscript }), true);
  const afterValid = JSON.parse(fs.readFileSync(sessionLedgerPath, 'utf-8'));
  assert.ok(afterValid.sessions['claude:session-1']);
});

test('Pricing sanitization prevents prototype pollution and strips unknown properties', () => {
  const maliciousPayload = JSON.parse(
    '{"__proto__":{"polluted":true,"label":"x","input":1,"output":1,"cacheRead":0,"cacheWrite":0},"constructor":{"label":"y","input":1,"output":1,"cacheRead":0,"cacheWrite":0},"claude-sonnet-4":{"label":"Claude Sonnet 4","provider":"anthropic","input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75,"extraEvil":"strip-me"}}'
  );

  const sanitized = sanitizeModelsRecord(maliciousPayload);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'constructor'), false);
  assert.equal('extraEvil' in sanitized['claude-sonnet-4'], false);

  const imported = importPricingLedger({
    updatedAt: '2026-11-27',
    models: maliciousPayload,
  });
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(imported.modelsMerged >= 1);
});

test('AuthRateLimiter never evicts actively locked IPs and enforces global brute-force cap', () => {
  const limiter = createAuthRateLimiter({
    maxIpFailures: 2,
    maxGlobalFailures: 1000,
    lockoutMs: 60_000,
    maxTrackedIps: 3,
  });
  const t0 = 1_700_000_000_000;

  assert.equal(limiter.recordFailure('10.0.0.1', t0), 0);
  assert.equal(limiter.recordFailure('10.0.0.1', t0 + 10), 60);
  assert.equal(limiter.recordFailure('10.0.0.2', t0 + 20), 0);
  assert.equal(limiter.recordFailure('10.0.0.2', t0 + 30), 60);
  assert.equal(limiter.recordFailure('10.0.0.3', t0 + 40), 0);
  assert.equal(limiter.recordFailure('10.0.0.3', t0 + 50), 60);

  // Pool of 3 is full with actively locked IPs: a 4th IP must NOT evict 10.0.0.1 and must trigger global lockout
  assert.ok(limiter.recordFailure('10.0.0.4', t0 + 60) > 0);
  assert.equal(limiter.checkLockoutSeconds('10.0.0.1', t0 + 60), 60);
  assert.equal(limiter.getTrackedIpCount(), 3);
});

test('HTTP server blocks DNS Rebinding, enforces CSRF rules, binds localOnly, and serves CSP', async () => {
  const server = await startServer(54820, makeDummySnapshot(), {}, { localOnly: true });
  try {
    assert.equal(server.localOnly, true);
    assert.equal(server.lanIp, null);
    assert.equal(server.mdnsUrl, null);
    assert.match(server.qrToken, /^[0-9a-f]{32}$/);

    // Valid Host header on localhost
    const okStats = await rawHttpRequest({
      port: server.port,
      reqPath: '/api/stats',
      headers: { Host: `localhost:${server.port}` },
    });
    assert.equal(okStats.status, 200);
    assert.equal(okStats.headers['x-frame-options'], 'DENY');
    assert.equal(okStats.headers['x-content-type-options'], 'nosniff');
    assert.equal(okStats.headers['referrer-policy'], 'no-referrer');

    // DNS Rebinding attempts must fail with 403 even from 127.0.0.1
    for (const badHost of [
      `evil-rebind.example:${server.port}`,
      `attacker.com`,
      `192.168.1.99:${server.port}`,
      `localhost@evil.com:${server.port}`,
    ]) {
      const blockedStats = await rawHttpRequest({
        port: server.port,
        reqPath: '/api/stats',
        headers: { Host: badHost },
      });
      assert.equal(blockedStats.status, 403, `Expected 403 for Host=${badHost}`);

      const blockedExport = await rawHttpRequest({
        port: server.port,
        reqPath: '/api/backup/export',
        headers: { Host: badHost },
      });
      assert.equal(blockedExport.status, 403, `Expected 403 on export for Host=${badHost}`);
    }

    // CSRF checks on POST /api/settings (using malformed JSON '{' so valid requests stop with 400 before writing)
    const missingHeadersPost = await rawHttpRequest({
      port: server.port,
      method: 'POST',
      reqPath: '/api/settings',
      headers: { Host: `localhost:${server.port}`, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(missingHeadersPost.status, 403);

    const evilOriginPost = await rawHttpRequest({
      port: server.port,
      method: 'POST',
      reqPath: '/api/settings',
      headers: {
        Host: `localhost:${server.port}`,
        Origin: 'http://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(evilOriginPost.status, 403);

    const nullOriginPost = await rawHttpRequest({
      port: server.port,
      method: 'POST',
      reqPath: '/api/settings',
      headers: {
        Host: `localhost:${server.port}`,
        Origin: 'null',
        'X-Burnrate-Client': '1',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(nullOriginPost.status, 403);

    const crossSiteFetchPost = await rawHttpRequest({
      port: server.port,
      method: 'POST',
      reqPath: '/api/settings',
      headers: {
        Host: `localhost:${server.port}`,
        Origin: `http://localhost:${server.port}`,
        'Sec-Fetch-Site': 'cross-site',
        'X-Burnrate-Client': '1',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(crossSiteFetchPost.status, 403);

    // Trusted browser POST passes CSRF and reaches JSON validation (400)
    const trustedPost = await rawHttpRequest({
      port: server.port,
      method: 'POST',
      reqPath: '/api/settings',
      headers: {
        Host: `localhost:${server.port}`,
        Origin: `http://localhost:${server.port}`,
        'Sec-Fetch-Site': 'same-origin',
        'X-Burnrate-Client': '1',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(trustedPost.status, 400);

    // CSP header check when built dashboard assets exist
    const builtHtmlPath = path.join(rootDir, 'dist', 'public', 'index.html');
    if (fs.existsSync(builtHtmlPath)) {
      const htmlRes = await rawHttpRequest({
        port: server.port,
        reqPath: '/',
        headers: { Host: `localhost:${server.port}` },
      });
      assert.equal(htmlRes.status, 200);
      const csp = String(htmlRes.headers['content-security-policy'] || '');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self' 'sha256-/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
  } finally {
    await server.close();
  }
});

test('LAN QR token replaces ?code= query auth when LAN interface is present', async () => {
  const server = await startServer(54860, makeDummySnapshot(), {}, { localOnly: false });
  try {
    if (!server.lanIp) return;

    // Attempting old ?code= query login must NOT authenticate
    const legacyCodeRes = await rawHttpRequest({
      host: server.lanIp,
      port: server.port,
      reqPath: `/?code=${encodeURIComponent(server.mobileCode)}`,
      headers: { Host: `${server.lanIp}:${server.port}` },
    });
    assert.equal(legacyCodeRes.status, 401);
    assert.equal(legacyCodeRes.headers['set-cookie'], undefined);

    // Valid ?qr=<qrToken> issues HttpOnly cookie and 303 redirect stripping ?qr=
    const qrRes = await rawHttpRequest({
      host: server.lanIp,
      port: server.port,
      reqPath: `/?qr=${encodeURIComponent(server.qrToken)}`,
      headers: { Host: `${server.lanIp}:${server.port}` },
    });
    assert.equal(qrRes.status, 303);
    assert.equal(qrRes.headers.location, '/');
    const cookieHeader = Array.isArray(qrRes.headers['set-cookie'])
      ? qrRes.headers['set-cookie'][0]
      : String(qrRes.headers['set-cookie'] || '');
    assert.match(cookieHeader, /burnrate_auth=[0-9a-f]+; Path=\/; HttpOnly; SameSite=Lax/);
  } finally {
    await server.close();
  }
});
