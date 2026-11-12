import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { scanAllLogs } from '../core/parser.js';
import { getPackageRoot, syncOfficialPricing } from '../core/pricing.js';
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};
export async function findFreePort(startPort = 4321, maxAttempts = 25) {
    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i;
        const isFree = await new Promise((resolve) => {
            const tester = net
                .createServer()
                .once('error', () => resolve(false))
                .once('listening', () => {
                tester.close(() => resolve(true));
            })
                .listen(port, '127.0.0.1');
        });
        if (isFree)
            return port;
    }
    throw new Error(`Could not find a free port starting from ${startPort}`);
}
export async function startServer(preferredPort, initialSnapshot) {
    const port = await findFreePort(preferredPort);
    let currentSnapshot = initialSnapshot;
    const sseClients = new Set();
    const sockets = new Set();
    const publicDir = path.join(getPackageRoot(), 'dist', 'public');
    const sendSsePayload = (res, event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const broadcast = (snapshot, changedPath) => {
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
    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        const pathname = reqUrl.pathname;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
            req.on('close', () => {
                sseClients.delete(res);
            });
            return;
        }
        if (pathname === '/api/stats' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(currentSnapshot));
            return;
        }
        if (pathname === '/api/rescan' && req.method === 'POST') {
            void syncOfficialPricing().finally(() => {
                const fresh = scanAllLogs(true);
                broadcast(fresh);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(fresh));
            });
            return;
        }
        let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
        if (!filePath.startsWith(publicDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(publicDir, 'index.html');
        }
        if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        }
        else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Dashboard assets not found. Run `npm run build` first.');
        }
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    return {
        port,
        url: `http://localhost:${port}`,
        broadcast,
        close: async () => {
            clearInterval(heartbeatInterval);
            for (const client of sseClients) {
                try {
                    client.end();
                }
                catch {
                    // ignore
                }
            }
            sseClients.clear();
            for (const socket of sockets) {
                try {
                    socket.destroy();
                }
                catch {
                    // ignore
                }
            }
            sockets.clear();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
