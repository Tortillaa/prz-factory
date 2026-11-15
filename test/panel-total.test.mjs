import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lensesFor } from '../src/lanes.mjs';

// Same table as "panelTotal" in orca-plugin/src/worker.test.ts: the plugin cannot import src/.
const r = (...levels) => levels.map((l) => `## Risk\n${l} · y`).join('\n');
const full = { review: { lenses: ['qa', 'security', 'code', 'ops'], light: ['qa', 'code'] }, merge: { humanLabels: ['auth', 'needs-human'] } };
const noLight = { ...full, review: { ...full.review, light: [] } };
const cases = [
  ['Low then High', r('Low', 'High'), [], full, 4],
  ['High then Low', r('High', 'Low'), [], full, 2],
  ['trailing spaces and CRLF', '## Risk   \r\nLow · x\r\n', [], full, 2],
  ['emoji', r('🟢 Low'), [], full, 2],
  ['bold', r('**Low**'), [], full, 2],
  ['Medium', r('Medium'), [], full, 4],
  ['no Risk section', '## Fix\nx', [], full, 4],
  ['Low with auth', r('Low'), ['auth'], full, 4],
  ['Low with needs-human', r('Low'), ['needs-human'], full, 4],
  ['Low with empty light', r('Low'), [], noLight, 4],
];

test('lensesFor gives the totals the plugin table expects', () => {
  for (const [name, body, labels, config, total] of cases) assert.equal(lensesFor({ body, labels }, config).length, total, name);
  assert.deepEqual(lensesFor({ body: r('High', 'Low'), labels: [] }, full), ['qa', 'code']);
});
