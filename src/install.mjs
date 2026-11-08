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

const GUARD_FILE = 'factory-guard.mjs';
const guardCmd = (guard) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD_FILE}" ${guard}`;

// The factory's entries in .claude/settings.json. Anything whose command mentions factory-guard.mjs
// or `factory cleanup` is the factory's: install replaces those and leaves every other hook alone.
export const HOOKS = {
  PreToolUse: [
    { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: guardCmd('protected-push') }, { type: 'command', command: guardCmd('delete-outside') }] },
    { matcher: 'Read|Grep|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guardCmd('secrets') }] },
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [{ type: 'command', command: guardCmd('key-literals') }] },
  ],
  SessionStart: [{ hooks: [{ type: 'command', command: 'factory cleanup --hint 2>/dev/null || true' }] }],
};
const isFactoryHook = (h) => /factory-guard\.mjs|factory cleanup/.test(h.command || '');

export function mergeSettings(settings) {
  const out = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const [event, groups] of Object.entries(out.hooks)) {
    out.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isFactoryHook(h)) }))
      .filter((g) => g.hooks.length);
  }
  for (const [event, groups] of Object.entries(HOOKS)) out.hooks[event] = [...(out.hooks[event] || []), ...groups];
  return out;
}

function installHooks(target, factoryRoot) {
  const dir = path.join(target, '.claude', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(factoryRoot, 'hooks', GUARD_FILE), path.join(dir, GUARD_FILE));
  const file = path.join(target, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}); fix it or run install with --no-hooks`);
    }
  }
  fs.writeFileSync(file, JSON.stringify(mergeSettings(settings), null, 2) + '\n');
  return { file, guard: path.join(dir, GUARD_FILE) };
}

export function install(target, { factoryRoot = FACTORY_ROOT, hooks = true } = {}) {
  target = path.resolve(target);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const report = { target, skills: [], config: null, hooks: null };
  if (hooks) report.hooks = installHooks(target, factoryRoot);

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
