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
const config = { ...DEFAULTS, maxWorkers: 3 };

// Builds a board in memory: cards [{ title, column, labels, blockedBy, assignee, run }].
function board(cards) {
  const b = { version: 1, nextId: 1, cards: [] };
  for (const c of cards) {
    const card = store.addCard(b, { title: c.title ?? 'card', body: GOOD_BODY, labels: c.labels, blockedBy: c.blockedBy });
    if (c.column && c.column !== 'backlog') store.moveCard(b, card.id, c.column, null, { force: true });
    if (c.assignee) store.claimCard(b, card.id, c.assignee);
    if (c.run) Object.assign(card.run, c.run);
  }
  return b;
}

test('plan finishes work before starting more, and fills only free slots', () => {
  const b = board([
    { column: 'ready' },                        // 1
    { column: 'building' },                     // 2 waiting for a builder
    { column: 'review' },                       // 3
    { column: 'qa', assignee: 'qa-4' },         // 4 in flight: takes a slot
    { column: 'ready', labels: ['qa'] },        // 5
  ]);
  const actions = run.plan(b, config, ROOT);
  assert.deepEqual(actions.map((a) => [a.id, a.lane, a.worker]), [[3, 'review', 'review-3'], [2, 'build', 'build-2']]);
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 10 }, ROOT).map((a) => [a.id, a.lane]), [[3, 'review'], [2, 'build'], [1, 'build'], [5, 'qa']]);
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 1 }, ROOT), []);
});

test('plan skips blocked dependencies and cards outside the pipeline', () => {
  const b = board([{ column: 'ready' }, { column: 'ready', blockedBy: [1] }, { column: 'blocked' }, { column: 'done' }, {}]);
  assert.deepEqual(run.plan(b, { ...config, maxWorkers: 9 }, ROOT).map((a) => a.id), [1]);
});

test('placement reuses the card worktree when it still exists', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wt-'));
  const b = board([{ column: 'qa', run: { worktree: wt } }, { column: 'ready', run: { worktree: path.join(wt, 'gone') } }, { column: 'ready', run: { worktree: ROOT } }]);
  assert.deepEqual(run.placement(b.cards[0], ROOT), { worktree: `path:${wt}` });
  assert.deepEqual(run.placement(b.cards[1], ROOT), { worktree: 'new-top-level', repo: `path:${ROOT}`, name: 'factory-2' });
  assert.equal(run.placement(b.cards[2], ROOT).worktree, 'new-top-level', 'never the main checkout');
});

test('spec names the worker, the card, the skill and the fallbacks', () => {
  const [card] = board([{ title: 'Login', column: 'ready' }]).cards;
  const text = run.spec(card, 'build', 'build-1', ROOT);
  assert.match(text, /factory-build/);
  assert.match(text, /factory start 1 --lane build --as build-1/);
  assert.match(text, /skills[\\/]factory-build[\\/]SKILL\.md/);
  assert.match(text, /bin[\\/]factory\.mjs/);
  assert.match(run.spec(card, 'review', 'review-1', ROOT), /factory merge/);
});

test('status reports in-flight age, stale claims, needs-you, blockers and idleness', () => {
  const b = board([{ column: 'building', assignee: 'build-1' }, { column: 'blocked', labels: ['needs-you'] }, { column: 'ready', blockedBy: [1] }]);
  b.cards[0].claimedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
  const s = run.status(b, config, ROOT);
  assert.equal(s.counts.building, 1);
  assert.deepEqual(s.inFlight.map((f) => [f.id, f.worker, f.stale]), [[1, 'build-1', true]]);
  assert.deepEqual(s.needsYou.map((n) => n.id), [2]);
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

test('stop releases everything in flight and lists the dispatches', () => {
  const b = board([{ column: 'building', assignee: 'build-1', run: { dispatch: 'd1' } }, { column: 'qa', assignee: 'qa-2' }, { column: 'blocked', assignee: 'x' }]);
  const { stopped } = run.stop(b);
  assert.deepEqual(stopped, [{ id: 1, worker: 'build-1', dispatch: 'd1' }, { id: 2, worker: 'qa-2', dispatch: null }]);
  assert.equal(run.inFlight(b).length, 0);
  assert.equal(b.cards[2].assignee, 'x', 'blocked cards are not in flight');
});

test('recordDispatch writes only while the worker still holds the card', () => {
  const b = board([{ column: 'building', assignee: 'build-1' }, { column: 'qa' }]);
  assert.equal(run.recordDispatch(b, 1, { worker: 'build-1', dispatch: 'd1' }).recorded, true);
  assert.equal(b.cards[0].run.dispatch, 'd1');
  const late = run.recordDispatch(b, 2, { worker: 'build-2', dispatch: 'd2' });
  assert.equal(late.recorded, false);
  assert.equal(b.cards[1].run.dispatch, undefined);
});
