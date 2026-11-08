// Local web board: serves public/index.html, a small JSON API, and a server-sent
// events stream that fires whenever the board file changes (from the CLI, an agent or the UI).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ boardFile }) {
  const clients = new Set();
  let timer = null;

  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  // Watch the directory: the file itself is replaced on every write (atomic rename).
  const watcher = fs.watch(path.dirname(boardFile), (_event, name) => {
    if (name && name !== path.basename(boardFile)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of clients) res.write('event: change\ndata: {}\n\n');
    }, 50);
  });

  const server = http.createServer(async (req, res) => {
    // Reject other hostnames (DNS rebinding) and non-JSON writes (cross-site form posts).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: 'forbidden host' });

    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        return send(res, 200, { columns: store.COLUMNS, ...store.load(boardFile) });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(res, 415, { error: 'expected application/json' });
        }
        const body = await readJson(req);
        if (url.pathname === '/api/cards') {
          return send(res, 201, store.update(boardFile, (b) => store.addCard(b, body)));
        }
        let m = url.pathname.match(/^\/api\/cards\/(\d+)\/move$/);
        if (m) return send(res, 200, store.update(boardFile, (b) => store.moveCard(b, m[1], body.column, 'user')));
        m = url.pathname.match(/^\/api\/cards\/(\d+)\/comments$/);
        if (m) return send(res, 200, store.update(boardFile, (b) => store.commentCard(b, m[1], { role: 'user', text: body.text })));
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });

  server.on('close', () => {
    watcher.close();
    for (const res of clients) res.end();
  });
  return server;
}
