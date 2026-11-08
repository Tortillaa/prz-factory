import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install, listSkills, MARKER } from '../src/install.mjs';
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
    for (const name of ['node', 'git', 'git repo', 'config', 'board', 'skills']) assert.equal(after[name].ok, true, name);
  } finally {
    if (env === undefined) delete process.env.FACTORY_BOARD;
    else process.env.FACTORY_BOARD = env;
  }
});
