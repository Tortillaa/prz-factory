import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

test('la web no usa emojis como iconos', () => {
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});

test('el CSS no lleva mayúsculas forzadas, degradados ni animaciones', () => {
  for (const bad of ['text-transform: uppercase', 'gradient(', 'animation']) assert.ok(!css.includes(bad), bad);
});

test('cada $(id) del script existe en el HTML', () => {
  const ids = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 10);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('la web ya no ofrece crear, editar ni arrastrar tarjetas', () => {
  for (const gone of ['new-idea', 'id="edit"', 'draggable']) assert.ok(!html.includes(gone), gone);
});

const { groupBoard, stationOf, ago } = await import('../public/board-view.mjs');
const card = (id, column, extra = {}) => ({ id, column, labels: [], unmet: [], comments: [], history: [], panel: { head: null, lenses: {} }, run: {}, ...extra });

test('groupBoard reparte las tarjetas por zona', () => {
  const at = (d) => ({ history: [{ at: `2026-11-${10 + d}T00:00:00Z`, to: 'done' }] });
  const cards = [
    card(1, 'blocked', { labels: ['needs-you'] }), card(2, 'blocked'), card(3, 'building', { assignee: 'w' }),
    card(4, 'review', { panel: { lenses: { code: { worker: 'r' } } } }), card(5, 'spec'), card(6, 'ready'),
    card(7, 'ready', { unmet: [3] }), card(8, 'backlog'), card(9, 'blocked', { labels: ['merge-approval'] }),
    ...Array.from({ length: 12 }, (_, i) => card(20 + i, 'done', at(i))),
  ];
  const g = groupBoard({ cards });
  assert.deepEqual(g.waiting.map((c) => c.id), [1, 9]);
  assert.deepEqual(g.inFlight.map((c) => c.id), [3, 4]);
  assert.deepEqual(g.queue.map((c) => c.id), [6, 7, 5, 2]);
  assert.deepEqual(g.backlog.map((c) => c.id), [8]);
  assert.deepEqual(g.done.map((c) => c.id), [31, 30, 29, 28, 27, 26, 25, 24, 23, 22]);
});

test('stationOf da la estación del riel y las lentes en review', () => {
  const st = (column) => stationOf(card(1, column), ['qa'])?.station ?? null;
  assert.deepEqual(['spec', 'building', 'review', 'merge', 'backlog', 'done'].map(st), ['spec', 'build', 'review', 'merge', null, null]);
  const r = stationOf(card(1, 'review', { panel: { lenses: { qa: { verdict: 'pass' } } } }), ['qa', 'code']);
  assert.deepEqual(r.lenses.map((l) => l.state), ['pass', 'waiting']);
  assert.equal(stationOf(card(1, 'blocked', { history: [{ from: 'building', to: 'blocked' }] })).station, 'build');
});

test('ago da la hora relativa', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const back = (s) => ago(new Date(now - s * 1000).toISOString(), now);
  assert.deepEqual([20, 90 * 60, 3 * 86400].map(back), ['ahora', 'hace 1 h', 'hace 3 d']);
  assert.equal(ago('nope', now), '');
});
