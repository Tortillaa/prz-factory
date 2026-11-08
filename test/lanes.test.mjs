// Fase 2 end to end on real git repos: build → qa → review → merge gate, and every refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from '../src/store.mjs';
import { startLane, handoff } from '../src/lanes.mjs';
import { mergeCard } from '../src/merge.mjs';
import { loadConfig } from '../src/config.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repo whose verify fails when a file named FAIL exists, plus one worktree per lane.
function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lanes-')));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify({ verify: ['node check.js'] }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  const wt = {};
  for (const lane of ['build', 'qa', 'review']) {
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
  fs.writeFileSync(path.join(cwd, name), content);
  sh(cwd, 'add', name);
  sh(cwd, 'commit', '-qm', `add ${name}`);
  return sh(cwd, 'rev-parse', 'HEAD');
}

// Runs a card through build, qa and review. Returns the reviewed head.
function toReview(env, id, files = ['login.txt']) {
  const { file, wt, config } = env;
  startLane({ file, id, who: 'builder', lane: 'build', cwd: wt.build, config });
  for (const f of files) commitIn(wt.build, f);
  handoff({ file, id, who: 'builder', lane: 'build', to: 'qa', text: 'built' });
  startLane({ file, id, who: 'tester', lane: 'qa', cwd: wt.qa, config });
  handoff({ file, id, who: 'tester', lane: 'qa', to: 'review', text: 'tested' });
  const r = startLane({ file, id, who: 'reviewer', lane: 'review', cwd: wt.review, config });
  return r.head;
}

const card = (env, id) => store.getCard(store.load(env.file), id);

test('happy path: build → qa → review → merged into the checked-out base', () => {
  const env = setup();
  const id = addReadyCard(env);

  const build = startLane({ file: env.file, id, who: 'builder', lane: 'build', cwd: env.wt.build, config: env.config });
  assert.equal(build.branch, `factory/${id}-anadir-pagina-de-login`);
  assert.equal(card(env, id).column, 'building');
  assert.equal(card(env, id).assignee, 'builder');
  assert.equal(sh(env.wt.build, 'branch', '--show-current'), build.branch);

  commitIn(env.wt.build, 'login.txt');
  handoff({ file: env.file, id, who: 'builder', lane: 'build', to: 'qa', text: 'built' });
  const qa = startLane({ file: env.file, id, who: 'tester', lane: 'qa', cwd: env.wt.qa, config: env.config });
  assert.equal(sh(env.wt.qa, 'branch', '--show-current'), '', 'qa works detached');
  assert.equal(qa.head, sh(env.wt.build, 'rev-parse', 'HEAD'));
  handoff({ file: env.file, id, who: 'tester', lane: 'qa', to: 'review', text: 'tested' });
  const { head } = startLane({ file: env.file, id, who: 'reviewer', lane: 'review', cwd: env.wt.review, config: env.config });

  const r = mergeCard({ file: env.file, id, who: 'reviewer', sha: head, cwd: env.wt.review, config: env.config });
  assert.equal(r.status, 'merged', r.message);
  assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
  assert.ok(fs.existsSync(path.join(env.repo, 'login.txt')), 'the main checkout followed the fast-forward');
  const done = card(env, id);
  assert.equal(done.column, 'done');
  assert.equal(done.assignee, null);
  assert.equal(done.run.mergedSha, head);
  assert.deepEqual(done.comments.map((c) => c.role), ['build', 'qa', 'merge']);
});

test('merge refuses a head that moved after review', () => {
  const env = setup();
  const id = addReadyCard(env);
  const reviewed = toReview(env, id);
  commitIn(env.wt.build, 'late.txt');
  const r = mergeCard({ file: env.file, id, sha: reviewed, cwd: env.repo, config: env.config });
  assert.equal(r.status, 'head-moved');
  assert.equal(r.code, 6);
  assert.equal(card(env, id).column, 'review');
  assert.notEqual(sh(env.repo, 'rev-parse', 'main'), reviewed);
});

test('a branch behind the base goes back to building', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReview(env, id);
  commitIn(env.repo, 'other.txt'); // someone else landed on main
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 8);
  const c = card(env, id);
  assert.equal(c.column, 'building');
  assert.equal(c.assignee, null);
  assert.match(c.comments.at(-1).text, /rebase/);
});

test('failing verify goes back to building with the output', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReview(env, id, ['FAIL']);
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 9);
  assert.equal(card(env, id).column, 'building');
  assert.match(card(env, id).comments.at(-1).text, /node check\.js/);
  assert.equal(sh(env.repo, 'worktree', 'list').split('\n').length, 4, 'no temporary worktree left behind');
});

test('high risk waits for a person, who merges from blocked', () => {
  const env = setup();
  const id = addReadyCard(env, { body: GOOD_BODY.replace('🟢 **Low**', '🔴 **High**') });
  const head = toReview(env, id);
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config });
  assert.equal(r.code, 7);
  assert.deepEqual(r.reasons, ['riesgo high']);
  assert.equal(card(env, id).column, 'blocked');
  assert.ok(card(env, id).labels.includes('needs-you'));

  const human = mergeCard({ file: env.file, id, sha: head, human: true, who: 'user', cwd: env.repo, config: env.config });
  assert.equal(human.status, 'merged', human.message);
  assert.equal(card(env, id).column, 'done');
  assert.ok(!card(env, id).labels.includes('needs-you'));
});

test('big diffs and sensitive labels also wait for a person', () => {
  const env = setup();
  const id = addReadyCard(env, { labels: ['auth'] });
  const head = toReview(env, id);
  const config = { ...env.config, merge: { ...env.config.merge, maxLines: 0 } };
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config });
  assert.equal(r.code, 7);
  assert.deepEqual(r.reasons, ['label auth', 'diff grande: 1 líneas (máximo 0)']);
});

test('with the base checked out nowhere, the gate moves the ref', () => {
  const env = setup();
  sh(env.repo, 'switch', '-q', '--detach');
  const id = addReadyCard(env);
  const head = toReview(env, id);
  assert.equal(mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config }).status, 'merged');
  assert.equal(sh(env.repo, 'rev-parse', 'main'), head);
});

test('a dirty base checkout stops the merge without touching the card', () => {
  const env = setup();
  const id = addReadyCard(env);
  const head = toReview(env, id);
  fs.appendFileSync(path.join(env.repo, 'check.js'), '// local edit\n');
  const r = mergeCard({ file: env.file, id, sha: head, cwd: env.wt.review, config: env.config });
  assert.equal(r.code, 10);
  assert.equal(card(env, id).column, 'review');
});

test('lanes refuse the wrong place, column, claimer or destination', () => {
  const env = setup();
  const { file, wt, config, repo } = env;
  const id = addReadyCard(env);
  assert.throws(() => startLane({ file, id, who: 'b', lane: 'build', cwd: repo, config }), /main checkout/);
  assert.throws(() => startLane({ file, id, who: 'r', lane: 'review', cwd: wt.review, config }), /goes to building from ready, not review/);
  fs.appendFileSync(path.join(wt.build, 'check.js'), '//\n');
  assert.throws(() => startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config }), /uncommitted/);
  sh(wt.build, 'checkout', '--', 'check.js');

  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  assert.throws(() => startLane({ file, id, who: 'other', lane: 'build', cwd: wt.qa, config }), /already claimed/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'done', text: 'x' }), /qa or blocked/);
  assert.throws(() => handoff({ file, id, who: 'x', lane: 'build', to: 'qa', text: 'x' }), /claimed by b/);
  assert.throws(() => handoff({ file, id, who: 'b', lane: 'build', to: 'qa', text: ' ' }), /needs a comment/);
  const early = mergeCard({ file, id, sha: 'abc', cwd: repo, config });
  assert.equal(early.status, 'error');
  assert.match(early.message, /only cards in review/);
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

test('a qa-labelled card is tested on the base branch without a build', () => {
  const env = setup();
  const id = addReadyCard(env, { labels: ['qa'] });
  assert.throws(() => startLane({ file: env.file, id, who: 'b', lane: 'build', cwd: env.wt.build, config: env.config }), /goes to qa/);
  const r = startLane({ file: env.file, id, who: 't', lane: 'qa', cwd: env.wt.qa, config: env.config });
  assert.equal(r.branch, null);
  assert.equal(r.head, sh(env.repo, 'rev-parse', 'main'));
  assert.equal(card(env, id).column, 'qa');
});
