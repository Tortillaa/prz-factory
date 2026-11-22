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

test('las tarjetas en marcha salen solo en la línea de montaje, y cada ficha se abre con Tab y Enter', () => {
  assert.doesNotMatch(html, /En marcha|id="flight"/);
  const ficha = html.match(/const ficha = [\s\S]*?'line'\);/)[0];
  assert.match(ficha, /open\(/);
  assert.match(ficha, /roles\(c\)/);
  assert.match(ficha, /when\(since\(c\)\)/);
  assert.match(ficha, /lenses\.length > 0 && .*lensChips/);
  const open = html.match(/function open\([\s\S]*?\n}/)[0];
  assert.match(open, /tabIndex = 0/);
  assert.match(open, /onclick[^\n]*openCard/);
  assert.match(open, /onkeydown[^\n]*Enter[^\n]*openCard/);
});

const { groupBoard, stationOf, ago, lineOf, statsOf, reasonsOf, roleOf, dayGroups, shorten } = await import('../public/board-view.mjs');
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
  assert.deepEqual(r.lenses.map((l) => l.state), ['pass', 'pending']);
  assert.equal(stationOf(card(1, 'blocked', { history: [{ from: 'building', to: 'blocked' }] })).station, 'build');
});

test('ago da la hora relativa', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const back = (s) => ago(new Date(now - s * 1000).toISOString(), now);
  assert.deepEqual([20, 90 * 60, 3 * 86400].map(back), ['ahora', 'hace 1 h', 'hace 3 d']);
  assert.equal(ago('nope', now), '');
});

const noon = (d, h = 12) => new Date(2026, 10, d, h).toISOString(); // local time: the tests hold in any timezone
const NOW = new Date(2026, 10, 16, 15).getTime();
const landed = (id, from, to) => card(id, 'done', { history: [{ at: from, to: 'spec' }, { at: to, to: 'done' }] });

test('lineOf da las cuatro estaciones con su recuento, sus tarjetas y las lentes de review', () => {
  const cards = [
    card(1, 'spec', { assignee: 's' }), card(2, 'building', { assignee: 'b' }), card(3, 'ready'),
    card(4, 'review', { panel: { lenses: { qa: { verdict: 'pass' }, code: { worker: 'r' } } } }), card(5, 'merge', { assignee: 'm' }),
  ];
  const line = lineOf({ cards, lenses: ['qa', 'code', 'ops'] });
  assert.deepEqual(line.map((s) => [s.station, s.count, s.cards.map((x) => x.card.id)]),
    [['spec', 1, [1]], ['build', 1, [2]], ['review', 1, [4]], ['merge', 1, [5]]]); // #3 has no worker: it is in the queue, not on the line
  assert.deepEqual(line[2].cards[0].lenses.map((l) => l.state), ['pass', 'working', 'pending']);
  assert.deepEqual(lineOf({ cards: [], lenses: [] }).map((s) => s.count), [0, 0, 0, 0]);
});

test('statsOf cuenta en curso, te esperan, mergeadas hoy y la media de las últimas diez', () => {
  const cards = [
    card(1, 'building', { assignee: 'w' }), card(2, 'blocked', { labels: ['needs-you'] }),
    landed(3, noon(16, 8), noon(16, 10)), landed(4, noon(15, 8), noon(15, 9)), // 120 min, today; 60 min, yesterday
    ...Array.from({ length: 10 }, (_, i) => landed(10 + i, noon(1, 8), noon(1, 9))), // older: outside the last ten
  ];
  const s = statsOf({ cards }, NOW);
  assert.deepEqual([s.inFlight, s.waiting, s.mergedToday], [1, 1, 1]);
  assert.equal(s.minutes, 66); // (120 + 60 + 8 * 60) / 10
  assert.equal(statsOf({ cards: [card(1, 'spec')] }, NOW).minutes, null);
});

test('reasonsOf devuelve los motivos del gate como frases, sin emoji ni la instrucción', () => {
  const gate = '[merge] 🙋 necesita a una persona\nMerge para una persona: riesgo high; label auth; rutas sensibles: src/store.mjs; diff grande: 477 líneas (máximo 400).\nPara aprobarlo: revisa factory/31-x (a59d1553) y ejecuta `factory merge 31 --sha a59d1553 --human`.';
  const after = { text: 'Decisión: no se aprueba todavía.' };
  assert.deepEqual(reasonsOf(card(1, 'blocked', { comments: [{ text: gate }, after] })),
    ['riesgo high', 'label auth', 'rutas sensibles: src/store.mjs', 'diff grande: 477 líneas (máximo 400)']);
  assert.deepEqual(reasonsOf(card(1, 'blocked', { comments: [after] })), []);
});

test('roleOf pone el rol en palabras', () => {
  assert.deepEqual(['spec-3', 'build-34-r2', 'review-qa-7', 'merge-9', 'review-code-7-r3', 'ana'].map(roleOf),
    ['Spec Writer', 'Builder · ronda 2', 'Reviewer qa', 'Agente de merge', 'Reviewer code · ronda 3', 'ana']);
});

test('dayGroups agrupa en Hoy, Ayer y la fecha, por día de calendario', () => {
  const done = [card(1, 'done', { history: [{ at: noon(16, 1), to: 'done' }] }), card(2, 'done', { history: [{ at: noon(15, 23), to: 'done' }] }),
    card(3, 'done', { history: [{ at: noon(15, 2), to: 'done' }] }), card(4, 'done', { history: [{ at: noon(12), to: 'done' }] })];
  const g = dayGroups(done, NOW);
  assert.deepEqual(g.map((x) => [x.day, x.cards.map((c) => c.id)]), [['Hoy', [1]], ['Ayer', [2, 3]], [g[2].day, [4]]]);
  assert.match(g[2].day, /12/);
});

test('shorten corta en una palabra y deja los títulos cortos', () => {
  assert.equal(shorten('uno dos tres', 20), 'uno dos tres');
  assert.equal(shorten('uno dos tres cuatro', 10), 'uno dos…');
});

test('las filas que se abren se alcanzan con el teclado', () => {
  assert.match(html, /tabIndex = 0/);
  assert.match(html, /e\.key === 'Enter' && e\.target === node/);
});

test('renderMarkdown pinta encabezados, listas, checklists, código y enlaces, y escapa el HTML', async () => {
  const { renderMarkdown } = await import('../public/board-view.mjs');
  const html = renderMarkdown('## Fix\n- uno\n- [ ] dos\n- [x] tres\n\n```\n<b>x</b>\n```\nVer [docs](https://a.dev) y `foo`\n<script>alert(1)</script>');
  assert.equal(html, '<h4>Fix</h4><ul><li>uno</li><li><input type="checkbox" disabled> dos</li><li><input type="checkbox" disabled checked> tres</li></ul>'
    + '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre><p>Ver <a href="https://a.dev" target="_blank" rel="noreferrer noopener">docs</a> y <code>foo</code><br>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1))'), /<a /);
});

test('la ficha es un panel lateral, no un diálogo, y no edita el cuerpo ni el título', () => {
  assert.doesNotMatch(html, /<dialog|showModal/);
  assert.match(html, /<aside id="detail"/);
  assert.doesNotMatch(html.match(/<aside id="detail"[\s\S]*?<\/aside>/)[0], /<textarea|name="title"|name="body"/);
});

test('el nombre de la captura se saca con barra normal e invertida (rutas de Windows)', () => {
  assert.ok(html.includes('f.split(/[\\\\/]/).pop()'));
});

test('la regla [hidden] existe: sin ella Forzar se ve siempre', () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('la línea parada pierde la altura mínima y con tarjetas en marcha la conserva', () => {
  assert.match(css, /\.line:not\(\.parada\)\s*\{[^}]*min-height: 240px/);
  assert.doesNotMatch(css.match(/\.line\.parada\s*\{[^}]*\}/)[0], /min-height/);
  assert.doesNotMatch(css.match(/\.line\s*\{[^}]*\}/)[0], /min-height/);
  assert.match(html, /classList\.toggle\('parada', parada\)/);
});
