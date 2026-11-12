// The pipeline end to end on real git repos: spec → build → review panel → merge gate, and every refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as store from '../src/store.mjs';
import { startLane, handoff, verdict } from '../src/lanes.mjs';
import { mergeCard } from '../src/merge.mjs';
import { loadConfig } from '../src/config.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');

// A repo whose verify fails when a file named FAIL exists, a two-lens review panel (qa, code),
// and one worktree for the builder plus one per reviewer.
function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lanes-')));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify({ verify: ['node check.js'], review: { lenses: ['qa', 'code'] } }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  const wt = {};
  for (const lane of ['build', 'qa', 'code']) {
    wt[lane] = path.join(dir, lane);
    sh(repo, 'worktree', 'add', '-q', '--detach', wt[lane], 'main');
  }
  const file = path.join(dir, 'board.json');
  const config = loadConfig(repo).config;
  return { repo, wt, file, config };
}

function addReadyCard(env, extra = {}) {
  const card = store.update(env.file, (b) => store.addCard(b, { title: 'Añadir página de login', body: GOOD_BODY, ...extra }));
  store.update(env.file, (b) => store.moveCard(b, card.id, 'ready'));
  return card.id;
}

function commitIn(cwd, name, content = 'x') {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  sh(cwd, 'add', name);
  sh(cwd, 'commit', '-qm', `add ${name}`);
  return sh(cwd, 'rev-parse', 'HEAD');
}

// Builds a card and hands it to the review panel. Returns the head under review.
function build(env, id, files = ['login.txt']) {
  const { file, wt, config } = env;
  startLane({ file, id, who: 'builder', lane: 'build', cwd: wt.build, config });
  for (const f of files) commitIn(wt.build, f);
  handoff({ file, id, who: 'builder', lane: 'build', to: 'review', text: 'built' });
  return sh(wt.build, 'rev-parse', 'HEAD');
}

const reviewer = (lens) => `review-${lens}`;
const startReview = (env, id, lens) => startLane({ file: env.file, id, who: reviewer(lens), lane: 'review', lens, cwd: env.wt[lens], config: env.config });
const pass = (env, id, lens, sha, extra = {}) => verdict({ file: env.file, id, who: reviewer(lens), lens, sha, pass: true, text: `${lens} ok`, config: env.config, ...extra });
const fail = (env, id, lens, sha, extra = {}) => verdict({ file: env.file, id, who: reviewer(lens), lens, sha, pass: false, text: `${lens} finds a bug`, config: env.config, ...extra });

// Runs a card through build and the whole panel. Returns the head every lens passed.
function toReviewed(env, id, files = ['login.txt']) {
  const head = build(env, id, files);
  for (const lens of ['qa', 'code']) {
    startReview(env, id, lens);
    pass(env, id, lens, head);
  }
  return head;
}

const card = (env, id) => store.getCard(store.load(env.file), id);

test('happy path: build → review panel → merged into the checked-out base', () => {
  const env = setup();
  const id = addReadyCard(env);

  const b = startLane({ file: env.file, id, who: 'builder', lane: 'build', cwd: env.wt.build, config: env.config });
  assert.equal(b.branch, `factory/${id}-anadir-pagina-de-login`);
  assert.equal(card(env, id).column, 'building');
  assert.equal(card(env, id).assignee, 'builder');
  assert.equal(sh(env.wt.build, 'branch', '--show-current'), b.branch);

  commitIn(env.wt.build, 'login.txt');
  handoff({ file: env.file, id, who: 'builder', lane: 'build', to: 'review', text: 'built' });
  const qa = startReview(env, id, 'qa');
  assert.equal(sh(env.wt.qa, 'branch', '--show-current'), '', 'reviewers work detached');
  assert.equal(qa.head, sh(env.wt.build, 'rev-parse', 'HEAD'));
  const { head } = startReview(env, id, 'code');
  assert.equal(card(env, id).run.worker, 'builder', 'reviewers never take over the card worktree');
  assert.notEqual(card(env, id).panel.lenses.qa.worktree, card(env, id).run.worktree);

  assert.equal(pass(env, id, 'qa', head).complete, false);
  assert.equal(pass(env, id, 'code', head).complete, true);
  assert.equal(card(env, id).run.reviewedSha, head);

  const r = mergeCard({ file: env.file, id, who: 'review-code', sha: head, cwd: env.wt.code, config: env.config });
  assert.equal(r.status, 'merged', r.message);
  assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
  assert.ok(fs.existsSync(path.join(env.repo, 'login.txt')), 'the main checkout followed the fast-forward');
  const done = card(env, id);
  assert.equal(done.column, 'done');
  assert.equal(done.assignee, null);
  assert.equal(done.run.mergedSha, head);
  assert.deepEqual(done.comments.map((c) => c.role), ['build', 'review:qa', 'review:code', 'merge']);
});

test('the spec lane turns a rough idea into a ready card, and the builder reuses its worktree', () => {
  const env = setup();
  const { file, wt, config } = env;
  const idea = store.update(file, (b) => store.addCard(b, { title: 'login con email', body: 'quiero que la gente entre con su email', column: 'spec' }));
  assert.equal(idea.column, 'spec');
  assert.equal(store.update(file, (b) => store.addCard(b, { title: 'sin cuerpo', column: 'spec' })).body, '', 'an idea needs no template');

  const s = startLane({ file, id: idea.id, who: 'spec-1', lane: 'spec', cwd: wt.build, config });
  assert.equal(s.head, sh(env.repo, 'rev-parse', 'main'));
  assert.equal(sh(wt.build, 'branch', '--show-current'), '', 'the spec writer reads the base, detached');
  assert.equal(card(env, idea.id).column, 'spec');
  assert.equal(card(env, idea.id).assignee, 'spec-1');

  assert.throws(() => handoff({ file, id: idea.id, who: 'spec-1', lane: 'spec', to: 'ready', text: 'spec written' }), /fails lint/);
  assert.equal(card(env, idea.id).column, 'spec', 'a card that fails lint never reaches ready');
  assert.throws(() => handoff({ file, id: idea.id, who: 'spec-1', lane: 'spec', to: 'building', text: 'x' }), /ready or blocked/);

  store.update(file, (b) => store.editCard(b, idea.id, { title: 'Añadir página de login', body: GOOD_BODY, labels: ['feature'] }));
  const ready = handoff({ file, id: idea.id, who: 'spec-1', lane: 'spec', to: 'ready', text: '[spec] ✅ spec written' });
  assert.equal(ready.column, 'ready');
  assert.equal(ready.assignee, null);
  assert.equal(ready.comments.at(-1).role, 'spec');

  const b = startLane({ file, id: idea.id, who: 'build-1', lane: 'build', cwd: wt.build, config });
  assert.equal(b.branch, `factory/${idea.id}-anadir-pagina-de-login`);
  assert.equal(card(env, idea.id).column, 'building');
});

test('a spec that needs a decision goes to blocked; new cards can be filed straight into ready only if they lint', () => {
  const env = setup();
  const { file, wt, config } = env;
  const idea = store.update(file, (b) => store.addCard(b, { title: 'precios', body: 'cambia los precios', column: 'spec' }));
  startLane({ file, id: idea.id, who: 'spec-1', lane: 'spec', cwd: wt.build, config });
  const blocked = handoff({ file, id: idea.id, who: 'spec-1', lane: 'spec', to: 'blocked', text: '🙋 ¿qué precios y a cuánto?' });
  assert.equal(blocked.column, 'blocked');

  assert.throws(() => store.update(file, (b) => store.addCard(b, { title: 'slice', body: 'no spec', column: 'ready' })), /must pass lint/);
  assert.equal(store.load(file).cards.length, 1, 'a rejected card is not saved');
  assert.equal(store.update(file, (b) => store.addCard(b, { title: 'slice', body: GOOD_BODY, column: 'ready' })).column, 'ready');
  assert.throws(() => store.update(file, (b) => store.addCard(b, { title: 'x', column: 'done' })), /new cards start in/);
});

test('the panel reviews in parallel: one claim per lens, one head, and the gate waits for every lens', () => {
  const env = setup();
  const { file, config } = env;
  const id = addReadyCard(env);
  const head = build(env, id);

  startReview(env, id, 'qa');
  startReview(env, id, 'code'); // both at once
  assert.deepEqual(store.claimsOf(card(env, id)).map((k) => [k.worker, k.lens]), [['review-qa', 'qa'], ['review-code', 'code']]);
  assert.equal(card(env, id).assignee, null, 'the card itself is not claimed while the panel works');
  assert.throws(() => startLane({ file, id, who: 'other', lane: 'review', lens: 'qa', cwd: env.wt.build, config }), /already claimed by review-qa/);
  assert.throws(() => startLane({ file, id, who: 'x', lane: 'review', cwd: env.wt.build, config }), /needs --lens/);
  assert.throws(() => startLane({ file, id, who: 'x', lane: 'review', lens: 'ops', cwd: env.wt.build, config }), /unknown lens "ops"/);

  assert.throws(() => pass(env, id, 'qa', 'deadbeef'), /the panel is reviewing/);
  assert.throws(() => verdict({ file, id, who: 'impostor', lens: 'qa', sha: head, pass: true, text: 'ok', config }), /claimed by review-qa, not impostor/);
  assert.throws(() => verdict({ file, id, who: 'review-qa', lens: 'qa', sha: head, pass: true, text: ' ', config }), /needs a comment/);

  pass(env, id, 'qa', head);
  assert.throws(() => startReview(env, id, 'qa'), /already has a verdict/);
  const early = mergeCard({ file, id, sha: head, cwd: env.repo, config });
  assert.equal(early.status, 'error', 'a card still in review cannot be merged');
  assert.match(early.message, /only cards in merge/);
  assert.equal(card(env, id).column, 'review');
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), head);

  const done = pass(env, id, 'code', head);
  assert.equal(done.complete, true);
  assert.equal(done.card.column, 'merge', 'the verdict that completes the panel hands the card to the merge agent');
  assert.equal(card(env, id).run.reviewedSha, head);
  assert.deepEqual(store.claimsOf(card(env, id)), []);
  assert.equal(mergeCard({ file, id, cwd: env.repo, config }).status, 'merged');
});

test('one failed lens ends the round for everyone, and the next round starts from scratch', () => {
  const env = setup();
  const { file, wt, config } = env;
  const id = addReadyCard(env);
  const head = build(env, id);
  startReview(env, id, 'qa');
  startReview(env, id, 'code');
  pass(env, id, 'qa', head);

  const r = fail(env, id, 'code', head);
  assert.equal(r.card.column, 'building');
  assert.equal(r.complete, false);
  assert.deepEqual(store.claimsOf(card(env, id)), [], 'every reviewer is released');
  assert.equal(card(env, id).comments.at(-1).role, 'review:code');

  startLane({ file, id, who: 'builder', lane: 'build', cwd: wt.build, config });
  const fixed = commitIn(wt.build, 'fix.txt');
  handoff({ file, id, who: 'builder', lane: 'build', to: 'review', text: 'fixed' });
  const panel = card(env, id).panel;
  assert.equal(panel.head, null);
  assert.equal(panel.lenses.qa.verdict, undefined, 'a pass on the old head does not carry over');
  assert.ok(panel.lenses.qa.worktree, 'each lens keeps its worktree for the next round');
  assert.equal(startReview(env, id, 'qa').head, fixed);

  // A reviewer still working when another lens fails finds the round over.
  const id2 = addReadyCard(env);
  sh(wt.build, 'switch', '-q', '--detach', 'main');
  const head2 = build(env, id2, ['other.txt']);
  startReview(env, id2, 'code');
  sh(wt.qa, 'switch', '-q', '--detach', 'main');
  pass(env, id, 'qa', fixed);
  startReview(env, id2, 'qa');
  fail(env, id2, 'code', head2);
  assert.throws(() => pass(env, id2, 'qa', head2), /this review round is over/);
});

test('a reviewer can raise a card to a person, and block it for a decision', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = build(env, id);
  startReview(env, id, 'qa');
  startReview(env, id, 'code');
  pass(env, id, 'qa', head);
  const r = pass(env, id, 'code', head, { escalate: 'toca el cálculo de precios' });
  assert.equal(r.complete, true);
  assert.ok(card(env, id).labels.includes('needs-human'));
  assert.match(card(env, id).comments.at(-1).text, /escalado a una persona: toca el cálculo de precios/);
  const gate = mergeCard({ file: env.file, id, cwd: env.repo, config: env.config });
  assert.equal(gate.code, 7);
  assert.deepEqual(gate.reasons, ['label needs-human']);

  const id2 = addReadyCard(env);
  sh(env.wt.build, 'switch', '-q', '--detach', 'main');
  const head2 = build(env, id2, ['b.txt']);
  startReview(env, id2, 'code');
  const blocked = fail(env, id2, 'code', head2, { to: 'blocked' });
  assert.equal(blocked.card.column, 'blocked');
  assert.ok(blocked.card.labels.includes('needs-you'));
  assert.ok(!blocked.card.labels.includes('merge-approval'), 'a blocked review is not a merge request');
  assert.throws(() => fail(env, id2, 'code', head2, { to: 'done' }), /round is over|building or blocked/);
});

test('CLI: the last verdict moves the card to merge, and the merge lane lands it', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = build(env, id);
  startReview(env, id, 'qa');
  startReview(env, id, 'code');
  const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, FACTORY_BOARD: env.file } });

  const first = cli(env.wt.qa, 'verdict', String(id), '--lens', 'qa', '--as', 'review-qa', '--sha', head, '--pass', '--text', 'qa ok');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual([JSON.parse(first.stdout).complete, JSON.parse(first.stdout).column], [false, 'review']);
  assert.equal(cli(env.wt.code, 'verdict', String(id), '--lens', 'code', '--as', 'review-code', '--sha', head, '--text', 'x').status, 1, 'needs --pass or --fail');

  const last = cli(env.wt.code, 'verdict', String(id), '--lens', 'code', '--as', 'review-code', '--sha', head, '--pass', '--text', 'code ok');
  assert.equal(last.status, 0, last.stdout + last.stderr);
  assert.deepEqual([JSON.parse(last.stdout).complete, JSON.parse(last.stdout).column], [true, 'merge']);
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), head, 'a verdict never merges by itself');

  // The merge agent: claims the card in merge, checks out the reviewed head, runs the gate.
  const start = cli(env.wt.code, 'start', String(id), '--lane', 'merge', '--as', 'merge-1');
  assert.equal(start.status, 0, start.stdout + start.stderr);
  assert.equal(JSON.parse(start.stdout).head, head);
  const landed = cli(env.wt.code, 'merge', String(id), '--sha', head, '--as', 'merge-1');
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(JSON.parse(landed.stdout).status, 'merged');
  assert.equal(card(env, id).column, 'done');
  assert.equal(card(env, id).assignee, null);
  assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
});

test('merge lane: a head that moved or a panel that is not complete goes back to review', () => {
  const env = setup();
  const { file, config } = env;
  const id = addReadyCard(env);
  toReviewed(env, id);
  assert.equal(card(env, id).column, 'merge');
  const late = commitIn(env.wt.build, 'late.txt'); // someone committed after the panel
  const moved = mergeCard({ file, id, cwd: env.repo, config });
  assert.equal(moved.status, 'head-moved');
  assert.equal(card(env, id).column, 'review', 'a new review round');
  assert.equal(card(env, id).panel.head, null);
  assert.match(card(env, id).comments.at(-1).text, /vuelve a revisión/);
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), late);

  // A card forced into merge with a lens still pending (or a lens added to the config) also goes back.
  const id2 = addReadyCard(env);
  sh(env.wt.build, 'switch', '-q', '--detach', 'main');
  const head2 = build(env, id2, ['b.txt']);
  startReview(env, id2, 'qa');
  pass(env, id2, 'qa', head2);
  store.update(file, (b) => store.moveCard(b, id2, 'merge', 'user', { force: true }));
  const pending = mergeCard({ file, id: id2, sha: head2, cwd: env.repo, config });
  assert.equal(pending.code, 11);
  assert.deepEqual(pending.pending, ['code']);
  assert.equal(card(env, id2).column, 'review');
});

test('merge lane: hands only to blocked, and the merge agent can raise a card to a person', () => {
  const env = setup();
  const { file, wt, config } = env;
  const id = addReadyCard(env);
  const head = toReviewed(env, id);
  startLane({ file, id, who: 'merge-1', lane: 'merge', cwd: wt.qa, config });
  assert.equal(card(env, id).assignee, 'merge-1');
  assert.throws(() => handoff({ file, id, who: 'merge-1', lane: 'merge', to: 'done', text: 'x' }), /hands cards to blocked/);
  // The agent saw a business area the card did not admit: it adds the label, the gate holds the merge.
  store.update(file, (b) => store.editCard(b, id, { labels: [...card(env, id).labels, 'pricing'] }));
  const held = mergeCard({ file, id, sha: head, who: 'merge-1', cwd: env.repo, config });
  assert.equal(held.code, 7);
  assert.deepEqual(held.reasons, ['label pricing']);
  assert.equal(card(env, id).column, 'blocked');
  assert.ok(card(env, id).labels.includes('merge-approval'));
  assert.equal(card(env, id).assignee, null);
});

test('merge refuses a head that moved after review', () => {
  const env = setup();
  const id = addReadyCard(env);
  const reviewed = toReviewed(env, id);
  commitIn(env.wt.build, 'late.txt');
  const r = mergeCard({ file: env.file, id, sha: reviewed, cwd: env.repo, config: env.config });
  assert.equal(r.status, 'head-moved');
  assert.equal(r.code, 6);
  assert.equal(card(env, id).column, 'review');
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), reviewed);
});

test('a branch behind the base is rebased by the gate when that leaves the reviewed change intact', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReviewed(env, id);
  const other = commitIn(env.repo, 'other.txt'); // another card landed on main meanwhile
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.status, 'merged', r.message);
  assert.notEqual(r.land, head, 'it landed a rebased commit');
  assert.equal(sh(env.repo, 'rev-parse', 'main'), r.land);
  assert.equal(sh(env.repo, 'rev-parse', `${r.land}~1`), other, 'on top of the new base');
  assert.ok(fs.existsSync(path.join(env.repo, 'login.txt')) && fs.existsSync(path.join(env.repo, 'other.txt')));
  const c = card(env, id);
  assert.equal(c.column, 'done', 'no new build, no new review');
  assert.deepEqual([c.run.reviewedSha, c.run.mergedSha], [head, r.land]);
  assert.match(c.comments.at(-1).text, /rebasado sobre main: .* el mismo cambio que revisó el panel/);
  // The builder's checkout of the branch followed, so the branch reads as merged for cleanup.
  assert.equal(sh(env.wt.build, 'rev-parse', 'HEAD'), r.land);
});

test('a clean rebase that changes what was reviewed still goes back to building', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReviewed(env, id, ['login.txt', 'extra.txt']);
  // Another card lands the very same login.txt in a commit of its own: the rebase drops that part,
  // so the change is no longer the one the panel reviewed.
  fs.writeFileSync(path.join(env.repo, 'login.txt'), 'x');
  sh(env.repo, 'add', 'login.txt');
  sh(env.repo, 'commit', '-qm', 'another card adds the same login.txt');
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 8, r.message);
  assert.equal(card(env, id).column, 'building');
  assert.ok(!fs.existsSync(path.join(env.repo, 'extra.txt')), 'nothing landed');
});

test('a branch behind the base goes back to building when the rebase conflicts', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReviewed(env, id, ['login.txt']);
  commitIn(env.repo, 'login.txt', 'someone else\'s login'); // the same file, different content
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 8);
  const c = card(env, id);
  assert.equal(c.column, 'building');
  assert.equal(c.assignee, null);
  assert.match(c.comments.at(-1).text, /rebase/);
  assert.equal(sh(env.repo, 'worktree', 'list').split('\n').filter((l) => l.includes('rebase-')).length, 0, 'no rebase worktree left behind');
});

test('failing verify goes back to building with the output', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReviewed(env, id, ['FAIL']);
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 9);
  assert.equal(card(env, id).column, 'building');
  assert.match(card(env, id).comments.at(-1).text, /node check\.js/);
  assert.equal(sh(env.repo, 'worktree', 'list').split('\n').length, 4, 'no temporary worktree left behind');
});

test('high risk waits for a person, who merges from blocked', () => {
  const env = setup();
  const id = addReadyCard(env, { body: GOOD_BODY.replace('🟢 **Low**', '🔴 **High**') });
  const head = toReviewed(env, id);
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 7);
  assert.deepEqual(r.reasons, ['riesgo high']);
  assert.equal(card(env, id).column, 'blocked');
  assert.ok(card(env, id).labels.includes('needs-you'));
  assert.ok(card(env, id).labels.includes('merge-approval'));

  const human = mergeCard({ file: env.file, id, sha: head, human: true, who: 'user', cwd: env.repo, config: env.config });
  assert.equal(human.status, 'merged', human.message);
  assert.equal(card(env, id).column, 'done');
  assert.ok(!card(env, id).labels.includes('needs-you'));
  assert.ok(!card(env, id).labels.includes('merge-approval'));
});

test('business labels, sensitive paths and big diffs also wait for a person', () => {
  const env = setup();
  const id = addReadyCard(env, { labels: ['pricing'] });
  const head = toReviewed(env, id, ['login.txt', 'billing/prices/eu.txt']);
  const merge = { ...env.config.merge, maxLines: 1, humanPaths: ['billing/**', '**/*.sql'] };
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: { ...env.config, merge } });
  assert.equal(r.code, 7);
  assert.deepEqual(r.reasons, ['label pricing', 'rutas sensibles: billing/prices/eu.txt', 'diff grande: 2 líneas (máximo 1)']);
  assert.match(card(env, id).comments.at(-1).text, /rutas sensibles: billing\/prices\/eu\.txt/);
  for (const label of ['auth', 'payments', 'pricing', 'schema', 'ops', 'needs-human']) assert.ok(env.config.merge.humanLabels.includes(label), label);
});

test('with the base checked out nowhere, the gate moves the ref', () => {
  const env = setup();
  sh(env.repo, 'switch', '-q', '--detach');
  const id = addReadyCard(env);
  const head = toReviewed(env, id);
  assert.equal(mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config }).status, 'merged');
  assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
});

test('uncommitted changes in the base checkout stop a merge only when the merge touches them', () => {
  const env = setup();
  // An edit to a file the merge does not touch: the merge lands and the edit stays.
  const other = addReadyCard(env);
  const otherHead = toReviewed(env, other, ['other.txt']);
  fs.appendFileSync(path.join(env.repo, 'check.js'), '// local edit\n');
  assert.equal(mergeCard({ file: env.file, id: other, sha: otherHead, cwd: env.wt.code, config: env.config }).status, 'merged');
  assert.match(fs.readFileSync(path.join(env.repo, 'check.js'), 'utf8'), /local edit/, 'the person keeps their change');
  sh(env.repo, 'checkout', '--', 'check.js');

  // A local file the merge would overwrite: git refuses and the card waits for the person.
  const id = addReadyCard(env);
  sh(env.wt.build, 'switch', '-q', '--detach', 'main');
  const head = toReviewed(env, id, ['login.txt']);
  fs.writeFileSync(path.join(env.repo, 'login.txt'), 'mine');
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.wt.code, config: env.config });
  assert.equal(r.code, 10);
  assert.equal(fs.readFileSync(path.join(env.repo, 'login.txt'), 'utf8'), 'mine', 'git touched nothing');
  assert.equal(card(env, id).column, 'blocked', 'only the person can clean their checkout');
  assert.ok(card(env, id).labels.includes('needs-you'));
  assert.ok(!card(env, id).labels.includes('merge-approval'), 'not a merge request: the merge itself was fine');
  assert.deepEqual(store.claimsOf(card(env, id)), [], 'nobody holds it');
  // Once the person clears it and moves the card back to merge, the same reviewed commit lands.
  fs.rmSync(path.join(env.repo, 'login.txt'));
  store.update(env.file, (b) => store.moveCard(b, id, 'merge', 'user'));
  assert.ok(!card(env, id).labels.includes('needs-you'), 'leaving blocked clears the request');
  assert.equal(mergeCard({ file: env.file, id, cwd: env.repo, config: env.config }).status, 'merged');
});

test('lanes refuse the wrong place, column, claimer or destination', () => {
  const env = setup();
  const { file, wt, config, repo } = env;
  const id = addReadyCard(env);
  assert.throws(() => startLane({ file, id, who: 'b', lane: 'build', cwd: repo, config }), /main checkout/);
  assert.throws(() => startLane({ file, id, who: 'r', lane: 'review', lens: 'code', cwd: wt.code, config }), /no branch to review/);
  assert.throws(() => startLane({ file, id, who: 's', lane: 'spec', cwd: wt.code, config }), /goes to building from ready, not spec/);
  assert.throws(() => startLane({ file, id, who: 'b', lane: 'build', lens: 'qa', cwd: wt.build, config }), /only for the review lane/);
  fs.appendFileSync(path.join(wt.build, 'check.js'), '//\n');
  assert.throws(() => startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config }), /uncommitted/);
  sh(wt.build, 'checkout', '--', 'check.js');

  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  assert.throws(() => startLane({ file, id, who: 'other', lane: 'build', cwd: wt.qa, config }), /already claimed/);
  assert.throws(() => startLane({ file, id, who: 'r', lane: 'review', lens: 'code', cwd: wt.code, config }), /is in building; reviewers work on cards in review/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'done', text: 'x' }), /review or blocked/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'qa', text: 'x' }), /review or blocked/);
  assert.throws(() => handoff({ file, id, who: 'x', lane: 'build', to: 'review', text: 'x' }), /claimed by b/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'review', text: ' ' }), /needs a comment/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'review', to: 'done', text: 'x' }), /factory verdict/);
  const early = mergeCard({ file, id, sha: 'abc', cwd: repo, config });
  assert.equal(early.status, 'error');
  assert.match(early.message, /only cards in merge/);
  assert.equal(card(env, id).column, 'building');
});

test('a failed checkout releases the claim', () => {
  const env = setup();
  const id = addReadyCard(env);
  // The branch is checked out in the qa worktree, so the build worktree cannot switch to it.
  sh(env.wt.qa, 'switch', '-q', '-c', `factory/${id}-anadir-pagina-de-login`);
  assert.throws(() => startLane({ file: env.file, id, who: 'b', lane: 'build', cwd: env.wt.build, config: env.config }), /git switch/);
  assert.equal(card(env, id).assignee, null);
});

test('a qa-labelled card is tested on the base branch and closes through the gate without a merge', () => {
  const env = setup();
  const id = addReadyCard(env, { labels: ['qa'] });
  const main = sh(env.repo, 'rev-parse', 'main');
  assert.throws(() => startLane({ file: env.file, id, who: 'b', lane: 'build', cwd: env.wt.build, config: env.config }), /goes to qa/);
  const r = startLane({ file: env.file, id, who: 't', lane: 'qa', cwd: env.wt.qa, config: env.config });
  assert.equal(r.branch, null);
  assert.equal(r.head, main);
  assert.equal(card(env, id).column, 'qa');
  assert.throws(() => handoff({ file: env.file, id, who: 't', lane: 'qa', to: 'review', text: 'x' }), /hands cards to blocked/);

  const closed = mergeCard({ file: env.file, id, who: 't', cwd: env.wt.qa, config: env.config });
  assert.equal(closed.status, 'merged');
  assert.equal(card(env, id).column, 'done');
  assert.equal(card(env, id).assignee, null);
  assert.equal(sh(env.repo, 'rev-parse', 'main'), main);
});

// Sends a card back from the panel four times. Returns the card after the fourth.
function bounceFourTimes(env, id) {
  const { file, wt, config } = env;
  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  let head = commitIn(wt.build, 'a.txt');
  let last;
  for (let round = 1; round <= 4; round++) {
    handoff({ file, id, who: 'b', lane: 'build', to: 'review', text: 'built' });
    startReview(env, id, 'code');
    last = fail(env, id, 'code', head).card;
    if (round < 4) {
      assert.equal(last.column, 'building', `round ${round}`);
      startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
      head = commitIn(wt.build, `round-${round}.txt`);
    }
  }
  return last;
}

test('the fourth send-back goes to blocked with needs-you', () => {
  const env = setup();
  const id = addReadyCard(env);
  const c = bounceFourTimes(env, id);
  assert.equal(c.column, 'blocked');
  assert.ok(c.labels.includes('needs-you'));
  assert.match(c.comments.at(-1).text, /sin converger/);
  assert.equal(store.bounces(card(env, id)), 3);
});

test('a person approves a held merge from the web API, pinned to the reviewed commit', async () => {
  const { createServer } = await import('../src/server.mjs');
  const env = setup();
  const id = addReadyCard(env, { body: GOOD_BODY.replace('🟢 **Low**', '🔴 **High**') });
  const head = toReviewed(env, id);
  assert.equal(mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config }).code, 7);
  assert.equal(card(env, id).run.reviewedSha, head, 'the gate pins what the person approves');

  const server = createServer({ boardFile: env.file, repoRoot: env.repo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ code: r.status, body: await r.json() }));
  try {
    assert.deepEqual((await (await fetch(`${base}/api/board`)).json()).lenses, ['qa', 'code'], 'the board knows the project lenses');
    const other = addReadyCard(env);
    assert.equal((await post(`/api/cards/${other}/approve`, {})).code, 400, 'only held merges');
    commitIn(env.wt.build, 'sneaky.txt'); // pushed after the person looked
    const moved = await post(`/api/cards/${id}/approve`, { sha: head });
    assert.equal(moved.body.status, 'head-moved');
    sh(env.wt.build, 'reset', '-q', '--hard', head);
    const ok = await post(`/api/cards/${id}/approve`, { sha: head });
    assert.equal(ok.body.status, 'merged', ok.body.message);
    assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
    assert.equal(card(env, id).column, 'done');
  } finally {
    server.close();
  }
});

test('github mirror: factory pr pushes and opens or updates the PR; the gate pushes the base', async () => {
  const { openPr } = await import('../src/github.mjs');
  const env = setup();
  const remote = path.join(path.dirname(env.repo), 'remote.git');
  sh(path.dirname(env.repo), 'init', '-q', '--bare', remote);
  sh(env.repo, 'remote', 'add', 'origin', remote);
  sh(env.repo, 'push', '-q', 'origin', 'main');

  // A fake gh: logs each call; `pr view` fails until `pr create` has run.
  const fake = path.join(path.dirname(env.repo), 'fake-gh.mjs');
  const log = path.join(path.dirname(env.repo), 'gh.log');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const args = process.argv.slice(2), log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + String.fromCharCode(10));
const created = fs.readFileSync(log, 'utf8').includes('"create"');
if (args[1] === 'view') { if (!created) process.exit(1); console.log(JSON.stringify({ url: 'https://github.com/o/r/pull/7' })); }
if (args[1] === 'create') console.log('https://github.com/o/r/pull/7');
`);
  const prev = process.env.FACTORY_GH;
  process.env.FACTORY_GH = `node "${fake}"`;
  try {
    const id = addReadyCard(env);
    const head = toReviewed(env, id);
    const config = { ...env.config, github: { ...env.config.github, pushBase: true } };
    const first = openPr({ card: card(env, id), cwd: env.repo, config });
    assert.deepEqual(first, { url: 'https://github.com/o/r/pull/7', created: true });
    assert.equal(sh(remote, 'rev-parse', card(env, id).run.branch), head, 'branch pushed');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const create = calls.find((c) => c[1] === 'create');
    assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', card(env, id).run.branch, '--title', 'Añadir página de login']);
    assert.ok(create.includes('--draft'));
    assert.equal(openPr({ card: card(env, id), cwd: env.repo, config }).created, false, 'second call edits');

    const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config });
    assert.equal(r.status, 'merged');
    assert.deepEqual(r.pushed, { pushed: true });
    assert.equal(sh(remote, 'rev-parse', 'main'), head, 'remote base fast-forwarded');
  } finally {
    if (prev === undefined) delete process.env.FACTORY_GH;
    else process.env.FACTORY_GH = prev;
  }
});

test('only merges the gate held can be approved: a card blocked by bounces cannot', async () => {
  const { createServer } = await import('../src/server.mjs');
  const env = setup();
  const { file, config } = env;
  const id = addReadyCard(env);
  const blocked = bounceFourTimes(env, id);
  assert.equal(blocked.column, 'blocked');
  assert.ok(blocked.labels.includes('needs-you'));
  assert.ok(!blocked.labels.includes('merge-approval'));

  const head = sh(env.repo, 'rev-parse', blocked.run.branch);
  assert.equal(mergeCard({ file, id, sha: head, human: true, cwd: env.repo, config }).status, 'error', 'CLI --human refuses');
  const server = createServer({ boardFile: file, repoRoot: env.repo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/cards/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: head }) });
    assert.equal(res.status, 400, 'web refuses');
  } finally {
    server.close();
  }
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), head);
});

test('a builder cannot hand off to review new commits without `Card: #<id>`; reviewed ones are not checked again', () => {
  const env = setup();
  const { file, wt, config } = env;
  const id = addReadyCard(env);
  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  commitIn(wt.build, 'login.txt'); // "add login.txt", no Card line
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'review', text: 'built', cwd: wt.build, config }), (err) => err.message.includes(`lack the line \`Card: #${id}\``) && err.message.includes(`--trailer "Card: #${id}"`));
  assert.equal(card(env, id).column, 'building', 'the card did not move');
  // Fixed the way the message says: every commit gets the line.
  sh(wt.build, 'rebase', '-q', 'main', '--exec', `git commit -q --amend --no-edit --trailer "Card: #${id}"`);
  const head = sh(wt.build, 'rev-parse', 'HEAD');
  handoff({ file, id, who: 'b', lane: 'build', to: 'review', text: 'built', cwd: wt.build, config });
  assert.equal(card(env, id).column, 'review');

  // A later round: the commit the panel already saw is not checked again, only the new one.
  startReview(env, id, 'code');
  fail(env, id, 'code', head);
  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  fs.writeFileSync(path.join(wt.build, 'fix.txt'), 'x');
  sh(wt.build, 'add', 'fix.txt');
  sh(wt.build, 'commit', '-qm', `🐛 [fix] login: fix\n\n- C1\nCard: #${id}`);
  handoff({ file, id, who: 'b', lane: 'build', to: 'review', text: 'fixed', cwd: wt.build, config });
  assert.equal(card(env, id).column, 'review');
});
