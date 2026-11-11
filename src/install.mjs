// Installs the factory into a target project: copies each skill under skills/ into
// <target>/.claude/skills/<name>/ and writes factory.config.json when it is missing.
// A skill folder the factory did not create (no marker file) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_NAME, DEFAULTS, detectBaseBranch, detectVerify } from './config.mjs';

export const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.factory-managed';
// The factory's own runtime, copied into every project so it needs nothing installed anywhere:
// `node .prz-factory/bin/factory.mjs` works in the project and in each of its worktrees (it is committed).
export const RUNTIME_DIR = '.prz-factory';
const RUNTIME_PARTS = ['bin', 'src', 'public', 'hooks', 'skills', 'package.json'];

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

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
  SessionStart: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${RUNTIME_DIR}/bin/factory.mjs" cleanup --hint 2>/dev/null || factory cleanup --hint 2>/dev/null || true` }] }],
};
const isFactoryHook = (h) => /factory-guard\.mjs|factory cleanup|factory\.mjs" cleanup/.test(h.command || '');

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

// Copies the runtime into <target>/.prz-factory, replacing an older copy. Skipped when installing the
// factory into itself, or when the running factory is that very copy (it cannot replace itself).
function vendorRuntime(target, factoryRoot) {
  const dest = path.join(target, RUNTIME_DIR);
  if (samePath(target, factoryRoot) || samePath(dest, factoryRoot)) return { dir: dest, status: 'skipped', reason: 'this is the factory itself' };
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
    return { dir: dest, status: 'skipped', reason: 'exists and is not managed by the factory' };
  }
  const existed = fs.existsSync(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const part of RUNTIME_PARTS) {
    const from = path.join(factoryRoot, part);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, part), { recursive: true });
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, MARKER), `Managed by prz-factory ${version}: \`factory install\` replaces this folder. Commit it.\n`);
  return { dir: dest, status: existed ? 'updated' : 'installed', version };
}

export function install(target, { factoryRoot = FACTORY_ROOT, hooks = true } = {}) {
  target = path.resolve(target);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const report = { target, skills: [], config: null, hooks: null, runtime: vendorRuntime(target, factoryRoot) };
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
