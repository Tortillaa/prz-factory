import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { install, listSkills, MARKER, FACTORY_ROOT } from '../src/install.mjs';
import { loadConfig, DEFAULTS } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';

function tmpRepo(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-target-'));
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir });
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

test('install copies every skill with a marker and creates a detected config', () => {
  const dir = tmpRepo({ scripts: { test: 'x', build: 'y' } });
  const report = install(dir);
  for (const name of listSkills()) {
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', name, MARKER)));
  }
  assert.equal(report.config.status, 'created');
  const { config } = loadConfig(dir);
  assert.equal(config.baseBranch, 'trunk');
  assert.deepEqual(config.protectedBranches, ['trunk']);
  assert.deepEqual(config.verify, ['npm test', 'npm run build']);
});

test('install updates managed skills, keeps foreign ones and an existing config', () => {
  const dir = tmpRepo();
  install(dir);
  const [first] = listSkills();
  const managedStale = path.join(dir, '.claude', 'skills', first, 'stale.md');
  fs.writeFileSync(managedStale, 'old');
  fs.writeFileSync(path.join(dir, 'factory.config.json'), JSON.stringify({ verify: ['make check'] }));

  const report = install(dir);
  assert.equal(fs.existsSync(managedStale), false, 'files dropped from the factory are removed');
  assert.equal(report.skills.find((s) => s.name === first).status, 'updated');
  assert.equal(report.config.status, 'kept');
  assert.deepEqual(loadConfig(dir).config.verify, ['make check']);

  // A user's own folder with the same name is never overwritten.
  const own = path.join(dir, '.claude', 'skills', first);
  fs.rmSync(own, { recursive: true });
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'mine');
  assert.equal(install(dir).skills.find((s) => s.name === first).status, 'skipped');
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'mine');
});

test('loadConfig fills defaults and rejects bad values', () => {
  const dir = tmpRepo();
  assert.deepEqual(loadConfig(dir), { file: path.join(dir, 'factory.config.json'), exists: false, config: { ...DEFAULTS } });
  fs.writeFileSync(path.join(dir, 'factory.config.json'), JSON.stringify({ verify: 'npm test' }));
  assert.throws(() => loadConfig(dir), /"verify" must be an array/);
  fs.writeFileSync(path.join(dir, 'factory.config.json'), '{oops');
  assert.throws(() => loadConfig(dir), /invalid JSON/);
});

test('doctor flags a project that is not set up, then passes the setup checks after install', () => {
  const dir = tmpRepo({ scripts: { test: 'x' } });
  const env = process.env.FACTORY_BOARD;
  process.env.FACTORY_BOARD = path.join(dir, 'board.json');
  try {
    const before = Object.fromEntries(doctor(dir).checks.map((c) => [c.name, c]));
    assert.equal(before.config.ok, false);
    assert.equal(before.skills.ok, false);
    assert.ok(before.skills.fix);

    install(dir);
    const after = Object.fromEntries(doctor(dir).checks.map((c) => [c.name, c]));
    for (const name of ['node', 'git', 'git repo', 'config', 'board', 'skills', 'guard hooks']) assert.equal(after[name].ok, true, name);
  } finally {
    if (env === undefined) delete process.env.FACTORY_BOARD;
    else process.env.FACTORY_BOARD = env;
  }
});

// Agents pick a skill by its description, with no slash command: every factory skill must be
// model-invocable and say, in the task's own words, when it applies.
test('every skill is picked by the task: model-invocable, with a task-driven description', () => {
  for (const name of listSkills()) {
    const text = fs.readFileSync(path.join(FACTORY_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fm, `${name}: no frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'), `${name}: name must match the folder`);
    assert.doesNotMatch(fm[1], /disable-model-invocation:\s*true/, `${name}: must not be manual-only`);
    const desc = fm[1].split(/\r?\n/).slice(fm[1].split(/\r?\n/).findIndex((l) => l.startsWith('description:')) + 1).filter((l) => /^\s/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    assert.ok(desc.length > 80 && desc.length <= 1024, `${name}: description is ${desc.length} chars (Claude Code reads up to 1024)`);
    if (name.startsWith('factory-')) {
      assert.match(desc, /Use (whenever|when)/, `${name}: say when it applies`);
      assert.match(desc, /Triggers:.*"[^"]*[áéíóúñ¿]|Triggers:.*"(revisa|arranca|busca|instala|construye|redacta|prueba|mergea)/i, `${name}: give Spanish trigger phrases`);
    }
  }
});

// The project needs nothing installed: install copies the factory's runtime into it, and that
// copy runs the CLI, re-installs itself, and is found by every worktree of the repo.
test('install vendors the runtime: the project runs the factory with nothing installed', async () => {
  const { RUNTIME_DIR } = await import('../src/install.mjs');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-vendor-')));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e 0' } }));

  const report = install(repo);
  assert.equal(report.runtime.status, 'installed');
  const cli = path.join(repo, RUNTIME_DIR, 'bin', 'factory.mjs');
  for (const part of ['bin/factory.mjs', 'src/store.mjs', 'public/index.html', 'hooks/factory-guard.mjs', 'skills/factory-spec/SKILL.md', 'package.json', MARKER]) {
    assert.ok(fs.existsSync(path.join(repo, RUNTIME_DIR, part)), part);
  }
  assert.ok(!fs.existsSync(path.join(repo, RUNTIME_DIR, 'test')), 'tests and evals stay out of the project');

  const run = (cwd, ...args) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, FACTORY_BOARD: '' } });
  assert.match(run(repo, '--version'), /\d+\.\d+\.\d+/);
  // The vendored copy re-installs from itself without deleting itself.
  const again = JSON.parse(run(repo, 'install', '.', '--json'));
  assert.equal(again.runtime.status, 'skipped');
  assert.ok(fs.existsSync(cli));
  // The board and the CLI work from a worker worktree once the copy is committed.
  git('add', '-A');
  git('commit', '-qm', 'install prz-factory');
  const wt = path.join(dir, 'wt');
  git('worktree', 'add', '-q', '--detach', wt, 'main');
  const wtCli = path.join(wt, RUNTIME_DIR, 'bin', 'factory.mjs');
  execFileSync(process.execPath, [wtCli, 'add', 'idea', '--column', 'spec'], { cwd: wt, env: { ...process.env, FACTORY_BOARD: '' } });
  assert.match(run(repo, 'list', '--column', 'spec'), /#1 idea/, 'one board shared by the repo and its worktrees');
  const doc = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, FACTORY_BOARD: '' } });
  const checks = JSON.parse(doc.stdout).checks;
  assert.equal(checks.find((c) => c.name === 'factory CLI').ok, true);
  assert.equal(checks.find((c) => c.name === 'skills').ok, true);
  // The session hook runs the vendored CLI, not one on PATH.
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /\.prz-factory\/bin\/factory\.mjs" cleanup --hint/);
});

test('install never vendors into the factory itself, nor over a folder it does not manage', () => {
  assert.equal(install(FACTORY_ROOT).runtime.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(FACTORY_ROOT, '.prz-factory')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-own-'));
  fs.mkdirSync(path.join(dir, '.prz-factory'));
  fs.writeFileSync(path.join(dir, '.prz-factory', 'mine.txt'), 'x');
  assert.equal(install(dir).runtime.status, 'skipped');
  assert.ok(fs.existsSync(path.join(dir, '.prz-factory', 'mine.txt')));
});
