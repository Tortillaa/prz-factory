// `factory serve`: a busy port gets a clear message, a free port still serves the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');
const tmpBoard = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-')), 'board.json');

function occupy() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function serve(port, { until } = {}) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    env: { ...process.env, FACTORY_BOARD: tmpBoard() },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; if (until?.(stdout)) child.emit('ready'); });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, exited };
}

test('serve on a busy port explains it and exits 1 without a stack trace', async () => {
  const busy = await occupy();
  const { port } = busy.address();
  try {
    const { child, exited } = serve(port);
    const timer = setTimeout(() => child.kill(), 10_000);
    const { code, stdout, stderr } = await exited;
    clearTimeout(timer);
    assert.equal(code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
    const line = stderr.split('\n').find((l) => l.includes('already in use'));
    assert.ok(line, `no "already in use" line in stderr:\n${stderr}`);
    for (const part of [String(port), `http://localhost:${port}`, '--port']) {
      assert.ok(line.includes(part), `missing ${part} in: ${line}`);
    }
    const all = stdout + stderr;
    assert.ok(!all.includes("Unhandled 'error' event"), all);
    assert.ok(!all.includes('    at '), all);
  } finally {
    busy.close();
  }
});

test('serve on a free port still prints the URL and answers GET /api/board', async () => {
  const probe = await occupy();
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const url = `http://localhost:${port}`;
  const { child, exited } = serve(port, { until: (out) => out.includes(`board: ${url}`) });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve did not print the board URL')), 10_000);
      child.once('ready', () => { clearTimeout(timer); resolve(); });
      exited.then(({ stderr }) => reject(new Error(`serve exited early: ${stderr}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/board`, { headers: { host: `localhost:${port}` } });
    assert.equal(res.status, 200);
  } finally {
    child.kill();
    await exited;
  }
});

function serveRaw(args, env = {}) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], {
    env: { ...process.env, FACTORY_BOARD: tmpBoard(), ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const started = Date.now();
  const timer = setTimeout(() => child.kill(), 5_000);
  return new Promise((resolve) => child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
  }));
}

function assertInvalidPort({ code, signal, stdout, stderr, ms }, value) {
  assert.equal(signal, null, `serve did not exit on its own (killed after ${ms} ms)\nstderr: ${stderr}`);
  assert.equal(code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
  assert.ok(ms < 5_000, `took ${ms} ms`);
  const line = stderr.split('\n').find((l) => l.includes(`invalid port "${value}"`));
  assert.ok(line, `no invalid port "${value}" line in stderr:\n${stderr}`);
  for (const part of ['1', '65535', '--port', 'FACTORY_PORT']) {
    assert.ok(line.includes(part), `missing ${part} in: ${line}`);
  }
  const all = stdout + stderr;
  assert.ok(!all.includes('    at '), all);
  assert.ok(!all.includes('options.port should be'), all);
  assert.ok(!all.includes('board: '), all);
}

for (const value of ['abc', '0', '70000', '8080.5']) {
  test(`serve --port ${value} is rejected and exits 1 on its own`, async () => {
    assertInvalidPort(await serveRaw(['--port', value]), value);
  });
}

test('serve with FACTORY_PORT=abc and no --port is rejected and exits 1 on its own', async () => {
  assertInvalidPort(await serveRaw([], { FACTORY_PORT: 'abc' }), 'abc');
});
