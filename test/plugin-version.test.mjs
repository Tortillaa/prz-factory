// A change under orca-plugin/ must bump the manifest version, so `orca plugin list` tells builds apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, tryGit } from '../src/git.mjs';
import { loadConfig } from '../src/config.mjs';

const MANIFEST = 'orca-plugin/orca-plugin.json';
const root = path.join(import.meta.dirname, '..');

// Returns a problem message, or null when fine or when there is nothing to compare against.
export function versionProblem(cwd, base) {
  const mb = tryGit(['merge-base', 'HEAD', base], cwd);
  if (!mb || mb === tryGit(['rev-parse', 'HEAD'], cwd)) return null;
  if (!git(['diff', '-z', '--name-only', '--no-renames', mb, 'HEAD'], cwd).split('\0').some((f) => f.startsWith('orca-plugin/'))) return null;
  const at = (ref) => JSON.parse(git(['show', `${ref}:${MANIFEST}`], cwd)).version;
  const now = at('HEAD');
  return at(mb) === now ? `${MANIFEST}: version is still ${now}; bump it, the plugin changed` : null;
}

const repo = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  fs.mkdirSync(path.join(dir, 'orca-plugin'));
  fs.writeFileSync(path.join(dir, MANIFEST), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'a');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  git(['checkout', '-qb', 'work'], dir);
  return dir;
};
const commit = (dir, file, text) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(['commit', '-qam', 'change'], dir);
};

test('plugin change with the same version fails and names the manifest and version', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'orca-plugin', 'x.ts'), 'x');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'x'], dir);
  assert.match(versionProblem(dir, 'main'), /orca-plugin\/orca-plugin\.json.*1\.0\.0/);
});

test('plugin change with a new version passes', () => {
  const dir = repo();
  commit(dir, MANIFEST, '{"version":"1.1.0"}');
  assert.equal(versionProblem(dir, 'main'), null);
});

test('no plugin change, HEAD at the merge-base, missing base or no repo: nothing to compare', () => {
  const dir = repo();
  commit(dir, 'other.txt', 'b');
  assert.equal(versionProblem(dir, 'main'), null);
  git(['checkout', '-q', 'main'], dir);
  assert.equal(versionProblem(dir, 'main'), null);
  assert.equal(versionProblem(dir, 'nope'), null);
  assert.equal(versionProblem(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')), 'main'), null);
});

test('this repo: the plugin version is 0.3.0 and bumped when the plugin changed', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).version, '0.3.0');
  assert.equal(versionProblem(root, loadConfig(root).config.baseBranch), null);
});

test('a non-ASCII path under orca-plugin/ counts as a plugin change', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'orca-plugin', 'cañón.ts'), 'x');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'x'], dir);
  assert.match(versionProblem(dir, 'main'), /1\.0\.0/);
});

test('a rename out of orca-plugin/ counts as a plugin change', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'orca-plugin', 'a.ts'), 'a'.repeat(200));
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'a'], dir);
  git(['checkout', '-q', 'main'], dir);
  git(['merge', '-q', '--ff-only', 'work'], dir);
  git(['checkout', '-qb', 'move'], dir);
  git(['mv', 'orca-plugin/a.ts', 'moved.ts'], dir);
  git(['commit', '-qm', 'mv'], dir);
  assert.match(versionProblem(dir, 'main'), /1\.0\.0/);
});
