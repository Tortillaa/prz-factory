// The coordinator's bookkeeping: what to dispatch next, the spec a worker gets, a status
// snapshot, recovery of cards whose worker ended without a handoff, and stop. Everything here
// is deterministic; the factory-run skill drives Orca with it and never does product work.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { FACTORY_ROOT } from './install.mjs';
import { APPROVAL } from './merge.mjs';
import { launchFor } from './config.mjs';

// Columns with one lane per card. Review is a panel: one worker per lens, handled apart.
const LANE_OF = { merge: 'merge', qa: 'qa', building: 'build', spec: 'spec' };
const ACTIVE = ['spec', 'ready', 'building', 'qa', 'review', 'merge'];
export const MAX_FAILED_DISPATCHES = 2;
const STALE_CLAIM_MS = 3 * 60 * 60_000;

export const workerName = (id, lane, lens = null) => (lens ? `${lane}-${lens}-${id}` : `${lane}-${id}`);

// Where the worker runs. A reviewer gets its own worktree per lens (the panel runs in parallel);
// every other lane shares the card's worktree once it has one, else a new one.
export function placement(card, repoRoot, lens = null) {
  const usable = (wt) => wt && fs.existsSync(wt) && path.resolve(wt) !== path.resolve(repoRoot);
  const wt = lens ? card.panel?.lenses?.[lens]?.worktree : card.run.worktree;
  if (usable(wt)) return { worktree: `path:${wt}` };
  return { worktree: 'new-top-level', repo: `path:${repoRoot}`, name: lens ? `factory-${card.id}-${lens}` : `factory-${card.id}` };
}

// Every claim held on an active card: { card, worker, lens, claimedAt, dispatch }.
export function inFlight(board) {
  return board.cards.filter((c) => ACTIVE.includes(c.column)).flatMap((c) => store.claimsOf(c).map((k) => ({ card: c, ...k })));
}

// Next dispatches, up to the free worker slots. Each: { id, title, lane, lens, worker, placement }.
// Finishing work beats starting more: merges, review lenses, qa, building, ready, then specs to write.
export function plan(board, config, repoRoot) {
  const slots = Math.max(0, config.maxWorkers - inFlight(board).length);
  const waiting = [];
  for (const c of board.cards) if (c.column === 'merge' && !c.assignee) waiting.push({ card: c, lane: 'merge' });
  for (const c of board.cards) {
    if (c.column !== 'review' || !c.run.branch) continue;
    for (const lens of config.review.lenses) {
      const slot = c.panel?.lenses?.[lens];
      if (!slot?.worker && !slot?.verdict) waiting.push({ card: c, lane: 'review', lens });
    }
  }
  for (const column of ['qa', 'building']) {
    for (const c of board.cards) if (c.column === column && !c.assignee) waiting.push({ card: c, lane: LANE_OF[column] });
  }
  for (const c of store.readyQueue(board)) waiting.push({ card: c, lane: c.next === 'qa' ? 'qa' : 'build' });
  for (const c of board.cards) if (c.column === 'spec' && !c.assignee) waiting.push({ card: c, lane: 'spec' });
  return waiting.slice(0, slots).map(({ card, lane, lens = null }) => ({
    id: card.id,
    title: card.title,
    lane,
    lens,
    worker: workerName(card.id, lane, lens),
    placement: placement(card, repoRoot, lens),
    launch: launchFor(lane, config),
  }));
}

const FINISH = {
  spec: 'exactly one `factory handoff` (to ready, or to blocked with the questions)',
  build: 'exactly one `factory handoff`',
  qa: '`factory merge` (or a `factory handoff` to blocked)',
  review: 'exactly one `factory verdict` (the one that completes the panel moves the card to merge)',
  merge: '`factory merge` (or a `factory handoff` to blocked)',
};

// The ponytail skill each step of the chain consults, and what it applies it to. Vendored in
// skills/ (MIT, DietrichGebert/ponytail) so every worker has it; the lane skills say how to use it.
export const CRAFT = {
  spec: { skill: 'ponytail', use: 'apply its ladder to the scope of the card (does this need to exist? what is the smallest version that does the core job?), not to code: you write none' },
  build: { skill: 'ponytail', use: 'apply it, at level full, to every line you write: the smallest change that fully solves the card' },
  review: { skill: 'ponytail-review', use: 'use its checks for your lens and its rule that a finding needs a concrete case; the verdict and comment formats stay the ones of `factory-review`' },
};

// The self-contained task a worker gets. Orca appends its own preamble (Task and Dispatch IDs,
// how to report worker_done), so this only has to say what the factory expects.
export function spec(card, lane, worker, repoRoot, lens = null) {
  if (lane === 'review' && !lens) throw new Error('a review worker needs --lens');
  const skill = path.join(FACTORY_ROOT, 'skills', `factory-${lane}`, 'SKILL.md');
  const cli = path.join(FACTORY_ROOT, 'bin', 'factory.mjs');
  const lensFlag = lens ? ` --lens ${lens}` : '';
  const lensLine = lens
    ? `\n   You are the **${lens}** reviewer of a parallel panel: review only through that lens, as
   the skill's \`references/lenses.md\` says. Other reviewers cover the other lenses.`
    : '';
  const craft = CRAFT[lane];
  const craftLine = craft
    ? `\n   Then load the \`${craft.skill}\` skill too, before you start (if it is not installed, read
   ${path.join(FACTORY_ROOT, 'skills', craft.skill, 'SKILL.md')}): ${craft.use}.`
    : '';
  return `You are a prz-factory ${lane}${lens ? ` (${lens})` : ''} worker. Your worker name is ${worker}.

Card #${card.id}: ${card.title}
Repository: ${repoRoot}

0. If your agent has not loaded this project's rules on its own (Grok does only in a folder it
   trusts), read the \`CLAUDE.md\` or \`AGENTS.md\` at the root of this worktree first.
1. Load the \`factory-${lane}\` skill and follow it for card #${card.id}. If your agent does not list it
   (Claude Code and Grok find it in \`.claude/skills/\`), read ${skill} and follow that file.${lensLine}${craftLine}
2. The card is already claimed as ${worker}: use \`--as ${worker}\` in every factory command, starting with
   \`factory start ${card.id} --lane ${lane}${lensFlag} --as ${worker} --json\`. If \`factory\` is not on PATH, run
   \`node ${cli}\` instead.
3. Work only in this worktree and only on card #${card.id}.
4. Finish with ${FINISH[lane]}, as the skill says. If the card cannot be done without a decision it does
   not contain, send it to \`blocked\` with the reason; do not ask the coordinator product questions.
5. Then report done to the coordinator in one line: the column the card ended in, the head SHA,
   and what happened.
`;
}

export function status(board, config, repoRoot, now = Date.now()) {
  const counts = Object.fromEntries(store.COLUMNS.map((c) => [c, board.cards.filter((x) => x.column === c).length]));
  const flying = inFlight(board).map(({ card: c, worker, lens, claimedAt, dispatch }) => {
    const age = claimedAt ? now - Date.parse(claimedAt) : null;
    return { id: c.id, title: c.title, column: c.column, worker, lens, dispatch, ageMinutes: age == null ? null : Math.round(age / 60_000), stale: age != null && age > STALE_CLAIM_MS };
  });
  const why = (c) => c.comments.at(-1)?.text ?? '';
  // Merges the gate held for a person: the requests to approve. The rest of needs-you is a problem.
  const approvals = board.cards.filter((c) => c.column === 'blocked' && c.labels.includes(APPROVAL)).map((c) => ({ id: c.id, title: c.title, sha: c.run.reviewedSha ?? null, branch: c.run.branch ?? null, why: why(c) }));
  const needsYou = board.cards.filter((c) => c.labels.includes('needs-you') && !c.labels.includes(APPROVAL)).map((c) => ({ id: c.id, title: c.title, column: c.column, why: why(c) }));
  const panels = board.cards.filter((c) => c.column === 'review').map((c) => ({
    id: c.id,
    head: c.panel?.head ?? null,
    lenses: Object.fromEntries(config.review.lenses.map((l) => {
      const s = c.panel?.lenses?.[l] || {};
      return [l, s.verdict || (s.worker ? 'reviewing' : 'waiting')];
    })),
  }));
  const waitingOnDeps = board.cards.filter((c) => c.column === 'ready' && store.unmetDeps(board, c).length).map((c) => ({ id: c.id, waitingOn: store.unmetDeps(board, c) }));
  const next = plan(board, config, repoRoot);
  const idle = flying.length === 0 && next.length === 0;
  return { counts, inFlight: flying, approvals, needsYou, panels, waitingOnDeps, next, idle, maxWorkers: config.maxWorkers };
}

// Records the Orca dispatch holding a card (or a lens of it). A fast worker may have finished before
// the coordinator gets here: then the claim is no longer its, and nothing is written.
export function recordDispatch(board, id, { worker, dispatch }) {
  const card = store.getCard(board, id);
  const held = store.holding(card, worker);
  if (!held) return { card, recorded: false, note: card.assignee ? `card is claimed by ${card.assignee}` : 'already handed off' };
  if (held.lens) card.panel.lenses[held.lens].dispatch = dispatch;
  else store.editCard(board, id, { run: { dispatch } });
  return { card, recorded: true, lens: held.lens };
}

// A worker ended (worker_done, escalation, failed start) but still holds its claim: it never
// handed off. Release it so the next plan retries it, or block the card after repeated failures.
// Without `worker`, it reclaims the card's own assignee, or its only claimed lens.
export function reclaim(board, id, { worker, reason }) {
  const card = store.getCard(board, id);
  const claims = store.claimsOf(card);
  const claim = worker ? claims.find((k) => k.worker === worker) : claims.length === 1 ? claims[0] : claims.find((k) => !k.lens);
  if (!claim) {
    const note = !claims.length ? 'card is not claimed' : worker ? `claimed by ${claims.map((k) => k.worker).join(', ')}, not ${worker}` : `several reviewers hold it: pass --worker`;
    return { card, action: 'none', note };
  }
  const holder = claim.lens ? card.panel.lenses[claim.lens] : card;
  holder.failedDispatches = (holder.failedDispatches || 0) + 1;
  const text = `[run] ⚠️ ${claim.worker} terminó sin traspasar la tarjeta (${holder.failedDispatches}/${MAX_FAILED_DISPATCHES})\n${reason || 'sin motivo'}`;
  store.commentCard(board, id, { role: 'run', text });
  if (claim.lens) store.releaseLens(board, id, claim.lens);
  else {
    store.releaseCard(board, id);
    store.editCard(board, id, { run: { dispatch: null } });
  }
  if (holder.failedDispatches >= MAX_FAILED_DISPATCHES) {
    if (!card.labels.includes('needs-you')) card.labels.push('needs-you');
    store.moveCard(board, id, 'blocked', 'run');
    store.releaseCard(board, id);
    return { card, action: 'blocked', lens: claim.lens };
  }
  return { card, action: 'released', lens: claim.lens };
}

// Releases every in-flight claim. Returns the Orca dispatches the caller still has to stop.
export function stop(board, reason = 'run detenido') {
  const stopped = inFlight(board).map(({ card: c, worker, lens, dispatch }) => {
    store.commentCard(board, c.id, { role: 'run', text: `[run] ⏹ ${reason}: ${worker} liberado` });
    if (lens) store.releaseLens(board, c.id, lens);
    else {
      store.releaseCard(board, c.id);
      store.editCard(board, c.id, { run: { dispatch: null } });
    }
    return { id: c.id, worker, lens, dispatch };
  });
  return { stopped };
}
