// Board store: one JSON file shared by every worktree of the repo.
// All writes go through update(), which takes an exclusive lock and writes atomically.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEMPLATE, lintCard, hasErrors, dependencyProblems } from './ticket.mjs';

export const COLUMNS = ['backlog', 'ready', 'building', 'qa', 'review', 'blocked', 'done'];
// Columns a card reaches by being worked on. Leaving Ready for one of these needs its blockers done.
const WORK_COLUMNS = ['building', 'qa', 'review', 'done'];
// Execution fields a worker or the orchestrator records on a card.
export const RUN_FIELDS = ['branch', 'worktree', 'worker', 'reviewedSha'];

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

// Card order inside a column is the order of board.cards.
export function load(file) {
  let board;
  try {
    board = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyBoard();
    throw err;
  }
  // Cards written by older versions lack the newer fields.
  for (const card of board.cards) {
    card.blockedBy ??= [];
    card.run ??= {};
  }
  return board;
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

function cleanLabels(labels) {
  return [...new Set((labels || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean))];
}

function cleanDeps(board, id, deps) {
  const ids = [...new Set((deps || []).map(Number))];
  if (ids.some((d) => !Number.isInteger(d) || d < 1)) throw new Error('blockedBy must be card ids');
  const problems = dependencyProblems(board, id, ids);
  if (problems.length) throw new Error(`blockedBy: ${problems.join('; ')}`);
  return ids;
}

// Blockers of a card that are not Done yet.
export function unmetDeps(board, card) {
  return card.blockedBy.filter((d) => board.cards.find((c) => c.id === d)?.column !== 'done');
}

// Where a card goes when it leaves Ready: `qa` cards skip Building.
export function route(card) {
  return card.labels.includes('qa') ? 'qa' : 'building';
}

export function addCard(board, { title, body, labels = [], column = 'backlog', blockedBy = [] }) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  checkColumn(column);
  if (column !== 'backlog') throw new Error('new cards start in backlog; move them once they are ready');
  const id = board.nextId;
  const card = {
    id,
    title: String(title).trim(),
    body: body ?? TEMPLATE,
    column,
    labels: cleanLabels(labels),
    blockedBy: cleanDeps(board, id, blockedBy),
    assignee: null,
    run: {},
    comments: [],
    history: [{ at: now(), to: column }],
    createdAt: now(),
    updatedAt: now(),
  };
  board.nextId++;
  board.cards.push(card);
  return card;
}

// patch: { title?, body?, labels?, blockedBy?, run?: { branch?, worktree?, worker?, reviewedSha? } }
// A run field set to null or '' is cleared.
export function editCard(board, id, patch = {}) {
  const card = findCard(board, id);
  if (patch.title !== undefined) {
    if (!String(patch.title).trim()) throw new Error('title cannot be empty');
    card.title = String(patch.title).trim();
  }
  if (patch.body !== undefined) card.body = String(patch.body);
  if (patch.labels !== undefined) card.labels = cleanLabels(patch.labels);
  if (patch.blockedBy !== undefined) card.blockedBy = cleanDeps(board, card.id, patch.blockedBy);
  for (const [key, value] of Object.entries(patch.run || {})) {
    if (!RUN_FIELDS.includes(key)) throw new Error(`unknown run field "${key}" (use: ${RUN_FIELDS.join(', ')})`);
    if (value === null || value === '') delete card.run[key];
    else card.run[key] = String(value);
  }
  card.updatedAt = now();
  return card;
}

// Moves a card to a column, placing it before card `before` (same column) or last.
// Entering Ready requires a card that passes lint; leaving Ready to be worked on requires
// every blocker in Done. `force` skips both checks.
export function moveCard(board, id, column, by = null, { before = null, force = false } = {}) {
  checkColumn(column);
  const card = findCard(board, id);
  if (!force && column !== card.column) {
    if (column === 'ready') {
      const issues = lintCard(card, board).filter((i) => i.severity === 'error');
      if (issues.length) throw new Error(`card #${id} fails lint:\n- ${issues.map((i) => i.message).join('\n- ')}`);
    }
    if (card.column === 'ready' && WORK_COLUMNS.includes(column)) {
      const unmet = unmetDeps(board, card);
      if (unmet.length) throw new Error(`card #${id} is blocked by ${unmet.map((d) => `#${d}`).join(', ')} (not done)`);
    }
  }
  if (before != null) {
    const target = findCard(board, before);
    if (target.column !== column) throw new Error(`card #${before} is not in ${column}`);
    if (target.id === card.id) throw new Error('cannot place a card before itself');
  }

  board.cards.splice(board.cards.indexOf(card), 1);
  board.cards.splice(before != null ? board.cards.findIndex((c) => c.id === Number(before)) : board.cards.length, 0, card);
  if (card.column !== column) {
    card.history.push({ at: now(), from: card.column, to: column, by });
    card.column = column;
  }
  card.updatedAt = now();
  return card;
}

// Ready cards a worker may start now, in board order: unclaimed and with every blocker done.
export function readyQueue(board) {
  return board.cards
    .filter((c) => c.column === 'ready' && !c.assignee && unmetDeps(board, c).length === 0)
    .map((c) => ({ ...c, next: route(c) }));
}

// Board view for the UI and `show`: each card with its lint result and unmet blockers.
export function annotate(board) {
  return {
    ...board,
    cards: board.cards.map((c) => ({ ...c, lint: lintCard(c, board), unmet: unmetDeps(board, c) })),
  };
}

export { lintCard, hasErrors };

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
