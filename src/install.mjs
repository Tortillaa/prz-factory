// Installs the factory into a target project: copies each skill under skills/ into
// <target>/.claude/skills/<name>/ and writes factory.config.json when it is missing.
// A skill folder the factory did not create (no marker file) is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_NAME, DEFAULTS, detectBaseBranch, detectVerify } from './config.mjs';

export const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.factory-managed';
// The factory's own runtime, copied into every project so it needs nothing installed anywhere:
// `node .prz-factory/bin/factory.mjs` works in the project and in each of its worktrees (it is committed).
export const RUNTIME_DIR = '.prz-factory';
const RUNTIME_PARTS = ['bin', 'src', 'public', 'hooks', 'skills', 'user-skills', 'orca-plugin', 'package.json'];

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export function listSkills(factoryRoot = FACTORY_ROOT, folder = 'skills') {
  const dir = path.join(factoryRoot, folder);
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

// Where git looks for the pre-push hook of `dir`: shared by worktrees, honours core.hooksPath. Null outside a repo.
export function prePushPath(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
export const PRE_PUSH_MARKER = 'factory-managed';
// The ESM check the pre-push wrapper runs.
export const prePushScript = (file) => path.join(path.dirname(file), 'factory-pre-push.mjs');

// Installs the git pre-push hook that refuses non-fast-forward pushes to protected branches.
// A pre-push hook the factory did not write is left alone.
function installPrePush(target, factoryRoot) {
  const file = prePushPath(target);
  if (!file) return null;
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(PRE_PUSH_MARKER)) {
    return { file, status: 'skipped', reason: 'a pre-push hook that the factory did not write already exists' };
  }
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The hook git runs is a sh wrapper: an extensionless ESM file would take its module format from the
  // repo's package.json ("type":"commonjs" skips the check; Node < 22.7 cannot load it).
  fs.copyFileSync(path.join(factoryRoot, 'hooks', 'factory-pre-push.mjs'), prePushScript(file));
  fs.writeFileSync(file, `#!/bin/sh\n# ${PRE_PUSH_MARKER}: runs factory-pre-push.mjs (same folder); no node means no push.\nFACTORY_PRE_PUSH=1 exec node "$(dirname "$0")/factory-pre-push.mjs" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return { file, status: existed ? 'updated' : 'installed' };
}

// Copies each skill of <factoryRoot>/<folder> into <skillsDir>/<name>, with a marker. A folder
// without the marker is the user's own skill with the same name: it is left alone.
function copySkills(factoryRoot, folder, skillsDir) {
  return listSkills(factoryRoot, folder).map((name) => {
    const dest = path.join(skillsDir, name);
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) return { name, status: 'skipped', reason: 'exists and is not managed by the factory' };
    const existed = fs.existsSync(dest);
    // Replace wholesale so files removed from the factory disappear from the target too.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(factoryRoot, folder, name), dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARKER), 'Managed by prz-factory: `factory install` overwrites this folder.\n');
    return { name, status: existed ? 'updated' : 'installed' };
  });
}

// Claude Code's user folder: its skills there are available in every project on this machine.
export const userClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// `install --user`: copies the skills of user-skills/ (prz-factory-init) into the user's Claude
// folder, once per machine, so any agent session can bring the factory into its project when asked.
export function installUser({ factoryRoot = FACTORY_ROOT, claudeDir = userClaudeDir() } = {}) {
  const skillsDir = path.join(claudeDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  return { target: skillsDir, skills: copySkills(factoryRoot, 'user-skills', skillsDir) };
}

export function install(target, { factoryRoot = FACTORY_ROOT, hooks = true } = {}) {
  target = path.resolve(target);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const report = { target, skills: [], config: null, hooks: null, prePush: null, runtime: vendorRuntime(target, factoryRoot) };
  report.prePush = installPrePush(target, factoryRoot);
  if (hooks) report.hooks = installHooks(target, factoryRoot);

  report.skills = copySkills(factoryRoot, 'skills', path.join(target, '.claude', 'skills'));

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
