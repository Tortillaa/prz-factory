// The coordinator's bookkeeping: what to dispatch next, the spec a worker gets, a status
// snapshot, recovery of cards whose worker ended without a handoff, and stop. Everything here
// is deterministic; the factory-run skill drives Orca with it and never does product work.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { FACTORY_ROOT } from './install.mjs';

// Columns with a lane, closest to done first: finishing work beats starting more.
const LANE_OF = { review: 'review', qa: 'qa', building: 'build' };
const ACTIVE = ['ready', 'building', 'qa', 'review'];
export const MAX_FAILED_DISPATCHES = 2;
const STALE_CLAIM_MS = 3 * 60 * 60_000;

export const workerName = (id, lane) => `${lane}-${id}`;

// Where the worker runs: the card's own worktree once it has one, else a new one.
export function placement(card, repoRoot) {
  const wt = card.run.worktree;
  if (wt && fs.existsSync(wt) && path.resolve(wt) !== path.resolve(repoRoot)) return { worktree: `path:${wt}` };
  return { worktree: 'new-top-level', repo: `path:${repoRoot}`, name: `factory-${card.id}` };
}

export function inFlight(board) {
  return board.cards.filter((c) => c.assignee && ACTIVE.includes(c.column));
}

// Next dispatches, up to the free worker slots. Each: { id, title, lane, worker, placement }.
export function plan(board, config, repoRoot) {
  const slots = Math.max(0, config.maxWorkers - inFlight(board).length);
  const waiting = [];
  for (const column of ['review', 'qa', 'building']) {
    for (const c of board.cards) if (c.column === column && !c.assignee) waiting.push({ card: c, lane: LANE_OF[column] });
  }
  for (const c of store.readyQueue(board)) waiting.push({ card: c, lane: c.next === 'qa' ? 'qa' : 'build' });
  return waiting.slice(0, slots).map(({ card, lane }) => ({
    id: card.id,
    title: card.title,
    lane,
    worker: workerName(card.id, lane),
    placement: placement(card, repoRoot),
  }));
}

// The self-contained task a worker gets. Orca appends its own preamble (Task and Dispatch IDs,
// how to report worker_done), so this only has to say what the factory expects.
export function spec(card, lane, worker, repoRoot) {
  const skill = path.join(FACTORY_ROOT, 'skills', `factory-${lane}`, 'SKILL.md');
  const cli = path.join(FACTORY_ROOT, 'bin', 'factory.mjs');
  const finish = lane === 'review' ? '`factory merge` (or a `factory handoff` back)' : 'exactly one `factory handoff`';
  return `You are a prz-factory ${lane} worker. Your worker name is ${worker}.

Card #${card.id}: ${card.title}
Repository: ${repoRoot}

1. Load the \`factory-${lane}\` skill and follow it for card #${card.id}. If it is not installed in this
   worktree, read ${skill} and follow that file.
2. The card is already claimed as ${worker}: use \`--as ${worker}\` in every factory command, starting with
   \`factory start ${card.id} --lane ${lane} --as ${worker} --json\`. If \`factory\` is not on PATH, run
   \`node ${cli}\` instead.
3. Work only in this worktree and only on card #${card.id}.
4. Finish with ${finish}, as the skill says. If the card cannot be done without a decision it does
   not contain, hand it to \`blocked\` with the reason; do not ask the coordinator product questions.
5. Then report done to the coordinator in one line: the column the card ended in, the head SHA,
   and what happened.
`;
}

export function status(board, config, repoRoot, now = Date.now()) {
  const counts = Object.fromEntries(store.COLUMNS.map((c) => [c, board.cards.filter((x) => x.column === c).length]));
  const flying = inFlight(board).map((c) => {
    const age = c.claimedAt ? now - Date.parse(c.claimedAt) : null;
    return { id: c.id, title: c.title, column: c.column, worker: c.assignee, dispatch: c.run.dispatch ?? null, ageMinutes: age == null ? null : Math.round(age / 60_000), stale: age != null && age > STALE_CLAIM_MS };
  });
  const needsYou = board.cards.filter((c) => c.labels.includes('needs-you')).map((c) => ({ id: c.id, title: c.title, column: c.column, why: c.comments.at(-1)?.text ?? '' }));
  const waitingOnDeps = board.cards.filter((c) => c.column === 'ready' && store.unmetDeps(board, c).length).map((c) => ({ id: c.id, waitingOn: store.unmetDeps(board, c) }));
  const next = plan(board, config, repoRoot);
  const idle = flying.length === 0 && next.length === 0;
  return { counts, inFlight: flying, needsYou, waitingOnDeps, next, idle, maxWorkers: config.maxWorkers };
}

// Records the Orca dispatch holding a card. A fast worker may have handed off before the
// coordinator gets here: then the card is no longer its, and nothing is written.
export function recordDispatch(board, id, { worker, dispatch }) {
  const card = store.getCard(board, id);
  if (card.assignee !== worker) return { card, recorded: false, note: `card is ${card.assignee ? `claimed by ${card.assignee}` : 'already handed off'}` };
  store.editCard(board, id, { run: { dispatch } });
  return { card, recorded: true };
}

// A worker ended (worker_done, escalation, failed start) but the card is still claimed by it:
// it never handed off. Release it so the next plan retries it, or block it after repeated failures.
export function reclaim(board, id, { worker, reason }) {
  const card = store.getCard(board, id);
  if (!card.assignee) return { card, action: 'none', note: 'card is not claimed' };
  if (worker && card.assignee !== worker) return { card, action: 'none', note: `claimed by ${card.assignee}, not ${worker}` };
  card.failedDispatches = (card.failedDispatches || 0) + 1;
  const text = `[run] ⚠️ ${card.assignee} terminó sin traspasar la tarjeta (${card.failedDispatches}/${MAX_FAILED_DISPATCHES})\n${reason || 'sin motivo'}`;
  store.commentCard(board, id, { role: 'run', text });
  store.releaseCard(board, id);
  store.editCard(board, id, { run: { dispatch: null } });
  if (card.failedDispatches >= MAX_FAILED_DISPATCHES) {
    if (!card.labels.includes('needs-you')) card.labels.push('needs-you');
    store.moveCard(board, id, 'blocked', 'run');
    return { card, action: 'blocked' };
  }
  return { card, action: 'released' };
}

// Releases every in-flight card. Returns the Orca dispatches the caller still has to stop.
export function stop(board, reason = 'run detenido') {
  const stopped = inFlight(board).map((c) => {
    const entry = { id: c.id, worker: c.assignee, dispatch: c.run.dispatch ?? null };
    store.commentCard(board, c.id, { role: 'run', text: `[run] ⏹ ${reason}: ${c.assignee} liberado` });
    store.releaseCard(board, c.id);
    store.editCard(board, c.id, { run: { dispatch: null } });
    return entry;
  });
  return { stopped };
}
