// Board store: one JSON file shared by every worktree of the repo.
// All writes go through update(), which takes an exclusive lock and writes atomically.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEMPLATE, lintCard, hasErrors, dependencyProblems } from './ticket.mjs';

// spec: rough ideas waiting for the spec writer, who turns them into cards that pass lint.
export const COLUMNS = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'blocked', 'done'];
// Columns a new card may be filed in. Ready still requires a card that passes lint.
const ENTRY_COLUMNS = ['backlog', 'spec', 'ready'];
// Labels that mean "this card waits for the user" while it sits in blocked: needs-you for any
// request, merge-approval for a merge the gate held (the only one that can be approved).
export const REQUEST_LABELS = ['needs-you', 'merge-approval'];
// Columns a card reaches by being worked on. Leaving Ready for one of these needs its blockers done.
const WORK_COLUMNS = ['building', 'qa', 'review', 'done'];
// Execution fields a worker or the orchestrator records on a card.
export const RUN_FIELDS = ['branch', 'worktree', 'worker', 'reviewedSha', 'mergedSha', 'dispatch', 'pr'];

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
    card.source ??= null;
    card.panel ??= emptyPanel();
  }
  return board;
}

// The review panel of a card in review: the head under review and one slot per lens,
// { worker, claimedAt, dispatch, worktree, verdict: 'pass'|'fail', sha, at, failedDispatches }.
export function emptyPanel() {
  return { head: null, lenses: {} };
}

// A new round (the card re-enters review): verdicts and claims go, each lens keeps its worktree.
function resetPanel(card) {
  const lenses = {};
  for (const [lens, slot] of Object.entries(card.panel?.lenses || {})) if (slot.worktree) lenses[lens] = { worktree: slot.worktree };
  card.panel = { head: null, lenses };
}

function clearLensClaims(card) {
  for (const slot of Object.values(card.panel?.lenses || {})) {
    slot.worker = null;
    slot.claimedAt = null;
    delete slot.dispatch;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive lock: a directory, since mkdir is atomic on every platform. A lock older than
// staleMs is assumed abandoned (its holder crashed) and taken over.
export function withLock(lock, fn, { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_TIMEOUT_MS, what = 'board' } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`${what} is locked: ${lock}`);
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
  return withLock(`${file}.lock`, () => {
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
  if (!ENTRY_COLUMNS.includes(column)) throw new Error(`new cards start in ${ENTRY_COLUMNS.join(', ')}, not ${column}`);
  const id = board.nextId;
  const card = {
    id,
    title: String(title).trim(),
    // An idea for the spec writer is free text; anything else starts from the template.
    body: body ?? (column === 'spec' ? '' : TEMPLATE),
    column: 'backlog',
    labels: cleanLabels(labels),
    blockedBy: cleanDeps(board, id, blockedBy),
    assignee: null,
    run: {},
    panel: emptyPanel(),
    comments: [],
    history: [{ at: now(), to: 'backlog' }],
    createdAt: now(),
    updatedAt: now(),
  };
  if (column === 'ready') {
    const issues = lintCard(card, board).filter((i) => i.severity === 'error');
    if (issues.length) throw new Error(`a new card in ready must pass lint:\n- ${issues.map((i) => i.message).join('\n- ')}`);
  }
  card.column = column;
  card.history = [{ at: now(), to: column }];
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
    // Every entry to review is a new panel round; leaving it ends every reviewer's claim.
    if (column === 'review') resetPanel(card);
    if (card.column === 'review') clearLensClaims(card);
    // A card that leaves blocked no longer waits for the person: the request labels go with it.
    if (card.column === 'blocked') card.labels = card.labels.filter((l) => !REQUEST_LABELS.includes(l));
    card.history.push({ at: now(), from: card.column, to: column, by });
    card.column = column;
  }
  card.updatedAt = now();
  return card;
}

// Files a card found by a collector, deduplicated by a stable fingerprint (source.key).
// An open card with the same key gets a "seen again" comment instead of a twin; a key whose
// only cards are done is a recurrence: a new card that names the old one.
export function collectCard(board, { title, body, labels = [], source, evidence = '' }) {
  if (!source?.kind || !source?.key) throw new Error('a collected card needs --source <kind>:<fingerprint>');
  const same = board.cards.filter((c) => c.source?.key === source.key);
  const open = same.filter((c) => c.column !== 'done').at(-1);
  if (open) {
    open.source.seen = (open.source.seen || 1) + 1;
    commentCard(board, open.id, { role: 'collect', text: `[collect] 🔁 visto otra vez (${open.source.seen})${evidence ? `\n${evidence}` : ''}` });
    return { status: 'duplicate', card: open };
  }
  const closed = same.at(-1);
  const card = addCard(board, { title, body, labels: closed ? [...labels, 'recurrence'] : labels });
  card.source = { kind: source.kind, key: source.key, seen: 1 };
  if (closed) commentCard(board, card.id, { role: 'collect', text: `[collect] ↩️ reaparece: #${closed.id} ya estaba en done${evidence ? `\n${evidence}` : ''}` });
  else if (evidence) commentCard(board, card.id, { role: 'collect', text: `[collect] evidencia\n${evidence}` });
  return { status: closed ? 'recurrence' : 'created', card, ...(closed ? { previous: closed.id } : {}) };
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
  if (card.assignee !== who) card.claimedAt = now();
  card.assignee = who;
  card.updatedAt = now();
  return card;
}

export function releaseCard(board, id) {
  const card = findCard(board, id);
  card.assignee = null;
  card.claimedAt = null;
  delete card.run.dispatch; // the Orca dispatch that held the claim is over
  card.updatedAt = now();
  return card;
}

// A reviewer's claim on one lens of a card in review. Lenses run in parallel, so each is claimed
// apart from the card itself, with the same rule: one worker per lens.
export function claimLens(board, id, lens, who) {
  const card = findCard(board, id);
  if (card.column !== 'review') throw new Error(`card #${id} is in ${card.column}; reviewers work on cards in review`);
  const slot = (card.panel.lenses[lens] ??= {});
  if (slot.worker && slot.worker !== who) throw new Error(`lens ${lens} of card #${id} is already claimed by ${slot.worker}`);
  if (slot.verdict) throw new Error(`lens ${lens} of card #${id} already has a verdict this round (${slot.verdict})`);
  if (slot.worker !== who) slot.claimedAt = now();
  slot.worker = who;
  card.updatedAt = now();
  return card;
}

export function releaseLens(board, id, lens) {
  const card = findCard(board, id);
  const slot = card.panel.lenses[lens];
  if (slot) {
    slot.worker = null;
    slot.claimedAt = null;
    delete slot.dispatch;
  }
  card.updatedAt = now();
  return card;
}

// What `worker` holds on this card: { lens: null } for the card itself, { lens } for a review
// lens, or null when it holds nothing.
export function holding(card, worker) {
  if (!worker) return null;
  if (card.assignee === worker) return { lens: null };
  for (const [lens, slot] of Object.entries(card.panel?.lenses || {})) if (slot.worker === worker) return { lens };
  return null;
}

// Every claim on a card: its own assignee and each claimed lens.
export function claimsOf(card) {
  const out = [];
  if (card.assignee) out.push({ worker: card.assignee, lens: null, claimedAt: card.claimedAt, dispatch: card.run.dispatch ?? null });
  for (const [lens, slot] of Object.entries(card.panel?.lenses || {})) {
    if (slot.worker) out.push({ worker: slot.worker, lens, claimedAt: slot.claimedAt, dispatch: slot.dispatch ?? null });
  }
  return out;
}

export const MAX_BOUNCES = 3;

// Times a card was sent back to building from qa, review or the merge gate.
export function bounces(card) {
  return card.history.filter((h) => h.to === 'building' && ['qa', 'review'].includes(h.from)).length;
}

// Sends a card back to building, unless it has already bounced MAX_BOUNCES times: then the
// loop is not converging, so it goes to blocked with needs-you for a person to look at.
export function sendBack(board, id, { who, role, text }) {
  const card = findCard(board, id);
  let to = 'building';
  let note = '';
  if (bounces(card) >= MAX_BOUNCES) {
    to = 'blocked';
    note = `\n🙋 ${MAX_BOUNCES} vueltas a building sin converger: necesita a una persona.`;
    if (!card.labels.includes('needs-you')) card.labels.push('needs-you');
  }
  commentCard(board, id, { role, text: text + note });
  moveCard(board, id, to, who);
  return releaseCard(board, id);
}

export function getCard(board, id) {
  return findCard(board, id);
}
