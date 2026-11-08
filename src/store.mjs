// Board store: one JSON file shared by every worktree of the repo.
// All writes go through update(), which takes an exclusive lock and writes atomically.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const COLUMNS = ['backlog', 'ready', 'building', 'qa', 'review', 'blocked', 'done'];

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

export function resolveBoardPath(cwd = process.cwd()) {
  if (process.env.FACTORY_BOARD) return path.resolve(process.env.FACTORY_BOARD);
  try {
    // The common dir is shared by all worktrees, so every agent sees the same board.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.join(common, 'factory', 'board.json');
  } catch {
    return path.join(cwd, '.factory', 'board.json');
  }
}

function emptyBoard() {
  return { version: 1, nextId: 1, cards: [] };
}

export function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyBoard();
    throw err;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`board is locked: ${lock}`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Runs mutate(board) under the lock and saves the result. Returns mutate's return value.
export function update(file, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const board = load(file);
    const result = mutate(board);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return result;
  });
}

const now = () => new Date().toISOString();

function findCard(board, id) {
  const card = board.cards.find((c) => c.id === Number(id));
  if (!card) throw new Error(`card #${id} not found`);
  return card;
}

function checkColumn(column) {
  if (!COLUMNS.includes(column)) throw new Error(`unknown column "${column}" (use: ${COLUMNS.join(', ')})`);
}

export function addCard(board, { title, body = '', labels = [], column = 'backlog' }) {
  if (!title) throw new Error('title is required');
  checkColumn(column);
  const card = {
    id: board.nextId++,
    title,
    body,
    column,
    labels,
    assignee: null,
    comments: [],
    history: [{ at: now(), to: column }],
    createdAt: now(),
    updatedAt: now(),
  };
  board.cards.push(card);
  return card;
}

export function moveCard(board, id, column, by = null) {
  checkColumn(column);
  const card = findCard(board, id);
  if (card.column !== column) {
    card.history.push({ at: now(), from: card.column, to: column, by });
    card.column = column;
    card.updatedAt = now();
  }
  return card;
}

export function commentCard(board, id, { role = 'user', text }) {
  if (!text) throw new Error('comment text is required');
  const card = findCard(board, id);
  card.comments.push({ at: now(), role, text });
  card.updatedAt = now();
  return card;
}

// Claim fails if someone else already holds the card, so two workers never take the same one.
export function claimCard(board, id, who) {
  const card = findCard(board, id);
  if (card.assignee && card.assignee !== who) throw new Error(`card #${id} is already claimed by ${card.assignee}`);
  card.assignee = who;
  card.updatedAt = now();
  return card;
}

export function releaseCard(board, id) {
  const card = findCard(board, id);
  card.assignee = null;
  card.updatedAt = now();
  return card;
}

export function getCard(board, id) {
  return findCard(board, id);
}
