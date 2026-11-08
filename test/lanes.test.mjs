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
  assert.ok(card(env, id).labels.includes('merge-approval'));

  const human = mergeCard({ file: env.file, id, sha: head, human: true, who: 'user', cwd: env.repo, config: env.config });
  assert.equal(human.status, 'merged', human.message);
  assert.equal(card(env, id).column, 'done');
  assert.ok(!card(env, id).labels.includes('needs-you'));
  assert.ok(!card(env, id).labels.includes('merge-approval'));
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
  assert.equal(card(env, id).assignee, null, 'released so the run can retry it');
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

test('the fourth send-back goes to blocked with needs-you', () => {
  const env = setup();
  const id = addReadyCard(env);
  const { file, wt, config } = env;
  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  commitIn(wt.build, 'a.txt');
  for (let round = 1; round <= 4; round++) {
    handoff({ file, id, who: 'b', lane: 'build', to: 'qa', text: 'built' });
    startLane({ file, id, who: 't', lane: 'qa', cwd: wt.qa, config });
    const c = handoff({ file, id, who: 't', lane: 'qa', to: 'building', text: 'fails' });
    if (round < 4) {
      assert.equal(c.column, 'building', `round ${round}`);
      startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
    } else {
      assert.equal(c.column, 'blocked');
      assert.ok(c.labels.includes('needs-you'));
      assert.match(c.comments.at(-1).text, /sin converger/);
    }
  }
  assert.equal(store.bounces(card(env, id)), 3);
});

test('a qa card closes through the gate without a merge', () => {
  const env = setup();
  const id = addReadyCard(env, { labels: ['qa'] });
  const main = sh(env.repo, 'rev-parse', 'main');
  startLane({ file: env.file, id, who: 't', lane: 'qa', cwd: env.wt.qa, config: env.config });
  handoff({ file: env.file, id, who: 't', lane: 'qa', to: 'review', text: 'all good' });
  startLane({ file: env.file, id, who: 'r', lane: 'review', cwd: env.wt.review, config: env.config });
  const r = mergeCard({ file: env.file, id, cwd: env.repo, config: env.config });
  assert.equal(r.status, 'merged');
  assert.equal(card(env, id).column, 'done');
  assert.equal(sh(env.repo, 'rev-parse', 'main'), main);
});

test('a person approves a held merge from the web API, pinned to the reviewed commit', async () => {
  const { createServer } = await import('../src/server.mjs');
  const env = setup();
  const id = addReadyCard(env, { body: GOOD_BODY.replace('🟢 **Low**', '🔴 **High**') });
  const head = toReview(env, id);
  assert.equal(mergeCard({ file: env.file, id, sha: head, cwd: env.repo, config: env.config }).code, 7);
  assert.equal(card(env, id).run.reviewedSha, head, 'the gate pins what the person approves');

  const server = createServer({ boardFile: env.file, repoRoot: env.repo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (p, body) => fetch(`http://localhost:${server.address().port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ code: r.status, body: await r.json() }));
  try {
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
    const head = toReview(env, id);
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
  const { file, wt, config } = env;
  const id = addReadyCard(env);
  startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  commitIn(wt.build, 'broken.txt');
  for (let round = 1; round <= 4; round++) {
    handoff({ file, id, who: 'b', lane: 'build', to: 'qa', text: 'built' });
    startLane({ file, id, who: 't', lane: 'qa', cwd: wt.qa, config });
    handoff({ file, id, who: 't', lane: 'qa', to: 'building', text: 'still broken' });
    if (round < 4) startLane({ file, id, who: 'b', lane: 'build', cwd: wt.build, config });
  }
  const blocked = card(env, id);
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
