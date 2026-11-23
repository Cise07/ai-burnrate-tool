import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Currency, TimeRange, ToolFilter } from '../core/analytics.js';
import {
  createBackupBundle,
  getDefaultBackupFilename,
  importBackupBundle,
  type BackupImportMode,
} from '../core/backup.js';
import { startMdnsResponder } from '../core/mdns.js';
import { scanAllLogs } from '../core/parser.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
import {
  dismissLegacySessions,
  getSessionKey,
  restoreDismissedLegacySessions,
} from '../core/session-ledger.js';
import { loadUserSettings, saveUserSettings } from '../core/settings.js';
import type { BurnrateSnapshot, ToolSource } from '../core/types.js';

export interface LaunchDefaults {
  currency?: Currency;
  toolFilter?: ToolFilter;
  timeRange?: TimeRange;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const AUTH_COOKIE_NAME = 'burnrate_auth';
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCKOUT_MS = 60_000;

function isLocalClient(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::ffff:127.0.0.1' || remote === '::1';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function verifySecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isSameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function getPrimaryLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ address: string; score: number }> = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      const family = String(info.family);
      if (info.internal || (family !== 'IPv4' && family !== '4')) continue;
      if (info.address.startsWith('169.254.')) continue;

      let score = 0;
      if (/wi-fi|wlan|wifi|ethernet|en0|eth/i.test(name)) score += 30;
      if (/vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|tun|tap|tailscale/i.test(name)) {
        score -= 50;
      }
      if (info.address.startsWith('192.168.')) score += 20;
      else if (info.address.startsWith('10.')) score += 10;
      candidates.push({ address: info.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || null;
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 4096): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => finish(''));
  });
}

function renderMobileAuthHtml(errorMessage?: string): string {
  const errBlock = errorMessage
    ? `<p class="err">${escapeHtml(errorMessage)}</p>`
    : '<p class="sub">Enter the 6-digit code shown in your terminal.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ai-burnrate-tool · Mobile Access</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#09090b;color:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif}
  .card{width:100%;max-width:360px;padding:28px 24px;border-radius:18px;background:#111115;border:1px solid #27272a;box-shadow:0 24px 60px rgba(0,0,0,.6)}
  .badge{display:inline-flex;align-items:center;gap:8px;font-family:ui-monospace,monospace;font-size:12px;color:#34d399;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.35);padding:4px 10px;border-radius:999px;margin-bottom:14px}
  h1{font-size:20px;font-weight:700;margin-bottom:6px}
  .sub{font-size:13px;color:#a1a1aa;margin-bottom:18px;line-height:1.45}
  .err{font-size:13px;color:#fb7185;margin-bottom:18px;line-height:1.45}
  input{width:100%;height:50px;border-radius:12px;background:#09090b;border:1px solid #3f3f46;color:#fff;font-family:ui-monospace,monospace;font-size:24px;letter-spacing:.32em;text-align:center;outline:none;margin-bottom:12px}
  input:focus{border-color:#10b981}
  button{width:100%;height:46px;border:0;border-radius:12px;background:#10b981;color:#052e16;font-weight:700;font-size:14px;cursor:pointer}
  button:active{opacity:.9}
</style>
</head>
<body>
  <form class="card" method="POST" action="/__auth">
    <div class="badge">● AI-BURNRATE-TOOL LAN</div>
    <h1>Mobile Access</h1>
    ${errBlock}
    <input name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000" autofocus required />
    <button type="submit">Unlock Dashboard</button>
  </form>
</body>
</html>`;
}

export async function findFreePort(startPort = 4321, maxAttempts = 25): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const isFree = await new Promise<boolean>((resolve) => {
      const tester = net
        .createServer()
        .once('error', () => resolve(false))
        .once('listening', () => {
          tester.close(() => resolve(true));
        })
        .listen(port, '0.0.0.0');
    });
    if (isFree) return port;
  }
  throw new Error(`Could not find a free port starting from ${startPort}`);
}

export interface BurnrateServer {
  port: number;
  url: string;
  lanIp: string | null;
  lanUrl: string | null;
  mdnsHostname: string | null;
  mdnsUrl: string | null;
  mobileCode: string;
  broadcast: (snapshot: BurnrateSnapshot, changedPath?: string) => void;
  close: () => Promise<void>;
}

export async function startServer(
  preferredPort: number,
  initialSnapshot: BurnrateSnapshot,
  launchDefaults: LaunchDefaults = {}
): Promise<BurnrateServer> {
  const port = await findFreePort(preferredPort);
  const lanIp = getPrimaryLanIp();
  const mobileCode = String(crypto.randomInt(100000, 1000000));
  const authSessionToken = crypto.randomBytes(24).toString('hex');
  let currentSnapshot = initialSnapshot;

  const sseClients = new Set<http.ServerResponse>();
  const sockets = new Set<net.Socket>();
  const failedAuthByIp = new Map<string, { failures: number; blockedUntil: number }>();
  const publicDir = path.resolve(getPackageRoot(), 'dist', 'public');

  const sendSsePayload = (res: http.ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const broadcast = (snapshot: BurnrateSnapshot, changedPath?: string) => {
    currentSnapshot = snapshot;
    const payload = {
      snapshot,
      changedPath: changedPath || null,
      timestamp: new Date().toISOString(),
    };
    for (const client of sseClients) {
      sendSsePayload(client, 'update', payload);
    }
  };

  const heartbeatInterval = setInterval(() => {
    for (const client of sseClients) {
      client.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 15000);

  const authHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  };

  const checkLockoutSeconds = (clientIp: string): number => {
    const entry = failedAuthByIp.get(clientIp);
    if (!entry) return 0;
    const remainingMs = entry.blockedUntil - Date.now();
    if (remainingMs <= 0) {
      if (entry.blockedUntil > 0) failedAuthByIp.delete(clientIp);
      return 0;
    }
    return Math.ceil(remainingMs / 1000);
  };

  const recordFailedAuth = (clientIp: string): number => {
    if (failedAuthByIp.size >= 512) {
      const oldestKey = failedAuthByIp.keys().next().value;
      if (oldestKey) failedAuthByIp.delete(oldestKey);
    }
    const prev = failedAuthByIp.get(clientIp) ?? { failures: 0, blockedUntil: 0 };
    const failures = prev.failures + 1;
    if (failures >= MAX_AUTH_FAILURES) {
      failedAuthByIp.set(clientIp, { failures: 0, blockedUntil: Date.now() + AUTH_LOCKOUT_MS });
      return Math.ceil(AUTH_LOCKOUT_MS / 1000);
    }
    failedAuthByIp.set(clientIp, { failures, blockedUntil: 0 });
    return 0;
  };

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    void (async () => {
      try {
        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        const pathname = reqUrl.pathname;

        if (!isLocalClient(req)) {
          const clientIp = req.socket.remoteAddress || 'unknown';
          const cookies = parseCookies(req.headers.cookie);
          const isAuthed = Boolean(
            cookies[AUTH_COOKIE_NAME] && verifySecret(cookies[AUTH_COOKIE_NAME], authSessionToken)
          );
          const setAuthCookie = () => {
            failedAuthByIp.delete(clientIp);
            res.setHeader(
              'Set-Cookie',
              `${AUTH_COOKIE_NAME}=${authSessionToken}; Path=/; HttpOnly; SameSite=Lax`
            );
          };

          const handleCodeAttempt = async (candidate: string, onSuccessRedirect: string) => {
            const lockedSec = checkLockoutSeconds(clientIp);
            if (lockedSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(lockedSec) });
              res.end(renderMobileAuthHtml(`Too many failed attempts. Try again in ${lockedSec} seconds.`));
              return;
            }
            if (verifySecret(candidate, mobileCode)) {
              setAuthCookie();
              res.writeHead(302, { Location: onSuccessRedirect });
              res.end();
              return;
            }
            const newLockSec = recordFailedAuth(clientIp);
            await new Promise((r) => setTimeout(r, 400));
            if (newLockSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(newLockSec) });
              res.end(renderMobileAuthHtml(`Too many failed attempts. Try again in ${newLockSec} seconds.`));
            } else {
              res.writeHead(401, authHeaders);
              res.end(renderMobileAuthHtml('Invalid code. Check the 6-digit code in your terminal.'));
            }
          };

          if (pathname === '/__auth' && req.method === 'POST') {
            if (!isSameOriginRequest(req)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Forbidden');
              return;
            }
            const rawBody = await readRequestBody(req);
            if (rawBody === null) {
              res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Payload Too Large');
              return;
            }
            const form = new URLSearchParams(rawBody);
            await handleCodeAttempt(form.get('code') || '', '/');
            return;
          }

          const queryCode = reqUrl.searchParams.get('code');
          if (queryCode !== null) {
            reqUrl.searchParams.delete('code');
            const qs = reqUrl.searchParams.toString();
            const safePath = '/' + pathname.replace(/^\/+/, '');
            await handleCodeAttempt(queryCode, `${safePath}${qs ? `?${qs}` : ''}`);
            return;
          }

          if (!isAuthed) {
            if (pathname.startsWith('/api/')) {
              res.writeHead(401, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              });
              res.end(JSON.stringify({ error: 'Access code required' }));
              return;
            }
            const lockedSec = checkLockoutSeconds(clientIp);
            if (lockedSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(lockedSec) });
              res.end(renderMobileAuthHtml(`Troppi tentativi errati. Riprova tra ${lockedSec} secondi.`));
              return;
            }
            res.writeHead(401, authHeaders);
            res.end(renderMobileAuthHtml());
            return;
          }
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (pathname === '/api/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          sseClients.add(res);
          sendSsePayload(res, 'init', {
            snapshot: currentSnapshot,
            changedPath: null,
            timestamp: new Date().toISOString(),
          });

          const cleanup = () => sseClients.delete(res);
          req.on('close', cleanup);
          res.on('error', cleanup);
          return;
        }

        if (pathname === '/api/defaults' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify(launchDefaults));
          return;
        }

        if (pathname === '/api/stats' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify(currentSnapshot));
          return;
        }

        if (pathname === '/api/rescan' && req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          void syncOfficialPricing({ force: true })
            .catch(() => undefined)
            .finally(() => {
              try {
                const fresh = scanAllLogs(true);
                broadcast(fresh);
                if (res.writableEnded || res.destroyed) return;
                res.writeHead(200, {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Cache-Control': 'no-store, no-cache, must-revalidate',
                });
                res.end(JSON.stringify(fresh));
              } catch {
                if (res.writableEnded || res.destroyed) return;
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Rescan failed' }));
              }
            });
          return;
        }

        if (pathname === '/api/deleted-legacy/dismiss' && req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          const rawBody = await readRequestBody(req, 64 * 1024);
          if (rawBody === null) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            return;
          }
          let parsed: { items?: unknown };
          try {
            parsed = JSON.parse(rawBody) as { items?: unknown };
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          if (!Array.isArray(parsed.items) || parsed.items.length === 0 || parsed.items.length > 2000) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Expected non-empty items array' }));
            return;
          }

          const trackedKeys = new Set<string>();
          for (const s of currentSnapshot.sessions) {
            trackedKeys.add(getSessionKey(s.source, s.sessionId));
          }
          for (const s of currentSnapshot.deletedSessions || []) {
            if (!s.untrackedHistory) {
              trackedKeys.add(getSessionKey(s.source, s.sessionId));
            }
          }

          const VALID_SOURCES = new Set<ToolSource>(['antigravity', 'claude', 'codex']);
          const keysToDismiss: string[] = [];
          for (const item of parsed.items) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as { source?: unknown; sessionId?: unknown };
            if (typeof rec.source !== 'string' || !VALID_SOURCES.has(rec.source as ToolSource)) continue;
            if (typeof rec.sessionId !== 'string') continue;
            const sessionId = rec.sessionId.trim();
            if (!sessionId || sessionId.length > 256 || /[\r\n\0]/.test(sessionId)) continue;
            const key = getSessionKey(rec.source as ToolSource, sessionId);
            if (trackedKeys.has(key)) continue;
            keysToDismiss.push(key);
          }

          const dismissedCount = dismissLegacySessions(keysToDismiss);
          const fresh = scanAllLogs(false);
          broadcast(fresh);
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify({ dismissedCount, snapshot: fresh }));
          return;
        }

        if (pathname === '/api/deleted-legacy/restore' && req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          const restoredCount = restoreDismissedLegacySessions();
          const fresh = scanAllLogs(false);
          broadcast(fresh);
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify({ restoredCount, snapshot: fresh }));
          return;
        }

        if (pathname === '/api/settings' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify(loadUserSettings()));
          return;
        }

        if (pathname === '/api/settings' && req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          const rawBody = await readRequestBody(req, 16 * 1024);
          if (rawBody === null) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          const saved = saveUserSettings(parsed);
          const updatedSnapshot: BurnrateSnapshot = { ...currentSnapshot, settings: saved };
          broadcast(updatedSnapshot);
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify({ settings: saved, snapshot: updatedSnapshot }));
          return;
        }

        if (pathname === '/api/backup/export' && req.method === 'GET') {
          try {
            const bundle = createBackupBundle();
            const filename = getDefaultBackupFilename(new Date(bundle.exportedAt));
            const payload = JSON.stringify(bundle, null, 2);
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            });
            res.end(payload);
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Failed to export backup bundle' }));
          }
          return;
        }

        if (pathname === '/api/backup/import' && req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          const rawBody = await readRequestBody(req, 25 * 1024 * 1024);
          if (rawBody === null) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Backup payload exceeds 25 MB limit' }));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }

          const queryMode = reqUrl.searchParams.get('mode');
          let mode: BackupImportMode = queryMode === 'replace' ? 'replace' : 'merge';
          let bundlePayload: unknown = parsed;
          if (
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            'backup' in (parsed as Record<string, unknown>)
          ) {
            const wrapper = parsed as { mode?: unknown; backup?: unknown };
            if (wrapper.mode === 'replace') mode = 'replace';
            else if (wrapper.mode === 'merge') mode = 'merge';
            bundlePayload = wrapper.backup;
          }

          try {
            const result = importBackupBundle(bundlePayload, { mode });
            const fresh = scanAllLogs(true);
            broadcast(fresh, 'backup-import');
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            });
            res.end(JSON.stringify({ result, snapshot: fresh }));
          } catch (err) {
            if (res.writableEnded || res.destroyed) return;
            const message = err instanceof Error ? err.message : 'Failed to import backup';
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(pathname);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad Request');
          return;
        }

        const relTarget = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
        let filePath = path.resolve(publicDir, relTarget);
        const relCheck = path.relative(publicDir, filePath);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = path.join(publicDir, 'index.html');
        }

        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const headers: Record<string, string> = { 'Content-Type': contentType };
          if (ext === '.html') {
            headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
          }
          res.writeHead(200, headers);
          const stream = fs.createReadStream(filePath);
          stream.on('error', () => {
            if (!res.writableEnded) res.destroy();
          });
          stream.pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Dashboard assets not found. Run `npm run build` first.');
        }
      } catch {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad Request');
        } else if (!res.destroyed) {
          res.destroy();
        }
      }
    })();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  const mdns = lanIp ? await startMdnsResponder('ai-burnrate.local', lanIp) : null;

  return {
    port,
    url: `http://localhost:${port}`,
    lanIp,
    lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
    mdnsHostname: mdns ? mdns.hostname : null,
    mdnsUrl: mdns ? `http://${mdns.hostname}:${port}` : null,
    mobileCode,
    broadcast,
    close: async () => {
      clearInterval(heartbeatInterval);
      if (mdns) {
        try {
          await mdns.close();
        } catch {
          // ignore
        }
      }
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
