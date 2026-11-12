import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkPush } from '../hooks/factory-pre-push.mjs';
import { guardProtectedPush } from '../hooks/factory-guard.mjs';
import { install } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ctx = (ancestor) => ({ protectedBranches: ['main'], isAncestor: () => ancestor });
const line = (ref, local, remote) => `${ref} ${local} ${ref} ${remote}`;

test('checkPush: protected branches only fast-forward, are never deleted, new ones are fine', () => {
  assert.equal(checkPush([line('refs/heads/main', A, B)], ctx(false)).length, 1, 'rewrite denied');
  assert.equal(checkPush([line('refs/heads/main', A, B)], ctx(true)).length, 0, 'fast-forward allowed');
  assert.equal(checkPush([line('refs/heads/feature', A, B)], ctx(false)).length, 0, 'unprotected rewrite allowed');
  assert.equal(checkPush([`(delete) ${Z} refs/heads/main ${B}`], ctx(true)).length, 1, 'delete denied');
  assert.equal(checkPush([line('refs/heads/main', A, Z)], ctx(false)).length, 0, 'new branch allowed');
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function repoWithRemote() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-prepush-')));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t']]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify({ baseBranch: 'main', protectedBranches: ['main'] }));
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main'); // before install: nothing in the way
  return { root, remote, repo };
}

test('pre-push hook in a real repo: rewrites of main fail however typed, fast-forwards succeed, worktrees too', () => {
  const { root, remote, repo } = repoWithRemote();
  assert.equal(install(repo).prePush.status, 'installed');
  const before = git(remote, 'rev-parse', 'main');

  // Rewrite history locally.
  git(repo, 'commit', '-q', '--amend', '-m', 'rewritten');
  const wt = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  for (const dir of [repo, wt]) {
    for (const args of [['push', '--force', 'origin', 'HEAD:main'], ['-c', 'alias.p=push', 'p', '-f', 'origin', 'HEAD:main']]) {
      const r = tryGit(dir, ...args);
      assert.notEqual(r.status, 0, `${args.join(' ')} in ${dir}`);
      assert.match(r.stderr, /pre-push/);
      assert.equal(git(remote, 'rev-parse', 'main'), before);
    }
  }

  // A fast-forward on top of the remote is fine (from the main checkout and from the worktree).
  git(repo, 'reset', '-q', '--hard', before);
  fs.writeFileSync(path.join(repo, 'a.txt'), '2');
  git(repo, 'commit', '-qam', 'two');
  assert.equal(tryGit(repo, 'push', 'origin', 'HEAD:main').status, 0);
  const sha = git(repo, 'rev-parse', 'HEAD');
  assert.equal(git(remote, 'rev-parse', 'main'), sha);
  git(wt, 'reset', '-q', '--hard', sha);
  fs.writeFileSync(path.join(wt, 'a.txt'), '3');
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'three');
  assert.equal(tryGit(wt, 'push', 'origin', 'HEAD:main').status, 0, 'fast-forward from a worktree');
});

test('pre-push hook still blocks a force-push in a "type":"commonjs" repo, and doctor needs the script', () => {
  const { remote, repo } = repoWithRemote();
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"commonjs"}');
  install(repo);
  const before = git(remote, 'rev-parse', 'main');
  git(repo, 'commit', '-q', '--amend', '-m', 'rewritten');
  assert.notEqual(tryGit(repo, 'push', '--force', 'origin', 'HEAD:main').status, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), before);

  fs.rmSync(path.join(repo, '.git', 'hooks', 'factory-pre-push.mjs'));
  assert.equal(doctor(repo).checks.find((c) => c.name === 'pre-push hook').ok, false, 'script missing');
});

test('install keeps a foreign pre-push byte for byte, updates its own, and doctor follows', () => {
  const { repo } = repoWithRemote();
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  const check = () => doctor(repo).checks.find((c) => c.name === 'pre-push hook');
  assert.equal(check().ok, false, 'before install');

  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  const r = install(repo);
  assert.equal(r.prePush.status, 'skipped');
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(check().ok, false, 'foreign hook');

  fs.rmSync(hook);
  assert.equal(install(repo).prePush.status, 'installed');
  assert.equal(install(repo).prePush.status, 'updated');
  assert.equal(check().ok, true, 'after install');
});

test('install is silent outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-nogit-'));
  assert.equal(install(dir).prePush, null);
});

test('guardProtectedPush refuses ways of skipping the pre-push hook', () => {
  const run = (command) => guardProtectedPush({ tool_name: 'Bash', tool_input: { command } }, { cwd: os.tmpdir(), protectedBranches: ['main'], linkedWorktree: false, currentBranch: 'x' });
  for (const c of ['git push --no-verify origin x', 'git push --no-ver origin x', 'git -c core.hooksPath=/dev/null push origin x', 'git -c CORE.HOOKSPATH=x push', 'git --config-env=core.hooksPath=V push']) {
    assert.match(run(c), /pre-push hook cannot be skipped/, c);
  }
  for (const c of ['git push origin feature/x', 'git -c user.name=a commit -m x']) assert.equal(run(c), null, c);
});
