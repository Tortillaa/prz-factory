// Lane bookkeeping shared by the spec, build, qa, review and merge skills: start a card in this worktree,
// hand it to the next lane, and record a reviewer's verdict. The judgment work happens in the
// skills; this is the plumbing.
import * as store from './store.mjs';
import { git, revParse, isAncestor, isClean, toplevel, worktrees, samePath, slugify } from './git.mjs';
import { riskLevel } from './ticket.mjs';

export const LANES = {
  // lane: { column it works in, where it may hand a card to }
  spec: { column: 'spec', to: ['ready', 'blocked'] },
  build: { column: 'building', to: ['review', 'blocked'] },
  // qa works only on qa-labelled cards (tests of the base branch): it closes them through `factory merge`.
  qa: { column: 'qa', to: ['blocked'] },
  // The review panel records verdicts with `factory verdict`; the one that completes it moves the card to merge.
  review: { column: 'review', to: [] },
  // The merge agent lands what the panel passed through `factory merge` (the only way to Done), or
  // hands it to a person in blocked when it cannot land.
  merge: { column: 'merge', to: ['blocked'] },
};

function checkLane(lane) {
  if (!LANES[lane]) throw new Error(`unknown lane "${lane}" (use: ${Object.keys(LANES).join(', ')})`);
  return LANES[lane];
}

function checkLens(lens, config) {
  if (!lens) throw new Error(`the review lane needs --lens (use: ${config.review.lenses.join(', ')})`);
  if (!config.review.lenses.includes(lens)) throw new Error(`unknown lens "${lens}" (this project reviews with: ${config.review.lenses.join(', ')})`);
}

export const branchName = (card) => card.run.branch || `factory/${card.id}-${slugify(card.title)}`;

// Claims the card (or, in review, one lens of it), moves it out of Ready when this lane is its
// route, and checks out its code: build gets the card's branch; spec gets the base, detached; qa and
// review get a detached checkout of the branch (it may be checked out in the builder's worktree).
// Refuses the main checkout unless allowMain.
export function startLane({ file, id, who, lane, lens = null, cwd, config, allowMain = false }) {
  const { column } = checkLane(lane);
  if (!who) throw new Error('missing --as <worker-name>');
  if (lane === 'review') checkLens(lens, config);
  else if (lens) throw new Error(`--lens is only for the review lane`);
  const root = toplevel(cwd);
  if (!allowMain && samePath(worktrees(cwd)[0].path, root)) {
    throw new Error(`${root} is the main checkout: run lanes in their own worktree (Orca gives one per worker), or pass --allow-main`);
  }
  if (!isClean(root)) throw new Error(`${root} has uncommitted changes; commit or stash them first`);

  const card = store.update(file, (b) => {
    const c = store.getCard(b, id);
    if (lane === 'review') {
      if (!c.run.branch) throw new Error(`card #${id} has no branch to review`);
      store.claimLens(b, id, lens, who);
      return structuredClone(c);
    }
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
    } else if (lane === 'spec') {
      git(['switch', '--detach', base], root);
    } else {
      branch = card.run.branch || null;
      // A qa card with no build has no branch: QA tests the base branch as it is.
      git(['switch', '--detach', branch || base], root);
    }
    const head = git(['rev-parse', 'HEAD'], root);
    const updated = store.update(file, (b) => {
      if (lane !== 'review') return store.editCard(b, id, { run: { worktree: root, worker: who, ...(lane === 'build' ? { branch } : {}) } });
      // Every lens of a round reviews the same commit. A head that moved under the panel (someone
      // committed on the branch) invalidates the verdicts already given.
      const c = store.getCard(b, id);
      if (c.panel.head !== head) {
        for (const slot of Object.values(c.panel.lenses)) {
          delete slot.verdict;
          delete slot.sha;
        }
        c.panel.head = head;
      }
      c.panel.lenses[lens].worktree = root;
      return c;
    });
    return { card: updated, lane, lens, branch, head, worktree: root, base };
  } catch (err) {
    // The checkout failed: give the card back so another worker can take it.
    store.update(file, (b) => (lane === 'review' ? store.releaseLens(b, id, lens) : store.releaseCard(b, id)));
    throw err;
  }
}

// Commits on the card's branch that lack the `Card: #<id>` line the writing standard asks for. Only the
// ones after the last commit a panel reviewed (or after the base): older ones were already accepted.
export function commitsWithoutCard(card, cwd, base) {
  const branch = card.run.branch;
  if (!branch || !revParse(`refs/heads/${branch}`, cwd)) return [];
  const reviewed = card.panel?.head;
  const since = reviewed && isAncestor(reviewed, `refs/heads/${branch}`, cwd) ? reviewed : base;
  const log = git(['log', '--format=%h%x1f%B%x1e', `${since}..refs/heads/${branch}`], cwd);
  const want = new RegExp(`^Card: #${card.id}\\s*$`, 'm');
  return log.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => e.split('\x1f')).filter(([, body]) => !want.test(body)).map(([sha]) => sha);
}

// Comment, move and release in one write, so a card is never left claimed but moved (or the reverse).
// With `cwd` and `config`, a builder's handoff to review also checks the commit format first.
export function handoff({ file, id, who, lane, to, text, cwd = null, config = null }) {
  const { column, to: allowed } = checkLane(lane);
  if (lane === 'review') throw new Error('reviewers finish with `factory verdict`, not a handoff');
  if (!text || !text.trim()) throw new Error('a handoff needs a comment with what you did and the evidence');
  if (lane === 'build' && to === 'review' && cwd && config) {
    const missing = commitsWithoutCard(store.getCard(store.load(file), id), cwd, config.baseBranch);
    if (missing.length) {
      throw new Error(`commits ${missing.join(', ')} lack the line \`Card: #${id}\` (writing standard §1). Add it and hand off again:\n  git rebase ${missing.length > 1 ? `${missing.at(-1)}~1` : `${missing[0]}~1`} --exec 'git commit --amend --no-edit --trailer "Card: #${id}"'`);
    }
  }
  return store.update(file, (b) => {
    const card = store.getCard(b, id);
    if (card.column !== column) throw new Error(`card #${id} is in ${card.column}, not ${column}`);
    if (card.assignee !== who) throw new Error(`card #${id} is claimed by ${card.assignee ?? 'nobody'}, not ${who}`);
    if (!allowed.includes(to)) throw new Error(`the ${lane} lane hands cards to ${allowed.join(' or ')}, not ${to}`);
    card.failedDispatches = 0; // a worker that hands off did its job
    if (to === 'building') return store.sendBack(b, id, { who, role: lane, text });
    store.commentCard(b, id, { role: lane, text });
    store.moveCard(b, id, to, who);
    // A lane that blocks a card is asking the user something: mark it so the request reaches them.
    if (to === 'blocked' && !card.labels.includes('needs-you')) card.labels.push('needs-you');
    return store.releaseCard(b, id);
  });
}

// The lenses this card's panel needs. A Low-risk card with no business label gets the light panel;
// anything else, or a card a reviewer escalated (needs-human is a business label), gets every lens.
export function lensesFor(card, config) {
  const { lenses } = config.review;
  // Only the light lenses this project reviews with.
  const light = (config.review.light || []).filter((l) => lenses.includes(l));
  if (!light.length) return lenses;
  const business = card.labels.some((l) => config.merge.humanLabels.includes(l));
  return riskLevel(card.body) === 'low' && !business ? light : lenses;
}

// Lenses of this round that have not passed yet.
export function pendingLenses(card, config) {
  return lensesFor(card, config).filter((l) => card.panel?.lenses?.[l]?.verdict !== 'pass');
}

/**
 * One reviewer's verdict on the head the panel is reviewing, in one write.
 * fail: the card goes back to building (or to blocked, with needs-you, for a decision a person
 * must make) and the round ends for every lens. pass: the lens is done; `escalate` adds
 * needs-human, so the merge gate hands the merge to a person. Agents can raise that bar, never
 * lower it. Returns { card, verdict, complete }: complete when every lens passed this head.
 */
export function verdict({ file, id, who, lens, sha, pass, to = 'building', escalate = null, text, config }) {
  checkLens(lens, config);
  if (typeof pass !== 'boolean') throw new Error('a verdict is --pass or --fail');
  if (!text || !text.trim()) throw new Error('a verdict needs a comment with the findings and the evidence');
  if (!sha || sha.length < 7) throw new Error('pass --sha <head you reviewed> (at least 7 characters)');
  return store.update(file, (b) => {
    const card = store.getCard(b, id);
    if (card.column !== 'review') throw new Error(`card #${id} is in ${card.column}: this review round is over`);
    const slot = card.panel.lenses[lens];
    if (!slot || slot.worker !== who) throw new Error(`lens ${lens} of card #${id} is claimed by ${slot?.worker ?? 'nobody'}, not ${who}`);
    const head = card.panel.head;
    if (!head || !head.startsWith(sha)) throw new Error(`the panel is reviewing ${head ? head.slice(0, 8) : 'nothing'}, not ${sha.slice(0, 8)}: restart the review on the current head`);
    const role = `review:${lens}`;
    slot.failedDispatches = 0;

    if (!pass) {
      if (!['building', 'blocked'].includes(to)) throw new Error(`a failed review goes to building or blocked, not ${to}`);
      slot.verdict = 'fail';
      slot.sha = head;
      slot.at = new Date().toISOString();
      if (to === 'building') store.sendBack(b, id, { who, role, text });
      else {
        store.commentCard(b, id, { role, text });
        if (!card.labels.includes('needs-you')) card.labels.push('needs-you');
        store.moveCard(b, id, 'blocked', who);
      }
      return { card, verdict: 'fail', complete: false };
    }

    slot.verdict = 'pass';
    slot.sha = head;
    slot.at = new Date().toISOString();
    slot.worker = null;
    slot.claimedAt = null;
    delete slot.dispatch;
    let note = '';
    if (escalate && escalate.trim()) {
      if (!card.labels.includes('needs-human')) card.labels.push('needs-human');
      note = `\n🙋 escalado a una persona: ${escalate.trim()}`;
    }
    store.commentCard(b, id, { role, text: text + note });
    const complete = pendingLenses(card, config).length === 0;
    if (complete) {
      // The whole panel passed this head: pin it and hand the card to the merge agent.
      store.editCard(b, id, { run: { reviewedSha: head } });
      store.moveCard(b, id, 'merge', who);
    }
    return { card, verdict: 'pass', complete };
  });
}
