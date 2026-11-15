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
