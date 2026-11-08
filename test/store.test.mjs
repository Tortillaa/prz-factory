import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as store from '../src/store.mjs';

const tmpBoard = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-')), 'board.json');
const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');

test('add, move, comment and claim a card', () => {
  const file = tmpBoard();
  const card = store.update(file, (b) => store.addCard(b, { title: 'First', labels: ['feature'] }));
  assert.equal(card.id, 1);
  assert.equal(card.column, 'backlog');

  store.update(file, (b) => store.moveCard(b, 1, 'ready', 'user'));
  store.update(file, (b) => store.commentCard(b, 1, { role: 'build', text: 'done' }));
  store.update(file, (b) => store.claimCard(b, 1, 'worker-a'));

  const saved = store.getCard(store.load(file), 1);
  assert.equal(saved.column, 'ready');
  assert.deepEqual(saved.history.map((h) => h.to), ['backlog', 'ready']);
  assert.equal(saved.comments[0].role, 'build');
  assert.equal(saved.assignee, 'worker-a');
});

test('rejects unknown columns, missing cards and double claims', () => {
  const file = tmpBoard();
  store.update(file, (b) => store.addCard(b, { title: 'x' }));
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 1, 'nowhere')), /unknown column/);
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 99, 'ready')), /not found/);
  store.update(file, (b) => store.claimCard(b, 1, 'a'));
  assert.throws(() => store.update(file, (b) => store.claimCard(b, 1, 'b')), /already claimed/);
  // A failed mutation leaves the file as it was.
  assert.equal(store.load(file).cards[0].assignee, 'a');
});

test('concurrent CLI processes never lose a write', async () => {
  const file = tmpBoard();
  const N = 12;
  const run = (i) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [CLI, 'add', `card ${i}`, '--json'], { env: { ...process.env, FACTORY_BOARD: file } });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  await Promise.all(Array.from({ length: N }, (_, i) => run(i)));
  const board = store.load(file);
  assert.equal(board.cards.length, N);
  assert.deepEqual(new Set(board.cards.map((c) => c.id)).size, N);
});

test('server pushes a change event for each CLI write', async () => {
  const { createServer } = await import('../src/server.mjs');
  const file = tmpBoard();
  const server = createServer({ boardFile: file });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ctrl = new AbortController();
  const res = await fetch(`http://localhost:${port}/api/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let seen = '';
  const waitForEvents = async (n) => {
    while ((seen.match(/event: change/g) || []).length < n) {
      const { value } = await reader.read();
      seen += new TextDecoder().decode(value);
    }
  };
  const cli = (...args) =>
    new Promise((resolve) => spawn(process.execPath, [CLI, ...args], { env: { ...process.env, FACTORY_BOARD: file } }).on('exit', resolve));
  await cli('add', 'one');
  await waitForEvents(1);
  await cli('move', '1', 'ready');
  await waitForEvents(2);
  ctrl.abort();
  server.close();
  assert.equal(store.load(file).cards[0].column, 'ready');
});
