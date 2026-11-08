import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE, lintCard, parseSections, acceptanceCriteria, hasErrors } from '../src/ticket.mjs';
import * as store from '../src/store.mjs';
import { GOOD_BODY } from './fixtures.mjs';

const rules = (card, board) => lintCard({ id: 1, title: 't', blockedBy: [], ...card }, board).map((i) => `${i.severity}:${i.rule}`);

test('a complete card passes lint and the template does not', () => {
  assert.deepEqual(rules({ body: GOOD_BODY }), []);
  assert.ok(rules({ body: TEMPLATE }).includes('error:placeholder'));
});

test('parses sections and acceptance criteria', () => {
  const s = parseSections(GOOD_BODY);
  assert.deepEqual(Object.keys(s), ['Problem', 'Context', 'Fix', 'Acceptance Criteria', 'Risk']);
  assert.equal(acceptanceCriteria(GOOD_BODY).length, 2);
  assert.match(acceptanceCriteria(GOOD_BODY)[0], /^Submitting/);
});

test('flags each kind of problem', () => {
  const without = (h) => GOOD_BODY.replace(new RegExp(`## ${h}[\\s\\S]*?(?=\\n## |$)`), '');
  assert.ok(rules({ body: without('Fix') }).includes('error:section'));
  assert.ok(rules({ body: without('Context') }).includes('warn:section'));
  assert.ok(rules({ body: GOOD_BODY, title: ' ' }).includes('error:title'));

  const prose = GOOD_BODY.replace(/- \[ \] Submitting.*\n/, 'It should work.\n');
  assert.ok(rules({ body: prose }).includes('error:ac-checklist'));

  const vague = GOOD_BODY.replace('redirects to /home', 'loads quickly y mejor');
  const issue = lintCard({ id: 1, title: 't', blockedBy: [], body: vague }).find((i) => i.rule === 'ac-vague');
  assert.equal(issue.severity, 'warn');
  assert.match(issue.message, /quickly, mejor/);

  assert.ok(rules({ body: GOOD_BODY.replace('every visitor', 'admins, editors, etc.') }).includes('error:scope'));
  assert.ok(rules({ body: GOOD_BODY.replace('🟢 **Low**', 'Bastante') }).includes('error:risk'));
  assert.deepEqual(rules({ body: GOOD_BODY.replace('🟢 **Low**', 'Medio') }), []);

  const many = GOOD_BODY.replace('## Risk', Array.from({ length: 6 }, (_, i) => `- [ ] Case ${i} returns 200`).join('\n') + '\n\n## Risk');
  assert.ok(rules({ body: many }).includes('warn:ac-size'));
});

test('words inside code and HTML tags are not flagged', () => {
  const body = GOOD_BODY.replace('redirects to /home', 'renders a <button> labelled `fast mode` (see `etc/hosts`)');
  assert.deepEqual(rules({ body }), []);
});

test('blockedBy must point at existing cards without cycles', () => {
  const file = `${process.env.TEMP || '/tmp'}/factory-deps-${process.pid}-${Date.now()}.json`;
  store.update(file, (b) => {
    store.addCard(b, { title: 'a', body: GOOD_BODY });
    store.addCard(b, { title: 'b', body: GOOD_BODY, blockedBy: [1] });
  });
  assert.throws(() => store.update(file, (b) => store.addCard(b, { title: 'c', blockedBy: [9] })), /#9 no existe/);
  assert.throws(() => store.update(file, (b) => store.editCard(b, 1, { blockedBy: [2] })), /ciclo/);
  assert.throws(() => store.update(file, (b) => store.editCard(b, 1, { blockedBy: [1] })), /sí misma/);
  assert.equal(hasErrors(lintCard(store.getCard(store.load(file), 2), store.load(file))), false);
});
