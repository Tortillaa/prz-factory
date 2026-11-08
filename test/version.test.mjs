import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function factory(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('factory --version prints the package.json version and exits 0', () => {
  const r = factory('--version');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${version}\n`);
});

test('factory version --json prints {"version": ...} and exits 0', () => {
  const r = factory('version', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { version });
});
