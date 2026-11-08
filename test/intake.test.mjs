// Fase 5: collected cards (dedupe, recurrence), the managed agents block, verify detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.mjs';
import { lintCard } from '../src/ticket.mjs';
import { writeBlock, BEGIN, END } from '../src/agentsmd.mjs';
import { DEFAULTS, detectVerify } from '../src/config.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'factory-intake-'));
const source = { kind: 'verify', key: 'verify:npm-test:cart#empty' };

test('collect files once, comments on twins, and reopens as a recurrence', () => {
  const b = { version: 1, nextId: 1, cards: [] };
  const first = store.collectCard(b, { title: 'Cart crashes', body: GOOD_BODY, labels: ['bug'], source, evidence: 'npm test: 1 failing' });
  assert.equal(first.status, 'created');
  assert.deepEqual(first.card.source, { ...source, seen: 1 });

  const twin = store.collectCard(b, { title: 'Cart crashes again', body: GOOD_BODY, source, evidence: 'still failing' });
  assert.equal(twin.status, 'duplicate');
  assert.equal(twin.card.id, first.card.id);
  assert.equal(b.cards.length, 1);
  assert.equal(b.cards[0].source.seen, 2);
  assert.match(b.cards[0].comments.at(-1).text, /visto otra vez \(2\)/);

  store.moveCard(b, 1, 'done', null, { force: true });
  const back = store.collectCard(b, { title: 'Cart crashes', body: GOOD_BODY, labels: ['bug'], source });
  assert.equal(back.status, 'recurrence');
  assert.equal(back.previous, 1);
  assert.deepEqual(back.card.labels, ['bug', 'recurrence']);
  assert.throws(() => store.collectCard(b, { title: 'x', source: { kind: 'verify' } }), /--source/);
});

test('lint ignores what the Evidence section quotes', () => {
  const body = `${GOOD_BODY}\n## Evidence\n\`\`\`\nat <anonymous>\n\`\`\`\nTODO: handle empty cart ... at Object.<anonymous> (cart.js:3)\n`;
  assert.deepEqual(lintCard({ id: 1, title: 't', blockedBy: [], body }).filter((i) => i.severity === 'error'), []);
  // The card's own sections are still checked.
  const vague = body.replace('Add an email', 'Add an email, etc.');
  assert.ok(lintCard({ id: 1, title: 't', blockedBy: [], body: vague }).some((i) => i.rule === 'scope'));
});

test('the agents block is written once, refreshed in place, and never touches the rest', () => {
  const root = tmp();
  const file = path.join(root, 'CLAUDE.md');
  assert.equal(writeBlock(root, DEFAULTS).status, 'created');
  assert.match(fs.readFileSync(file, 'utf8'), /not set: add `verify`/);

  fs.writeFileSync(file, `# My project\n\nOwn notes.\n\n${fs.readFileSync(file, 'utf8')}\nTrailing notes.\n`);
  const config = { ...DEFAULTS, verify: ['npm test'] };
  assert.equal(writeBlock(root, config).status, 'updated');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# My project\n\nOwn notes.'));
  assert.ok(text.trimEnd().endsWith('Trailing notes.'));
  assert.equal(text.split(BEGIN).length, 2, 'one block');
  assert.match(text, /`npm test`/);
  assert.equal(writeBlock(root, config).status, 'unchanged');

  const agents = tmp();
  fs.writeFileSync(path.join(agents, 'AGENTS.md'), '# Agents\n');
  assert.equal(path.basename(writeBlock(agents, config).file), 'AGENTS.md');
  fs.writeFileSync(path.join(agents, 'AGENTS.md'), `x\n${BEGIN}\nhalf`);
  assert.throws(() => writeBlock(agents, config), /without an end marker/);
  assert.ok(END);
});

test('verify detection covers the common ecosystems', () => {
  const with_ = (files) => {
    const root = tmp();
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    return detectVerify(root);
  };
  assert.deepEqual(with_({ 'package.json': JSON.stringify({ scripts: { test: 'x', lint: 'y' } }) }), ['npm run lint', 'npm test']);
  assert.deepEqual(with_({ 'package.json': JSON.stringify({ scripts: { test: 'x', build: 'y' } }), 'pnpm-lock.yaml': '' }), ['pnpm test', 'pnpm run build']);
  assert.deepEqual(with_({ 'Cargo.toml': '' }), ['cargo build', 'cargo test']);
  assert.deepEqual(with_({ 'go.mod': '' }), ['go vet ./...', 'go test ./...']);
  assert.deepEqual(with_({ 'pyproject.toml': '', 'tests/test_a.py': '' }), ['python -m pytest']);
  assert.deepEqual(with_({ Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }), ['make test']);
  assert.deepEqual(with_({}), []);
});
