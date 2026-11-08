// Mistyped options are usage errors: a clear message and exit 64, never a Node stack trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');

function run(...args) {
  const board = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-')), 'board.json');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, FACTORY_BOARD: board },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function assertNoStack({ stdout, stderr }) {
  const all = stdout + stderr;
  assert.ok(!all.includes('    at '), all);
  assert.ok(!all.includes('node:internal'), all);
}

test('an unknown option prints an error line and a help hint, and exits 64', () => {
  const r = run('list', '--foo');
  assert.equal(r.code, 64, r.stderr);
  const lines = r.stderr.split(/\r?\n/);
  const err = lines.find((l) => l.startsWith('error: '));
  assert.ok(err, `no "error: " line in stderr:\n${r.stderr}`);
  assert.ok(err.includes('--foo'), err);
  assert.ok(lines.some((l) => l.includes('factory --help')), r.stderr);
  assertNoStack(r);
});

for (const [args, option] of [
  [['add', 'x', '--label'], '--label'],
  [['serve', '--port', '-1'], '--port'],
]) {
  test(`factory ${args.join(' ')} is a usage error naming ${option}`, () => {
    const r = run(...args);
    assert.equal(r.code, 64, r.stderr);
    const err = r.stderr.split(/\r?\n/).find((l) => l.startsWith('error: '));
    assert.ok(err, `no "error: " line in stderr:\n${r.stderr}`);
    assert.ok(err.includes(option), err);
    assertNoStack(r);
  });
}

test('with --json a mistyped option prints {"error"} on stdout and exits 64', () => {
  for (const args of [['list', '--foo', '--json'], ['--json', 'add', 'x', '--label']]) {
    const r = run(...args);
    assert.equal(r.code, 64, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(typeof out.error, 'string');
    assert.ok(out.error.length > 0);
    assertNoStack(r);
  }
});
