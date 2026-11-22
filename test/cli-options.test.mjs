// Mistyped options are usage errors: a clear message and exit 64, never a Node stack trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

const UNKNOWN = 'unknown column "nope" (use: backlog, spec, ready, building, qa, review, merge, blocked, done)';

test('list --column with an unknown column is an error on stderr, exit 1', () => {
  const r = run('list', '--column', 'nope');
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stderr.trimEnd(), `error: ${UNKNOWN}`);
  assert.equal(r.stdout, '');
});

test('list --column with an unknown column and --json prints {"error"} on stdout, exit 1', () => {
  const r = run('list', '--column', 'nope', '--json');
  assert.equal(r.code, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).error, UNKNOWN);
});

test('list still prints a known column, or every column, on an empty board', () => {
  const one = run('list', '--column', 'ready');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout.trimEnd(), 'READY (0)');
  const all = run('list');
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(all.stdout.trimEnd().split(/\r?\n/), [
    'BACKLOG (0)', 'SPEC (0)', 'READY (0)', 'BUILDING (0)', 'QA (0)', 'REVIEW (0)', 'MERGE (0)', 'BLOCKED (0)', 'DONE (0)',
  ]);
});

test('factory serve writes serve.json next to the board and removes it on SIGTERM', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
  const info = path.join(dir, 'serve.json');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    env: { ...process.env, FACTORY_BOARD: path.join(dir, 'board.json') },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  for (let i = 0; i < 100 && !fs.existsSync(info); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(info, 'utf8')), { port, pid: child.pid });
  const closed = new Promise((r) => child.on('close', r));
  child.kill('SIGTERM');
  await closed;
  // Windows kills the process without running handlers; there a stale file is told apart by its pid.
  if (process.platform !== 'win32') assert.ok(!fs.existsSync(info));
});

test('factory serve leaves serve.json alone when a newer serve rewrote it', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
  const info = path.join(dir, 'serve.json');
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(20000 + Math.floor(Math.random() * 20000))], {
    env: { ...process.env, FACTORY_BOARD: path.join(dir, 'board.json') },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  for (let i = 0; i < 100 && !fs.existsSync(info); i++) await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(info, JSON.stringify({ port: 5050, pid: child.pid + 1 }));
  const closed = new Promise((r) => child.on('close', r));
  child.kill('SIGTERM');
  await closed;
  assert.ok(fs.existsSync(info));
});

test('show writes the path of each screenshot, never [object Object]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
  const board = path.join(dir, 'board.json');
  const env = { ...process.env, FACTORY_BOARD: board };
  const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', timeout: 10_000 });
  sh('add', 'idea', '--column', 'backlog');
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  b.cards[0].run = { screens: ['a.html'], evidence: { head: 'abc1234', files: ['/e/1/abc1234-1.png', '/e/1/abc1234-2.png'] } };
  fs.writeFileSync(board, JSON.stringify(b));
  const out = sh('show', String(b.cards[0].id)).stdout;
  assert.ok(out.includes('/e/1/abc1234-1.png, /e/1/abc1234-2.png'), out);
  assert.ok(!out.includes('[object Object]'), out);
});
