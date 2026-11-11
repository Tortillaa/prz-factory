import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.mjs';
import * as run from '../src/run.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const ROOT = path.resolve('/repo');
const config = { ...DEFAULTS, maxWorkers: 3, review: { lenses: ['qa', 'code'] } };

// Builds a board in memory: cards [{ title, column, labels, blockedBy, assignee, run, lenses }].
// lenses: { qa: 'worker-name' | { verdict } } claims or settles review lenses.
function board(cards) {
  const b = { version: 1, nextId: 1, cards: [] };
  for (const c of cards) {
    const card = store.addCard(b, { title: c.title ?? 'card', body: GOOD_BODY, labels: c.labels, blockedBy: c.blockedBy });
    if (c.column && c.column !== 'backlog') store.moveCard(b, card.id, c.column, null, { force: true });
    if (c.assignee) store.claimCard(b, card.id, c.assignee);
    if (c.run) Object.assign(card.run, c.run);
    for (const [lens, v] of Object.entries(c.lenses || {})) {
      if (typeof v === 'string') store.claimLens(b, card.id, lens, v);
      else card.panel.lenses[lens] = { ...v };
    }
  }
  return b;
}

test('plan finishes work before starting more, and fills only free slots', () => {
  const b = board([
    { column: 'ready' },                                  // 1
    { column: 'building' },                               // 2 waiting for a builder
    { column: 'review', run: { branch: 'factory/3-x' } }, // 3 waiting for its panel
    { column: 'qa', assignee: 'qa-4' },                   // 4 in flight: takes a slot
    { column: 'ready', labels: ['qa'] },                  // 5
    { column: 'spec' },                                   // 6 an idea to write up
  ]);
  const actions = run.plan(b, config, ROOT);
  assert.deepEqual(actions.map((a) => [a.id, a.lane, a.lens, a.worker]), [[3, 'review', 'qa', 'review-qa-3'], [3, 'review', 'code', 'review-code-3']]);
  assert.deepEqual(
    run.plan(b, { ...config, maxWorkers: 10 }, ROOT).map((a) => [a.id, a.lane, a.lens]),
    [[3, 'review', 'qa'], [3, 'review', 'code'], [2, 'build', null], [1, 'build', null], [5, 'qa', null], [6, 'spec', null]],
  );
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 1 }, ROOT), []);
});

test('plan dispatches each lens once: not while claimed, not after its verdict', () => {
  const b = board([
    { column: 'review', run: { branch: 'b1' }, lenses: { qa: 'review-qa-1' } },
    { column: 'review', run: { branch: 'b2' }, lenses: { qa: { verdict: 'pass' }, code: { verdict: 'pass' } } }, // panel done, merge pending
    { column: 'review' }, // no branch: nothing to review
  ]);
  assert.equal(run.inFlight(b).length, 1, 'a claimed lens takes a worker slot');
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 9 }, ROOT).map((a) => [a.id, a.lens]), [[1, 'code']]);
  const s = run.status(b, config, ROOT);
  assert.deepEqual(s.panels.map((p) => p.lenses), [{ qa: 'reviewing', code: 'waiting' }, { qa: 'pass', code: 'pass' }, { qa: 'waiting', code: 'waiting' }]);
  assert.deepEqual(s.inFlight.map((f) => [f.id, f.worker, f.lens]), [[1, 'review-qa-1', 'qa']]);
});

test('plan skips blocked dependencies and cards outside the pipeline', () => {
  const b = board([{ column: 'ready' }, { column: 'ready', blockedBy: [1] }, { column: 'blocked' }, { column: 'done' }, {}]);
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 9 }, ROOT).map((a) => a.id), [1]);
});

test('placement reuses the card worktree when it still exists; each reviewer gets its own', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wt-'));
  const b = board([{ column: 'qa', run: { worktree: wt } }, { column: 'ready', run: { worktree: path.join(wt, 'gone') } }, { column: 'ready', run: { worktree: ROOT } }]);
  assert.deepEqual(run.placement(b.cards[0], ROOT), { worktree: `path:${wt}` });
  assert.deepEqual(run.placement(b.cards[1], ROOT), { worktree: 'new-top-level', repo: `path:${ROOT}`, name: 'factory-2' });
  assert.equal(run.placement(b.cards[2], ROOT).worktree, 'new-top-level', 'never the main checkout');

  assert.deepEqual(run.placement(b.cards[0], ROOT, 'code'), { worktree: 'new-top-level', repo: `path:${ROOT}`, name: 'factory-1-code' }, 'not the builder worktree');
  b.cards[0].panel.lenses.code = { worktree: wt };
  assert.deepEqual(run.placement(b.cards[0], ROOT, 'code'), { worktree: `path:${wt}` }, 'the same lens reuses its own worktree next round');
});

test('spec names the worker, the card, the skill and the fallbacks', () => {
  const [card] = board([{ title: 'Login', column: 'ready' }]).cards;
  const text = run.spec(card, 'build', 'build-1', ROOT);
  assert.match(text, /factory-build/);
  assert.match(text, /factory start 1 --lane build --as build-1/);
  assert.match(text, /skills[\\/]factory-build[\\/]SKILL\.md/);
  assert.match(text, /bin[\\/]factory\.mjs/);

  const review = run.spec(card, 'review', 'review-ops-1', ROOT, 'ops');
  assert.match(review, /factory start 1 --lane review --lens ops --as review-ops-1/);
  assert.match(review, /\*\*ops\*\* reviewer of a parallel panel/);
  assert.match(review, /factory verdict/);
  assert.throws(() => run.spec(card, 'review', 'review-1', ROOT), /needs --lens/);
  assert.match(run.spec(card, 'spec', 'spec-1', ROOT), /factory start 1 --lane spec --as spec-1[\s\S]*to ready, or to blocked/);
});

test('status reports in-flight age, stale claims, approvals, needs-you, blockers and idleness', () => {
  const b = board([
    { column: 'building', assignee: 'build-1' },
    { column: 'blocked', labels: ['needs-you'] },
    { column: 'ready', blockedBy: [1] },
    { column: 'blocked', labels: ['needs-you', 'merge-approval'], run: { branch: 'factory/4-x', reviewedSha: 'abc12345' } },
  ]);
  b.cards[0].claimedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
  const s = run.status(b, config, ROOT);
  assert.equal(s.counts.building, 1);
  assert.equal(s.counts.spec, 0);
  assert.deepEqual(s.inFlight.map((f) => [f.id, f.worker, f.stale]), [[1, 'build-1', true]]);
  assert.deepEqual(s.needsYou.map((n) => n.id), [2], 'a merge request is not listed as a problem');
  assert.deepEqual(s.approvals.map((a) => [a.id, a.branch, a.sha]), [[4, 'factory/4-x', 'abc12345']]);
  assert.deepEqual(s.waitingOnDeps, [{ id: 3, waitingOn: [1] }]);
  assert.equal(s.idle, false);
  assert.equal(run.status(board([{ column: 'done' }]), config, ROOT).idle, true);
});

test('reclaim releases a card whose worker vanished, and blocks it the second time', () => {
  const b = board([{ column: 'building', assignee: 'build-1', run: { dispatch: 'd1' } }]);
  assert.equal(run.reclaim(b, 1, { worker: 'someone-else' }).action, 'none');
  const first = run.reclaim(b, 1, { worker: 'build-1', reason: 'crashed' });
  assert.equal(first.action, 'released');
  assert.equal(b.cards[0].assignee, null);
  assert.equal(b.cards[0].run.dispatch, undefined);
  assert.equal(run.reclaim(b, 1, {}).action, 'none', 'nothing to reclaim once released');

  store.claimCard(b, 1, 'build-1');
  const second = run.reclaim(b, 1, { reason: 'crashed again' });
  assert.equal(second.action, 'blocked');
  assert.equal(b.cards[0].column, 'blocked');
  assert.ok(b.cards[0].labels.includes('needs-you'));
});

test('reclaim frees one reviewer without touching the rest of the panel', () => {
  const b = board([{ column: 'review', run: { branch: 'b' }, lenses: { qa: 'review-qa-1', code: 'review-code-1' } }]);
  assert.equal(run.reclaim(b, 1, {}).action, 'none', 'two reviewers: say which');
  const first = run.reclaim(b, 1, { worker: 'review-qa-1', reason: 'crashed' });
  assert.deepEqual([first.action, first.lens], ['released', 'qa']);
  assert.deepEqual(store.claimsOf(b.cards[0]).map((k) => k.worker), ['review-code-1']);
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 9 }, ROOT).map((a) => a.lens), ['qa'], 'the freed lens is dispatched again');

  store.claimLens(b, 1, 'qa', 'review-qa-1');
  const second = run.reclaim(b, 1, { worker: 'review-qa-1', reason: 'crashed again' });
  assert.equal(second.action, 'blocked');
  assert.equal(b.cards[0].column, 'blocked');
  assert.deepEqual(store.claimsOf(b.cards[0]), [], 'leaving review ends every claim');
});

test('stop releases everything in flight and lists the dispatches', () => {
  const b = board([
    { column: 'building', assignee: 'build-1', run: { dispatch: 'd1' } },
    { column: 'qa', assignee: 'qa-2' },
    { column: 'blocked', assignee: 'x' },
    { column: 'review', run: { branch: 'b' }, lenses: { code: 'review-code-4' } },
    { column: 'spec', assignee: 'spec-5' },
  ]);
  run.recordDispatch(b, 4, { worker: 'review-code-4', dispatch: 'd4' });
  const { stopped } = run.stop(b);
  assert.deepEqual(stopped, [
    { id: 1, worker: 'build-1', lens: null, dispatch: 'd1' },
    { id: 2, worker: 'qa-2', lens: null, dispatch: null },
    { id: 4, worker: 'review-code-4', lens: 'code', dispatch: 'd4' },
    { id: 5, worker: 'spec-5', lens: null, dispatch: null },
  ]);
  assert.equal(run.inFlight(b).length, 0);
  assert.equal(b.cards[2].assignee, 'x', 'blocked cards are not in flight');
});

test('recordDispatch writes only while the worker still holds the card or its lens', () => {
  const b = board([{ column: 'building', assignee: 'build-1' }, { column: 'qa' }, { column: 'review', run: { branch: 'b' }, lenses: { qa: 'review-qa-3' } }]);
  assert.equal(run.recordDispatch(b, 1, { worker: 'build-1', dispatch: 'd1' }).recorded, true);
  assert.equal(b.cards[0].run.dispatch, 'd1');
  const late = run.recordDispatch(b, 2, { worker: 'build-2', dispatch: 'd2' });
  assert.equal(late.recorded, false);
  assert.equal(b.cards[1].run.dispatch, undefined);

  const lens = run.recordDispatch(b, 3, { worker: 'review-qa-3', dispatch: 'd3' });
  assert.deepEqual([lens.recorded, lens.lens], [true, 'qa']);
  assert.equal(b.cards[2].panel.lenses.qa.dispatch, 'd3');
  assert.equal(b.cards[2].run.dispatch, undefined, 'a lens dispatch is not the card dispatch');
  assert.equal(run.recordDispatch(b, 3, { worker: 'review-code-3', dispatch: 'd9' }).recorded, false);
});

test('plan dispatches the merge agent first, in the card worktree, on its own model', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wt-'));
  const b = board([{ column: 'ready' }, { column: 'merge', run: { branch: 'factory/2-x', worktree: wt } }]);
  const cfg = { ...config, agents: { merge: { agent: 'claude', model: 'claude-haiku-5-5' }, build: { agent: 'claude', model: 'claude-sonnet-5-5' } } };
  const actions = run.plan(b, cfg, ROOT);
  assert.deepEqual(actions.map((a) => [a.id, a.lane, a.worker, a.launch.model]), [[2, 'merge', 'merge-2', 'claude-haiku-5-5'], [1, 'build', 'build-1', 'claude-sonnet-5-5']]);
  assert.deepEqual(actions[0].placement, { worktree: `path:${wt}` });
  assert.match(run.spec(b.cards[1], 'merge', 'merge-2', ROOT), /factory-merge[\s\S]*factory start 2 --lane merge --as merge-2[\s\S]*`factory merge`/);
  assert.doesNotMatch(run.spec(b.cards[1], 'merge', 'merge-2', ROOT), /ponytail/, 'the merge agent writes no code');
});
