// The README is the index of this repo's three sections: rules, roles and skills. It must not fall behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listSkills, FACTORY_ROOT } from '../src/install.mjs';
import { LANE_NAMES, LENSES } from '../src/config.mjs';
import { GUARDS } from '../hooks/factory-guard.mjs';

const readme = fs.readFileSync(path.join(FACTORY_ROOT, 'README.md'), 'utf8');
const section = (title) => {
  const start = readme.indexOf(`\n## ${title}\n`);
  assert.ok(start !== -1, `README has no "## ${title}" section`);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
};

test('README: the skills section lists every skill the factory ships', () => {
  const text = section('Skills');
  for (const name of listSkills()) assert.ok(text.includes(`\`${name}\``), `skill ${name} is missing from the README`);
});

test('README: the roles section covers every lane, its skill and every review lens', () => {
  const text = section('Roles de agentes');
  for (const lane of LANE_NAMES) assert.ok(text.includes(`\`factory-${lane}\``), `role ${lane} is missing from the README`);
  assert.ok(text.includes('`factory-run`'), 'the coordinator is missing from the README');
  for (const lens of LENSES) assert.ok(text.includes(`| \`${lens}\` |`), `lens ${lens} is missing from the README`);
});

test('README: the rules section names every guard, and deploy and plugin instructions exist', () => {
  const text = section('Reglas para los agentes');
  for (const guard of Object.keys(GUARDS)) assert.ok(text.includes(`\`${guard}\``), `guard ${guard} is missing from the README`);
  assert.match(section('Despliegue'), /npx -y github:Tortillaa\/prz-factory install \./);
  assert.match(section('Plugin para Orca'), /orca plugin install \.prz-factory\/orca-plugin --approve/);
});
