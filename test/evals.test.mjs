// The eval harness itself, driven by a fake agent: no LLM, so it runs in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listCases, loadCase, prepare, grade, runCase } from '../src/evals.mjs';
import * as store from '../src/store.mjs';

const FAKE = `"${process.execPath}" "${path.join(import.meta.dirname, 'fake-agent.mjs')}"`;

test('every case loads and every setup builds', () => {
  const names = listCases();
  assert.deepEqual(names, ['build-empty-cart', 'qa-missing-test', 'review-merge']);
  for (const name of names) {
    const c = loadCase(name);
    const world = prepare(c);
    const card = store.getCard(store.load(world.file), 1);
    assert.equal(card.assignee, `${c.lane}-1`, `${name}: claimed for its worker`);
    // Before any agent runs, the case must not already pass.
    assert.ok(grade(c, world).some((g) => !g.ok), `${name} passes without an agent`);
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});

test('a good build passes every grader; doing nothing fails them', { timeout: 120_000 }, () => {
  const good = runCase('build-empty-cart', { agent: FAKE });
  assert.equal(good.ok, true, JSON.stringify(good.graders, null, 2));
  assert.ok(!good.kept, 'a passing run cleans up');

  const prev = process.env.FAKE_AGENT;
  process.env.FAKE_AGENT = 'noop';
  try {
    const lazy = runCase('build-empty-cart', { agent: FAKE });
    assert.equal(lazy.ok, false);
    assert.deepEqual(lazy.graders.filter((g) => !g.ok).map((g) => g.grader), ['card', 'released', 'comment', 'branchChanges', 'verifyAt', 'behaviour']);
    assert.ok(fs.existsSync(lazy.kept), 'a failing run is kept for inspection');
    fs.rmSync(lazy.kept, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.FAKE_AGENT;
    else process.env.FAKE_AGENT = prev;
  }
});
