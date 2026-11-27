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
import { getHooksStatus, installAutoArchiveHooks } from '../core/hooks.js';
import { startMdnsResponder } from '../core/mdns.js';
import { scanAllLogs } from '../core/parser.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
import { defaultQuotaEngine } from '../core/quota/engine.js';
import type { ProviderId } from '../core/quota/types.js';
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
const MAX_GLOBAL_AUTH_FAILURES = 25;
const AUTH_LOCKOUT_MS = 60_000;

function normalizeHostname(rawHost: string): string {
  return rawHost.trim().toLowerCase().replace(/\.$/, '');
}

function addIpv6HostVariants(hosts: Set<string>, rawAddress: string): void {
  const bare = rawAddress.split('%')[0]?.trim().toLowerCase();
  if (!bare) return;
  hosts.add(bare);
  hosts.add(`[${bare}]`);
}

function buildAllowedHostnames(localOnly: boolean): Set<string> {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (localOnly) {
    return hosts;
  }

  hosts.add('ai-burnrate.local');
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      if (info.internal) continue;
      const addr = info.address.split('%')[0]?.trim().toLowerCase();
      if (!addr) continue;
      if (String(info.family) === 'IPv6' || String(info.family) === '6' || addr.includes(':')) {
        addIpv6HostVariants(hosts, addr);
      } else {
        hosts.add(addr);
      }
    }
  }
  return hosts;
}

function extractHostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== 'string') return null;
  const trimmed = hostHeader.trim();
  if (!trimmed || trimmed.length > 255) return null;
  if (/[\s\x00-\x1f\x7f@/?#\\]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function isAllowedHostHeader(hostHeader: string | undefined, localOnly: boolean): boolean {
  const hostname = extractHostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  return buildAllowedHostnames(localOnly).has(hostname);
}

function isAllowedOriginHeader(originHeader: string, localOnly: boolean): boolean {
  if (!originHeader || originHeader === 'null') return false;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return buildAllowedHostnames(localOnly).has(hostname);
  } catch {
    return false;
  }
}

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

function isTrustedApiPostRequest(req: http.IncomingMessage, localOnly: boolean): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    return isAllowedOriginHeader(origin, localOnly);
  }

  // Reject header-less cross-site POSTs unless explicitly marked by our client or same-origin Fetch metadata
  return req.headers['x-burnrate-client'] === '1' || secFetchSite === 'same-origin';
}

function isTrustedAuthFormPost(req: http.IncomingMessage, localOnly: boolean): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    return isAllowedOriginHeader(origin, localOnly);
  }

  return true;
}

function computeDashboardCsp(htmlFilePath: string): string {
  const scriptHashes: string[] = [];
  try {
    const html = fs.readFileSync(htmlFilePath, 'utf-8');
    const inlineScriptRe = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = inlineScriptRe.exec(html)) !== null) {
      const body = match[1];
      if (!body.trim()) continue;
      const digest = crypto.createHash('sha256').update(body, 'utf-8').digest('base64');
      scriptHashes.push(`'sha256-${digest}'`);
    }
  } catch {
    // Fallback without inline hashes if index.html is unavailable
  }

  const scriptSrc = scriptHashes.length > 0 ? `'self' ${scriptHashes.join(' ')}` : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
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

export interface AuthRateLimiter {
  checkLockoutSeconds: (clientIp: string, now?: number) => number;
  recordFailure: (clientIp: string, now?: number) => number;
  clearIp: (clientIp: string) => void;
  getTrackedIpCount: () => number;
}

export function createAuthRateLimiter(options: {
  maxIpFailures?: number;
  maxGlobalFailures?: number;
  lockoutMs?: number;
  windowMs?: number;
  maxTrackedIps?: number;
} = {}): AuthRateLimiter {
  const maxIpFailures = options.maxIpFailures ?? MAX_AUTH_FAILURES;
  const maxGlobalFailures = options.maxGlobalFailures ?? MAX_GLOBAL_AUTH_FAILURES;
  const lockoutMs = options.lockoutMs ?? AUTH_LOCKOUT_MS;
  const windowMs = options.windowMs ?? 60_000;
  const maxTrackedIps = options.maxTrackedIps ?? 512;

  const failedByIp = new Map<string, { failures: number; blockedUntil: number }>();
  let globalFailures = 0;
  let globalWindowStart = 0;
  let globalBlockedUntil = 0;

  return {
    checkLockoutSeconds(clientIp: string, now = Date.now()): number {
      const globalRemainingMs = globalBlockedUntil > now ? globalBlockedUntil - now : 0;
      const entry = failedByIp.get(clientIp);
      let ipRemainingMs = 0;
      if (entry) {
        if (entry.blockedUntil > now) {
          ipRemainingMs = entry.blockedUntil - now;
        } else if (entry.blockedUntil > 0) {
          failedByIp.delete(clientIp);
        }
      }
      const maxRemainingMs = Math.max(ipRemainingMs, globalRemainingMs);
      return maxRemainingMs > 0 ? Math.ceil(maxRemainingMs / 1000) : 0;
    },
    recordFailure(clientIp: string, now = Date.now()): number {
      if (now - globalWindowStart > windowMs) {
        globalWindowStart = now;
        globalFailures = 0;
      }
      globalFailures++;
      if (globalFailures >= maxGlobalFailures) {
        globalBlockedUntil = Math.max(globalBlockedUntil, now + lockoutMs);
        globalFailures = 0;
      }

      // Reclaim expired entries first; never evict an actively locked attacker IP
      for (const [key, value] of failedByIp.entries()) {
        if (value.blockedUntil > 0 && value.blockedUntil <= now) {
          failedByIp.delete(key);
        }
      }

      if (!failedByIp.has(clientIp) && failedByIp.size >= maxTrackedIps) {
        let reclaimed = false;
        for (const [key, value] of failedByIp.entries()) {
          if (value.blockedUntil <= now) {
            failedByIp.delete(key);
            reclaimed = true;
            break;
          }
        }
        if (!reclaimed) {
          globalBlockedUntil = Math.max(globalBlockedUntil, now + lockoutMs);
          return Math.ceil((globalBlockedUntil - now) / 1000);
        }
      }

      const prev = failedByIp.get(clientIp) ?? { failures: 0, blockedUntil: 0 };
      const failures = prev.failures + 1;
      if (failures >= maxIpFailures) {
        failedByIp.set(clientIp, { failures: 0, blockedUntil: now + lockoutMs });
        return Math.ceil(Math.max(lockoutMs, globalBlockedUntil - now) / 1000);
      }
      failedByIp.set(clientIp, { failures, blockedUntil: 0 });
      return globalBlockedUntil > now ? Math.ceil((globalBlockedUntil - now) / 1000) : 0;
    },
    clearIp(clientIp: string): void {
      failedByIp.delete(clientIp);
    },
    getTrackedIpCount(): number {
      return failedByIp.size;
    },
  };
}

export async function findFreePort(
  startPort = 4321,
  maxAttempts = 25,
  bindHost = '0.0.0.0'
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const isFree = await new Promise<boolean>((resolve) => {
      const tester = net
        .createServer()
        .once('error', () => resolve(false))
        .once('listening', () => {
          tester.close(() => resolve(true));
        })
        .listen(port, bindHost);
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
  qrToken: string;
  localOnly: boolean;
  broadcast: (snapshot: BurnrateSnapshot, changedPath?: string) => void;
  close: () => Promise<void>;
}

export async function startServer(
  preferredPort: number,
  initialSnapshot: BurnrateSnapshot,
  launchDefaults: LaunchDefaults = {},
  options: { localOnly?: boolean } = {}
): Promise<BurnrateServer> {
  const localOnly = Boolean(options.localOnly);
  const bindHost = localOnly ? '127.0.0.1' : '0.0.0.0';
  const port = await findFreePort(preferredPort, 25, bindHost);
  const lanIp = localOnly ? null : getPrimaryLanIp();
  const mobileCode = String(crypto.randomInt(100000, 1000000));
  const qrToken = crypto.randomBytes(16).toString('hex');
  const authSessionToken = crypto.randomBytes(24).toString('hex');
  const withFreshQuotas = (snap: BurnrateSnapshot): BurnrateSnapshot => {
    const serverNowMs = Date.now();
    return {
      ...snap,
      serverNowMs,
      quotas: defaultQuotaEngine.getCachedQuotas(serverNowMs),
    };
  };

  let currentSnapshot = withFreshQuotas(initialSnapshot);

  const sseClients = new Set<http.ServerResponse>();
  const sockets = new Set<net.Socket>();
  const authLimiter = createAuthRateLimiter();
  const publicDir = path.resolve(getPackageRoot(), 'dist', 'public');
  let cachedCspMtimeMs = -1;
  let cachedDashboardCsp = computeDashboardCsp(path.join(publicDir, 'index.html'));

  const getDashboardCsp = (htmlPath: string): string => {
    try {
      const mtimeMs = fs.statSync(htmlPath).mtimeMs;
      if (mtimeMs !== cachedCspMtimeMs) {
        cachedDashboardCsp = computeDashboardCsp(htmlPath);
        cachedCspMtimeMs = mtimeMs;
      }
    } catch {
      // Keep last computed CSP fallback
    }
    return cachedDashboardCsp;
  };

  const sendSsePayload = (res: http.ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const broadcast = (snapshot: BurnrateSnapshot, changedPath?: string) => {
    const fresh = withFreshQuotas(snapshot);
    currentSnapshot = fresh;
    const payload = {
      snapshot: fresh,
      changedPath: changedPath || null,
      timestamp: new Date(fresh.serverNowMs ?? Date.now()).toISOString(),
    };
    for (const client of sseClients) {
      sendSsePayload(client, 'update', payload);
    }
  };

  if (loadUserSettings().experimentalQuota !== false) {
    defaultQuotaEngine.startLiveSync({
      onUpdate: (_quotas, reason) => {
        broadcast(currentSnapshot, reason);
      },
    });
  }

  const heartbeatInterval = setInterval(() => {
    for (const client of sseClients) {
      client.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 15000);

  const authHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  };

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (!isAllowedHostHeader(req.headers.host, localOnly)) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Forbidden: Invalid Host header');
      return;
    }

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
            authLimiter.clearIp(clientIp);
            res.setHeader(
              'Set-Cookie',
              `${AUTH_COOKIE_NAME}=${authSessionToken}; Path=/; HttpOnly; SameSite=Lax`
            );
          };

          const handleSecretAttempt = async (
            candidate: string,
            expected: string,
            onSuccessRedirect: string,
            invalidMessage: string
          ) => {
            const lockedSec = authLimiter.checkLockoutSeconds(clientIp);
            if (lockedSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(lockedSec) });
              res.end(renderMobileAuthHtml(`Too many failed attempts. Try again in ${lockedSec} seconds.`));
              return;
            }
            if (verifySecret(candidate, expected)) {
              setAuthCookie();
              res.writeHead(303, {
                Location: onSuccessRedirect,
                'Cache-Control': 'no-store',
              });
              res.end();
              return;
            }
            const newLockSec = authLimiter.recordFailure(clientIp);
            await new Promise((r) => setTimeout(r, 400));
            if (newLockSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(newLockSec) });
              res.end(renderMobileAuthHtml(`Too many failed attempts. Try again in ${newLockSec} seconds.`));
            } else {
              res.writeHead(401, authHeaders);
              res.end(renderMobileAuthHtml(invalidMessage));
            }
          };

          if (pathname === '/__auth' && req.method === 'POST') {
            if (!isTrustedAuthFormPost(req, localOnly)) {
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
            await handleSecretAttempt(
              form.get('code') || '',
              mobileCode,
              '/',
              'Invalid code. Check the 6-digit code in your terminal.'
            );
            return;
          }

          const queryQr = reqUrl.searchParams.get('qr');
          if (queryQr !== null) {
            reqUrl.searchParams.delete('qr');
            const qs = reqUrl.searchParams.toString();
            const safePath = '/' + pathname.replace(/^\/+/, '');
            await handleSecretAttempt(
              queryQr,
              qrToken,
              `${safePath}${qs ? `?${qs}` : ''}`,
              'Invalid QR access token. Rescan the terminal QR code or enter the 6-digit code.'
            );
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
            const lockedSec = authLimiter.checkLockoutSeconds(clientIp);
            if (lockedSec > 0) {
              res.writeHead(429, { ...authHeaders, 'Retry-After': String(lockedSec) });
              res.end(renderMobileAuthHtml(`Too many failed attempts. Try again in ${lockedSec} seconds.`));
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
          const initSnap = withFreshQuotas(currentSnapshot);
          currentSnapshot = initSnap;
          sendSsePayload(res, 'init', {
            snapshot: initSnap,
            changedPath: null,
            timestamp: new Date(initSnap.serverNowMs ?? Date.now()).toISOString(),
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
          const fresh = withFreshQuotas(currentSnapshot);
          currentSnapshot = fresh;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify(fresh));
          return;
        }

        if (pathname === '/api/rescan' && req.method === 'POST') {
          if (!isTrustedApiPostRequest(req, localOnly)) {
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
          if (!isTrustedApiPostRequest(req, localOnly)) {
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
          if (!isTrustedApiPostRequest(req, localOnly)) {
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
          if (!isTrustedApiPostRequest(req, localOnly)) {
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
          installAutoArchiveHooks();
          if (saved.experimentalQuota !== false) {
            defaultQuotaEngine.startLiveSync({
              onUpdate: (_quotas, reason) => {
                broadcast(currentSnapshot, reason);
              },
            });
            void defaultQuotaEngine
              .refreshAll({ force: false, reason: 'settings-enable' })
              .then(() => broadcast(currentSnapshot, 'quota-sync'))
              .catch(() => undefined);
          } else {
            defaultQuotaEngine.stopLiveSync();
          }
          const updatedSnapshot: BurnrateSnapshot = withFreshQuotas({
            ...currentSnapshot,
            settings: saved,
            hooksStatus: getHooksStatus(),
          });
          broadcast(updatedSnapshot);
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify({ settings: saved, snapshot: updatedSnapshot }));
          return;
        }

        if (pathname === '/api/quota/refresh' && req.method === 'POST') {
          if (!isTrustedApiPostRequest(req, localOnly)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
          const rawBody = await readRequestBody(req, 4 * 1024);
          if (rawBody === null) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            return;
          }
          let provider: ProviderId | undefined;
          if (rawBody.trim()) {
            try {
              const parsed = JSON.parse(rawBody) as { provider?: unknown };
              if (
                parsed?.provider === 'antigravity' ||
                parsed?.provider === 'claude' ||
                parsed?.provider === 'codex'
              ) {
                provider = parsed.provider;
              }
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              return;
            }
          }

          await defaultQuotaEngine.refreshAll({ force: true, reason: 'manual', provider });
          const updatedSnapshot = withFreshQuotas(currentSnapshot);
          broadcast(updatedSnapshot, 'quota-refresh');
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(
            JSON.stringify({
              serverNowMs: updatedSnapshot.serverNowMs,
              quotas: updatedSnapshot.quotas,
              snapshot: updatedSnapshot,
            })
          );
          return;
        }

        if (pathname === '/api/quota/debug' && req.method === 'GET') {
          const force = reqUrl.searchParams.get('force') === '1';
          const entries = await defaultQuotaEngine.collectDiagnostics({ force });
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(JSON.stringify({ serverNowMs: Date.now(), entries }));
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
          if (!isTrustedApiPostRequest(req, localOnly)) {
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
            headers['Content-Security-Policy'] = getDashboardCsp(filePath);
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
    server.listen(port, bindHost, () => resolve());
  });

  const mdns = !localOnly && lanIp ? await startMdnsResponder('ai-burnrate.local', lanIp) : null;

  return {
    port,
    url: `http://localhost:${port}`,
    lanIp,
    lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
    mdnsHostname: mdns ? mdns.hostname : null,
    mdnsUrl: mdns ? `http://${mdns.hostname}:${port}` : null,
    mobileCode,
    qrToken,
    localOnly,
    broadcast,
    close: async () => {
      defaultQuotaEngine.stopLiveSync();
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
