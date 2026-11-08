// Installs the factory into a target project: copies each skill under skills/ into
// <target>/.claude/skills/<name>/ and writes factory.config.json when it is missing.
// A skill folder the factory did not create (no marker file) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_NAME, DEFAULTS, detectBaseBranch, detectVerify } from './config.mjs';

export const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.factory-managed';

export function listSkills(factoryRoot = FACTORY_ROOT) {
  const dir = path.join(factoryRoot, 'skills');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

export function install(target, { factoryRoot = FACTORY_ROOT } = {}) {
  target = path.resolve(target);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const report = { target, skills: [], config: null };

  for (const name of listSkills(factoryRoot)) {
    const dest = path.join(target, '.claude', 'skills', name);
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
      report.skills.push({ name, status: 'skipped', reason: 'exists and is not managed by the factory' });
      continue;
    }
    const existed = fs.existsSync(dest);
    // Replace wholesale so files removed from the factory disappear from the target too.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(factoryRoot, 'skills', name), dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARKER), 'Managed by prz-factory: `factory install` overwrites this folder.\n');
    report.skills.push({ name, status: existed ? 'updated' : 'installed' });
  }

  const configFile = path.join(target, CONFIG_NAME);
  if (fs.existsSync(configFile)) {
    report.config = { file: configFile, status: 'kept' };
  } else {
    const baseBranch = detectBaseBranch(target);
    const config = { ...DEFAULTS, baseBranch, protectedBranches: [baseBranch], verify: detectVerify(target) };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    report.config = { file: configFile, status: 'created' };
  }
  return report;
}
