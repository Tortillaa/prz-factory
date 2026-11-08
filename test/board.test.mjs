// Board rules from Fase 1: lint gate into Ready, dependencies, routing, ordering, run fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from '../src/store.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const tmpBoard = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-')), 'board.json');
const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');
const ids = (cards) => cards.map((c) => c.id);

function seed(file, cards) {
  return store.update(file, (b) => cards.map((c) => store.addCard(b, { body: GOOD_BODY, ...c })));
}

test('a card that fails lint cannot enter Ready unless forced', () => {
  const file = tmpBoard();
  store.update(file, (b) => store.addCard(b, { title: 'rough idea' }));
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 1, 'ready')), /fails lint/);
  assert.equal(store.load(file).cards[0].column, 'backlog');
  store.update(file, (b) => store.moveCard(b, 1, 'ready', 'user', { force: true }));
  assert.equal(store.load(file).cards[0].column, 'ready');
});

test('a blocked card waits in Ready until its blockers are done', () => {
  const file = tmpBoard();
  seed(file, [{ title: 'base' }, { title: 'depends', blockedBy: [1] }]);
  for (const id of [1, 2]) store.update(file, (b) => store.moveCard(b, id, 'ready'));

  assert.deepEqual(ids(store.readyQueue(store.load(file))), [1]);
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 2, 'building')), /blocked by #1/);
  // Moving it aside (blocked, backlog) is always allowed.
  store.update(file, (b) => store.moveCard(b, 2, 'blocked'));
  store.update(file, (b) => store.moveCard(b, 2, 'ready'));

  store.update(file, (b) => store.moveCard(b, 1, 'done', null, { force: true }));
  assert.deepEqual(ids(store.readyQueue(store.load(file))), [2]);
  store.update(file, (b) => store.moveCard(b, 2, 'building'));
});

test('the ready queue keeps board order, skips claimed cards and routes qa cards', () => {
  const file = tmpBoard();
  seed(file, [{ title: 'a' }, { title: 'b', labels: ['QA'] }, { title: 'c' }]);
  for (const id of [1, 2, 3]) store.update(file, (b) => store.moveCard(b, id, 'ready'));
  store.update(file, (b) => store.moveCard(b, 3, 'ready', 'user', { before: 1 }));
  store.update(file, (b) => store.claimCard(b, 1, 'w'));

  const queue = store.readyQueue(store.load(file));
  assert.deepEqual(ids(queue), [3, 2]);
  assert.deepEqual(queue.map((c) => c.next), ['building', 'qa']);
});

test('reordering inside and across columns', () => {
  const file = tmpBoard();
  seed(file, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
  const order = () => ids(store.load(file).cards.filter((c) => c.column === 'backlog'));

  store.update(file, (b) => store.moveCard(b, 3, 'backlog', null, { before: 1 }));
  assert.deepEqual(order(), [3, 1, 2]);
  store.update(file, (b) => store.moveCard(b, 3, 'backlog'));
  assert.deepEqual(order(), [1, 2, 3]);
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 1, 'ready', null, { before: 2 })), /not in ready/);
  assert.throws(() => store.update(file, (b) => store.moveCard(b, 1, 'backlog', null, { before: 1 })), /before itself/);
  // Reordering within a column adds no history entry.
  assert.equal(store.getCard(store.load(file), 3).history.length, 1);
});

test('edit updates fields and run data; old boards load with defaults', () => {
  const file = tmpBoard();
  seed(file, [{ title: 'a' }]);
  store.update(file, (b) =>
    store.editCard(b, 1, { title: ' renamed ', labels: ['Bug', 'bug', ' '], run: { branch: 'factory/1-a', worker: 'w1' } }),
  );
  let card = store.getCard(store.load(file), 1);
  assert.equal(card.title, 'renamed');
  assert.deepEqual(card.labels, ['bug']);
  assert.deepEqual(card.run, { branch: 'factory/1-a', worker: 'w1' });
  store.update(file, (b) => store.editCard(b, 1, { run: { worker: null } }));
  assert.deepEqual(store.getCard(store.load(file), 1).run, { branch: 'factory/1-a' });
  assert.throws(() => store.update(file, (b) => store.editCard(b, 1, { run: { pid: 1 } })), /unknown run field/);

  const legacy = tmpBoard();
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, nextId: 2, cards: [{ id: 1, title: 'x', column: 'backlog', labels: [] }] }));
  card = store.load(legacy).cards[0];
  assert.deepEqual([card.blockedBy, card.run], [[], {}]);
});

test('CLI: add from a body file, lint exit code, next', () => {
  const file = tmpBoard();
  const bodyFile = path.join(path.dirname(file), 'body.md');
  fs.writeFileSync(bodyFile, GOOD_BODY);
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CLI, ...args, '--json'], { env: { ...process.env, FACTORY_BOARD: file }, encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status, out: err.stdout };
    }
  };
  cli('add', 'good', '--body-file', bodyFile, '--label', 'feature');
  cli('add', 'rough');
  const lint = cli('lint');
  assert.equal(lint.code, 1);
  assert.deepEqual(JSON.parse(lint.out).map((r) => r.ok), [true, false]);
  assert.equal(cli('lint', '1').code, 0);

  assert.equal(cli('move', '2', 'ready').code, 1);
  assert.equal(cli('move', '1', 'ready').code, 0);
  assert.deepEqual(JSON.parse(cli('next').out).map((c) => [c.id, c.next]), [[1, 'building']]);
});
