import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from '../src/store.mjs';
import { findLeftovers, applyCleanup } from '../src/cleanup.mjs';
import { install, mergeSettings, listSkills, FACTORY_ROOT } from '../src/install.mjs';
import { DEFAULTS } from '../src/config.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clean-')));
  const r = path.join(dir, 'repo');
  fs.mkdirSync(r);
  sh(r, 'init', '-q', '-b', 'main');
  sh(r, 'config', 'user.email', 't@e.com');
  sh(r, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a');
  sh(r, 'add', '.');
  sh(r, 'commit', '-qm', 'init');
  return { dir, r };
}

function boardWith(columns) {
  const b = { version: 1, nextId: 1, cards: [] };
  for (const column of columns) {
    const c = store.addCard(b, { title: 'x' });
    store.moveCard(b, c.id, column, null, { force: true });
  }
  return b;
}

test('cleanup removes only merged, pristine leftovers of finished cards', () => {
  const { dir, r } = repo();
  // git worktree add [options] <path> [<commit-ish>]
  const wt = (name, options = [], ref = []) => {
    const p = path.join(dir, name);
    sh(r, 'worktree', 'add', '-q', ...options, p, ...ref);
    return p;
  };
  // #1 done and merged: its worktree (Orca named it factory-1, on Orca's branch) and both branches go.
  const done = wt('factory-1', ['-b', 'me/factory-1']);
  sh(done, 'switch', '-q', '-c', 'factory/1-x');
  fs.writeFileSync(path.join(done, 'b.txt'), 'b');
  sh(done, 'add', '.');
  sh(done, 'commit', '-qm', 'b');
  sh(r, 'merge', '-q', '--ff-only', 'factory/1-x');
  sh(done, 'switch', '-q', '--detach');
  // #2 still building: untouched. #3 done but with an untracked file: kept. #4 done, unmerged branch: kept.
  wt('factory-2', ['-b', 'me/factory-2']);
  const dirty = wt('factory-3', ['--detach']);
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'wip');
  sh(r, 'branch', 'factory/4-y');
  const unmerged = wt('factory-4', [], ['factory/4-y']);
  fs.writeFileSync(path.join(unmerged, 'c.txt'), 'c');
  sh(unmerged, 'add', '.');
  sh(unmerged, 'commit', '-qm', 'c');
  sh(unmerged, 'switch', '-q', '--detach');
  // Not the factory's: never touched.
  wt('my-experiment', ['--detach']);
  sh(r, 'branch', 'feature/mine');
  fs.mkdirSync(path.join(r, '.git', 'factory', 'verify-abc'), { recursive: true });

  const board = boardWith(['done', 'building', 'done', 'done']);
  const found = findLeftovers({ cwd: r, board, config: DEFAULTS });
  assert.deepEqual(found.worktrees.map((w) => path.basename(w.path)), ['factory-1']);
  assert.deepEqual(found.branches.map((b) => b.branch).sort(), ['factory/1-x', 'me/factory-1']);
  assert.equal(found.temp.length, 1);

  const result = applyCleanup(found, { cwd: r, useOrca: false });
  assert.deepEqual(result.errors, []);
  assert.ok(!fs.existsSync(done));
  for (const keep of ['factory-2', 'factory-3', 'factory-4', 'my-experiment']) assert.ok(fs.existsSync(path.join(dir, keep)), keep);
  const branches = sh(r, 'branch', '--format=%(refname:short)').split('\n').sort();
  assert.deepEqual(branches, ['factory/4-y', 'feature/mine', 'main', 'me/factory-2']);
  assert.deepEqual(findLeftovers({ cwd: r, board, config: DEFAULTS }).worktrees, []);
});

test('install wires the guard hooks and keeps the user own hooks', () => {
  const user = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-lint.sh' }, { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/factory-guard.mjs" secrets' }] }] }, model: 'x' };
  const once = mergeSettings(user);
  const twice = mergeSettings(once);
  assert.deepEqual(twice, once, 'idempotent');
  assert.equal(once.model, 'x');
  const commands = once.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes('my-lint.sh'));
  assert.equal(commands.filter((c) => c.endsWith('secrets')).length, 1, 'no duplicate guard');
  // The vendored CLI first, then one on PATH: either way the hint runs.
  assert.ok(once.hooks.SessionStart.some((g) => g.hooks.some((h) => /\.prz-factory\/bin\/factory\.mjs" cleanup --hint .*\|\| factory cleanup --hint/.test(h.command))));

  const { r } = repo();
  install(r);
  assert.ok(fs.existsSync(path.join(r, '.claude', 'hooks', 'factory-guard.mjs')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length >= 3);
  fs.writeFileSync(path.join(r, '.claude', 'settings.json'), '{broken');
  assert.throws(() => install(r), /not valid JSON/);
  assert.doesNotThrow(() => install(r, { hooks: false }));
});

test('the copies installed in this repo match their sources', () => {
  for (const name of listSkills()) {
    const src = path.join(FACTORY_ROOT, 'skills', name, 'SKILL.md');
    const copy = path.join(FACTORY_ROOT, '.claude', 'skills', name, 'SKILL.md');
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(src, 'utf8'), `${name}: run \`factory install .\``);
  }
  const guard = (p) => fs.readFileSync(path.join(FACTORY_ROOT, p), 'utf8');
  assert.equal(guard('.claude/hooks/factory-guard.mjs'), guard('hooks/factory-guard.mjs'), 'run `factory install .`');
});
