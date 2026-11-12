// Local web board: serves public/index.html, a small JSON API, and a server-sent
// events stream that fires whenever the board file changes (from the CLI, an agent or the UI).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as store from './store.mjs';
import { TEMPLATE } from './ticket.mjs';
import { loadConfig, DEFAULTS } from './config.mjs';
import { lensesFor } from './lanes.mjs';

// The project config, for the review lenses shown on cards. A broken config must not take the board down.
function configOf(repoRoot) {
  try {
    return loadConfig(repoRoot).config;
  } catch {
    return DEFAULTS;
  }
}

// The board for the web: each card also says which lenses its panel needs (light or full).
function boardView(boardFile, repoRoot) {
  const config = configOf(repoRoot);
  const board = store.annotate(store.load(boardFile));
  return { columns: store.COLUMNS, lenses: config.review.lenses, ...board, cards: board.cards.map((c) => ({ ...c, lenses: lensesFor(c, config) })) };
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'factory.mjs');

// A person approving a merge from the web. Runs the CLI's gate in a child process: verify can take
// minutes and must not freeze the server.
function runMerge({ boardFile, repoRoot, id, sha }) {
  return new Promise((resolve) => {
    const args = [CLI, 'merge', String(id), '--human', '--as', 'user', '--json', ...(sha ? ['--sha', sha] : [])];
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: { ...process.env, FACTORY_BOARD: boardFile } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ status: 'error', message: out.trim() || 'merge produced no output' });
      }
    });
  });
}
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

export function createServer({ boardFile, repoRoot = process.cwd() }) {
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
        return send(res, 200, boardView(boardFile, repoRoot));
      }
      if (req.method === 'GET' && url.pathname === '/api/template') {
        return send(res, 200, { template: TEMPLATE });
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
        let m = url.pathname.match(/^\/api\/cards\/(\d+)$/);
        if (m) {
          const { title, body: text, labels, blockedBy } = body;
          return send(res, 200, store.update(boardFile, (b) => store.editCard(b, m[1], { title, body: text, labels, blockedBy })));
        }
        m = url.pathname.match(/^\/api\/cards\/(\d+)\/move$/);
        if (m) {
          const { column, before = null, force = false } = body;
          return send(res, 200, store.update(boardFile, (b) => store.moveCard(b, m[1], column, 'user', { before, force: force === true })));
        }
        m = url.pathname.match(/^\/api\/cards\/(\d+)\/approve$/);
        if (m) {
          const card = store.getCard(store.load(boardFile), m[1]);
          if (!card.labels.includes('merge-approval') || !card.run.branch) throw new Error(`card #${m[1]} is not waiting for a merge approval`);
          return send(res, 200, await runMerge({ boardFile, repoRoot, id: m[1], sha: body.sha }));
        }
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
