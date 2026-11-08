// Lane bookkeeping shared by the build, qa and review skills: start a card in this worktree,
// and hand it to the next lane. The judgment work happens in the skills; this is the plumbing.
import * as store from './store.mjs';
import { git, revParse, isClean, toplevel, worktrees, samePath, slugify } from './git.mjs';

export const LANES = {
  // lane: { column it works in, where it may hand a card to }
  build: { column: 'building', to: ['qa', 'blocked'] },
  qa: { column: 'qa', to: ['review', 'building', 'blocked'] },
  review: { column: 'review', to: ['building', 'qa', 'blocked'] }, // Done only through `factory merge`
};

function checkLane(lane) {
  if (!LANES[lane]) throw new Error(`unknown lane "${lane}" (use: ${Object.keys(LANES).join(', ')})`);
  return LANES[lane];
}

export const branchName = (card) => card.run.branch || `factory/${card.id}-${slugify(card.title)}`;

// Claims the card, moves it out of Ready when this lane is its route, and checks out its code:
// build gets the card's branch; qa and review get a detached checkout of it (the branch itself
// may be checked out in the builder's worktree). Refuses the main checkout unless allowMain.
export function startLane({ file, id, who, lane, cwd, config, allowMain = false }) {
  const { column } = checkLane(lane);
  if (!who) throw new Error('missing --as <worker-name>');
  const root = toplevel(cwd);
  if (!allowMain && samePath(worktrees(cwd)[0].path, root)) {
    throw new Error(`${root} is the main checkout: run lanes in their own worktree (Orca gives one per worker), or pass --allow-main`);
  }
  if (!isClean(root)) throw new Error(`${root} has uncommitted changes; commit or stash them first`);

  const card = store.update(file, (b) => {
    const c = store.getCard(b, id);
    if (c.column === 'ready') {
      if (store.route(c) !== column) throw new Error(`card #${id} goes to ${store.route(c)} from ready, not ${column}`);
    } else if (c.column !== column) {
      throw new Error(`card #${id} is in ${c.column}; the ${lane} lane works on cards in ${column}`);
    }
    store.claimCard(b, id, who);
    if (c.column === 'ready') store.moveCard(b, id, column, who);
    return structuredClone(c);
  });

  try {
    const base = config.baseBranch;
    let branch = null;
    if (lane === 'build') {
      branch = branchName(card);
      if (revParse(`refs/heads/${branch}`, root)) git(['switch', branch], root);
      else git(['switch', '-c', branch, base], root);
    } else {
      branch = card.run.branch || null;
      // A qa card with no build has no branch: QA tests the base branch as it is.
      git(['switch', '--detach', branch || base], root);
    }
    const head = git(['rev-parse', 'HEAD'], root);
    const run = { worktree: root, worker: who, ...(lane === 'build' ? { branch } : {}) };
    const updated = store.update(file, (b) => store.editCard(b, id, { run }));
    return { card: updated, lane, branch, head, worktree: root, base };
  } catch (err) {
    // The checkout failed: give the card back so another worker can take it.
    store.update(file, (b) => store.releaseCard(b, id));
    throw err;
  }
}

// Comment, move and release in one write, so a card is never left claimed but moved (or the reverse).
export function handoff({ file, id, who, lane, to, text }) {
  const { column, to: allowed } = checkLane(lane);
  if (!text || !text.trim()) throw new Error('a handoff needs a comment with what you did and the evidence');
  return store.update(file, (b) => {
    const card = store.getCard(b, id);
    if (card.column !== column) throw new Error(`card #${id} is in ${card.column}, not ${column}`);
    if (card.assignee !== who) throw new Error(`card #${id} is claimed by ${card.assignee ?? 'nobody'}, not ${who}`);
    if (!allowed.includes(to)) throw new Error(`the ${lane} lane hands cards to ${allowed.join(' or ')}, not ${to}`);
    store.commentCard(b, id, { role: lane, text });
    store.moveCard(b, id, to, who);
    return store.releaseCard(b, id);
  });
}
