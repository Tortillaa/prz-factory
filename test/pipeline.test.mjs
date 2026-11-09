// The pieces the spec → build → panel → merge pipeline adds to the board, the config and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as store from '../src/store.mjs';
import { loadConfig, DEFAULTS, LENSES } from '../src/config.mjs';
import { humanReasons } from '../src/merge.mjs';
import { globToRegExp } from '../src/git.mjs';
import { findLeftovers } from '../src/cleanup.mjs';
import { block } from '../src/agentsmd.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const empty = () => ({ version: 1, nextId: 1, cards: [] });

test('spec is a column between backlog and ready, and old boards gain an empty panel', () => {
  assert.deepEqual(store.COLUMNS, ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'blocked', 'done']);
  const file = path.join(tmp('factory-board-'), 'board.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, nextId: 2, cards: [{ id: 1, title: 'old', column: 'review', labels: [] }] }));
  assert.deepEqual(store.load(file).cards[0].panel, { head: null, lenses: {} });
});

test('entering review starts a new panel round; leaving it ends every claim', () => {
  const b = empty();
  store.addCard(b, { title: 'x', body: GOOD_BODY });
  store.moveCard(b, 1, 'review', null, { force: true });
  store.claimLens(b, 1, 'qa', 'review-qa-1');
  assert.throws(() => store.claimLens(b, 1, 'qa', 'someone-else'), /already claimed by review-qa-1/);
  assert.deepEqual(store.holding(b.cards[0], 'review-qa-1'), { lens: 'qa' });
  assert.equal(store.holding(b.cards[0], 'nobody'), null);
  Object.assign(b.cards[0].panel.lenses.qa, { worktree: '/wt/qa', verdict: 'pass', sha: 'abc' });
  b.cards[0].panel.head = 'abc';

  store.moveCard(b, 1, 'building');
  assert.deepEqual(store.claimsOf(b.cards[0]), []);
  assert.throws(() => store.claimLens(b, 1, 'qa', 'review-qa-1'), /reviewers work on cards in review/);
  store.moveCard(b, 1, 'review');
  assert.deepEqual(b.cards[0].panel, { head: null, lenses: { qa: { worktree: '/wt/qa' } } }, 'verdicts go, the worktree stays');
});

test('the request labels leave with the card when it leaves blocked', () => {
  const b = empty();
  store.addCard(b, { title: 'x', body: GOOD_BODY, labels: ['feature', 'needs-you', 'merge-approval', 'pricing'] });
  store.moveCard(b, 1, 'blocked');
  assert.ok(b.cards[0].labels.includes('needs-you'));
  store.moveCard(b, 1, 'spec');
  assert.deepEqual(b.cards[0].labels, ['feature', 'pricing'], 'the business label is not a request: it stays');
});

test('config: review lenses and sensitive paths are validated, and defaults cover the business areas', () => {
  const dir = tmp('factory-config-');
  const write = (c) => fs.writeFileSync(path.join(dir, 'factory.config.json'), JSON.stringify(c));
  write({ verify: ['x'] });
  const { config } = loadConfig(dir);
  assert.deepEqual(config.review.lenses, ['qa', 'security', 'code', 'ops']);
  assert.deepEqual(config.merge.humanPaths, []);
  assert.deepEqual(config.merge.humanLabels, ['auth', 'payments', 'pricing', 'schema', 'ops', 'money', 'needs-human']);
  assert.deepEqual(LENSES, DEFAULTS.review.lenses);

  write({ review: { lenses: ['code'] }, merge: { humanPaths: ['db/**'] } });
  assert.deepEqual(loadConfig(dir).config.review.lenses, ['code']);
  assert.deepEqual(loadConfig(dir).config.merge.humanPaths, ['db/**']);
  for (const bad of [{ review: { lenses: [] } }, { review: { lenses: ['vibes'] } }, { review: { lenses: ['qa', 'qa'] } }]) {
    write(bad);
    assert.throws(() => loadConfig(dir), /"review\.lenses" must list/);
  }
  write({ merge: { humanPaths: 'db' } });
  assert.throws(() => loadConfig(dir), /"merge\.humanPaths" must be an array/);
});

test('sensitive paths: globs match whole paths, ** crosses folders, * does not', () => {
  const hit = (glob, file) => globToRegExp(glob).test(file);
  assert.ok(hit('src/billing/**', 'src/billing/a/b.js'));
  assert.ok(!hit('src/billing/**', 'src/billingx.js'));
  assert.ok(hit('**/*.sql', 'db/migrations/1.sql'));
  assert.ok(hit('**/*.sql', '1.sql'));
  assert.ok(hit('factory.config.json', 'factory.config.json'));
  assert.ok(!hit('factory.config.json', 'x/factory.config.json'));
  assert.ok(!hit('src/*.mjs', 'src/a/b.mjs'));
  assert.ok(!hit('a.b', 'aXb'), 'a dot is a dot');

  const card = { body: GOOD_BODY, labels: ['feature'] };
  const policy = { ...DEFAULTS.merge, humanPaths: ['migrations/**'] };
  assert.deepEqual(humanReasons(card, 10, policy, ['src/a.js']), []);
  assert.deepEqual(humanReasons(card, 10, policy, ['src/a.js', 'migrations/002.sql']), ['rutas sensibles: migrations/002.sql']);
  const many = Array.from({ length: 7 }, (_, i) => `migrations/${i}.sql`);
  assert.match(humanReasons(card, 10, policy, many)[0], /y 2 más$/);
});

test('cleanup knows the reviewers worktrees: kept while the card is active, removed once it is done', () => {
  const dir = tmp('factory-clean-');
  const r = path.join(dir, 'repo');
  fs.mkdirSync(r);
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  sh(r, 'init', '-q', '-b', 'main');
  sh(r, 'config', 'user.email', 't@e.com');
  sh(r, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a');
  sh(r, 'add', '.');
  sh(r, 'commit', '-qm', 'init');
  for (const name of ['factory-1-security', 'factory-2-code']) sh(r, 'worktree', 'add', '-q', '-b', `me/${name}`, path.join(dir, name));

  const b = empty();
  store.addCard(b, { title: 'done' });
  store.addCard(b, { title: 'in review' });
  store.moveCard(b, 1, 'done', null, { force: true });
  store.moveCard(b, 2, 'review', null, { force: true });
  const found = findLeftovers({ cwd: r, board: b, config: DEFAULTS });
  assert.deepEqual(found.worktrees.map((w) => [path.basename(w.path), w.card]), [['factory-1-security', 1]]);
  assert.deepEqual(found.branches.map((x) => x.branch), ['me/factory-1-security']);
});

test('the managed block describes the pipeline, the panel and the business rule', () => {
  const text = block({ ...DEFAULTS, verify: ['npm test'], merge: { ...DEFAULTS.merge, humanPaths: ['migrations/**'] } });
  assert.match(text, /spec \(an idea\) → ready → building → review/);
  assert.match(text, /factory-spec/);
  assert.match(text, /\| Review panel \| qa · security · code · ops/);
  assert.match(text, /labels auth, payments, pricing, schema, ops, money, needs-human · paths `migrations\/\*\*` · diff > 400 lines/);
});

test('CLI: an idea goes to spec as free text, plan and status know the new lanes', () => {
  const dir = tmp('factory-cli-');
  const env = { ...process.env, FACTORY_BOARD: path.join(dir, 'board.json') };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: dir, encoding: 'utf8', env });
  const json = (r) => JSON.parse(r.stdout);

  const idea = json(cli('add', 'que el login acepte email', '--body', 'ahora solo acepta usuario', '--column', 'spec'));
  assert.deepEqual([idea.column, idea.body], ['spec', 'ahora solo acepta usuario']);
  assert.equal(cli('add', 'sin spec', '--column', 'ready').status, 1, 'ready needs a card that passes lint');
  assert.match(json(cli('add', 'x', '--column', 'review')).error, /new cards start in backlog, spec, ready/);

  const plan = json(cli('plan'));
  assert.deepEqual(plan.map((a) => [a.id, a.lane, a.lens, a.worker]), [[1, 'spec', null, 'spec-1']]);
  assert.equal(json(cli('claim', '1', '--as', 'spec-1')).assignee, 'spec-1');
  const status = json(cli('status'));
  assert.deepEqual(status.inFlight.map((f) => [f.id, f.column, f.worker]), [[1, 'spec', 'spec-1']]);
  assert.deepEqual([status.approvals, status.panels, status.counts.spec], [[], [], 1]);
  assert.match(json(cli('spec', '1', '--lane', 'spec', '--as', 'spec-1')).spec, /factory-spec/);
  assert.match(json(cli('claim', '1', '--lens', 'qa', '--as', 'r')).error, /reviewers work on cards in review/);
});

test('web API: an idea is filed in spec as free text, and the board lists the review lenses', async () => {
  const { createServer } = await import('../src/server.mjs');
  const dir = tmp('factory-web-');
  const server = createServer({ boardFile: path.join(dir, 'board.json'), repoRoot: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ code: r.status, body: await r.json() }));
  try {
    const idea = await post('/api/cards', { title: 'idea', body: 'en mis palabras', column: 'spec' });
    assert.deepEqual([idea.code, idea.body.column, idea.body.body], [201, 'spec', 'en mis palabras']);
    assert.equal((await post('/api/cards', { title: 'sin spec', body: 'x', column: 'ready' })).code, 400);
    assert.equal((await post('/api/cards', { title: 'x', column: 'done' })).code, 400);
    const board = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(board.lenses, ['qa', 'security', 'code', 'ops']);
    assert.ok(board.columns.includes('spec'));
    assert.deepEqual(board.cards.map((c) => c.column), ['spec']);
  } finally {
    server.close();
  }
});

test('needs-human holds a merge even when the project lists other labels', () => {
  const policy = { ...DEFAULTS.merge, humanLabels: ['billing'] };
  assert.deepEqual(humanReasons({ body: GOOD_BODY, labels: ['feature', 'needs-human'] }, 1, policy), ['label needs-human']);
  assert.deepEqual(humanReasons({ body: GOOD_BODY, labels: ['feature', 'auth'] }, 1, policy), [], 'only what the project lists');
});

test('every step of the chain is told to load its ponytail skill, and the skills ship with the factory', async () => {
  const run = await import('../src/run.mjs');
  const { listSkills, FACTORY_ROOT, install } = await import('../src/install.mjs');
  const card = { id: 7, title: 'x' };
  const root = path.resolve('/repo');
  assert.match(run.spec(card, 'spec', 'spec-7', root), /load the `ponytail` skill too[\s\S]*skills[\\/]ponytail[\\/]SKILL\.md[\s\S]*scope of the card/);
  assert.match(run.spec(card, 'build', 'build-7', root), /load the `ponytail` skill too[\s\S]*smallest change that fully solves the card/);
  assert.match(run.spec(card, 'review', 'review-code-7', root, 'code'), /load the `ponytail-review` skill too[\s\S]*skills[\\/]ponytail-review[\\/]SKILL\.md/);
  assert.doesNotMatch(run.spec(card, 'qa', 'qa-7', root), /ponytail/, 'a qa card writes and reviews no code');

  // Vendored from DietrichGebert/ponytail (MIT): the licence travels with each copy.
  for (const name of ['ponytail', 'ponytail-review']) {
    assert.ok(listSkills().includes(name), name);
    assert.match(fs.readFileSync(path.join(FACTORY_ROOT, 'skills', name, 'LICENSE'), 'utf8'), /MIT License[\s\S]*DietrichGebert/);
    assert.match(fs.readFileSync(path.join(FACTORY_ROOT, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
  }
  // Each lane skill names the one it loads.
  const skill = (name) => fs.readFileSync(path.join(FACTORY_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  assert.match(skill('factory-spec'), /Load the `ponytail` skill/);
  assert.match(skill('factory-build'), /Load the `ponytail` skill before you write a line/);
  assert.match(skill('factory-review'), /Load the `ponytail-review` skill before you read the diff/);

  // A project that already has its own ponytail keeps it, and install copies the licence with ours.
  const dir = tmp('factory-pony-');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'ponytail'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'ponytail', 'SKILL.md'), 'mine');
  const report = install(dir);
  assert.equal(report.skills.find((s) => s.name === 'ponytail').status, 'skipped');
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'skills', 'ponytail', 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'ponytail-review', 'LICENSE')));
});
