// Read-only health check of the factory in a project. Each check: { name, ok, detail, fix? }.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { loadConfig, repoRoot } from './config.mjs';
import { listSkills, RUNTIME_DIR } from './install.mjs';
import * as store from './store.mjs';

// Runs a fixed command line. Goes through the shell so Windows .cmd shims (orca, factory) resolve.
function run(cmd, args, cwd) {
  try {
    return execSync([JSON.stringify(cmd), ...args].join(' '), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function gitOut(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function doctor(cwd = process.cwd()) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(ok || !fix ? {} : { fix }) });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22, `v${process.versions.node}`, 'install Node 22 or newer');

  const git = gitOut(['--version'], cwd);
  add('git', !!git, git || 'not found', 'install git');

  const root = repoRoot(cwd);
  const inRepo = gitOut(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
  add('git repo', inRepo, inRepo ? root : 'not inside a git repository', 'run the factory from inside a git repository');

  const orcaCmd = process.env.ORCA_CLI_COMMAND || 'orca';
  const orca = run(orcaCmd, ['--help'], cwd);
  const inOrca = Object.keys(process.env).some((k) => k.startsWith('ORCA_'));
  add('orca', !!orca, orca ? `${orcaCmd} found${inOrca ? ', running inside Orca' : ''}` : `${orcaCmd} not found`, 'install Orca (onorca.dev); workers need it');

  const factoryOnPath = run(process.platform === 'win32' ? 'where' : 'which', ['factory'], cwd);
  // The CLI either lives in the repo (vendored by `factory install`) or is on PATH (npm link).
  const vendored = path.join(repoRoot(cwd), RUNTIME_DIR, 'bin', 'factory.mjs');
  const cliWhere = fs.existsSync(vendored) ? `${RUNTIME_DIR}/bin/factory.mjs (in the repo)` : factoryOnPath ? factoryOnPath.split(/\r?\n/)[0] : null;
  add('factory CLI', !!cliWhere, cliWhere || 'not in the repo and not on PATH', 'run `npx -y github:Tortillaa/prz-factory install .` in the repo');

  try {
    const { file, exists, config } = loadConfig(root);
    if (!exists) add('config', false, `${file} missing`, 'run `factory install`');
    else if (!config.verify.length) add('config', false, 'verify is empty: the merge gate cannot prove the build', `add commands to "verify" in ${file}`);
    else add('config', true, `verify: ${config.verify.join(' && ')}`);
  } catch (err) {
    add('config', false, err.message, 'fix the JSON in factory.config.json');
  }

  const boardFile = store.resolveBoardPath(cwd);
  try {
    const board = store.load(boardFile);
    add('board', true, `${board.cards.length} cards · ${boardFile}`);
  } catch (err) {
    add('board', false, `${boardFile}: ${err.message}`, 'repair or remove the board file');
  }

  // A skill the project already has under the same name (its own ponytail, say) counts: install leaves it alone.
  const missing = listSkills().filter((name) => !fs.existsSync(path.join(root, '.claude', 'skills', name, 'SKILL.md')));
  add('skills', missing.length === 0, missing.length ? `not installed: ${missing.join(', ')}` : 'all installed', 'run `factory install`');

  let guards = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    guards = Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command || '').filter((c) => c.includes('factory-guard.mjs'));
  } catch {}
  const guardFile = fs.existsSync(path.join(root, '.claude', 'hooks', 'factory-guard.mjs'));
  add('guard hooks', guards.length >= 4 && guardFile, guardFile ? `${guards.length} guards wired` : 'factory-guard.mjs not installed', 'run `factory install` (without --no-hooks)');

  // Grok reads the same .claude/ skills, CLAUDE.md and guard hooks, but only in a folder it trusts,
  // and trusting the main checkout covers every worktree of the repo. Checked only when Grok is
  // installed or a lane runs on it: otherwise it is not this project's concern.
  let usesGrok = false;
  try {
    usesGrok = Object.values(loadConfig(root).config.agents || {}).some((a) => a.agent === 'grok');
  } catch {}
  const grok = findGrok();
  if (grok || usesGrok) {
    if (!grok) add('grok', false, 'a lane runs on grok but the Grok CLI is not installed', 'install Grok Build (https://docs.x.ai/build/overview.md) and sign in with `grok`');
    else {
      const out = run(grok, ['inspect', '--json'], root);
      let trusted = null;
      try {
        trusted = JSON.parse(out).projectTrusted === true;
      } catch {}
      if (trusted === null) add('grok', false, `${grok}: could not read \`grok inspect --json\``, 'run `grok inspect` here and check it works');
      else if (trusted) add('grok', true, 'project trusted: Grok loads the rules, skills and guard hooks in every worktree');
      // Only a problem when a lane actually runs on Grok here.
      else if (!usesGrok) add('grok', true, 'installed, project not trusted (no lane runs on grok here)');
      else add('grok', false, 'project not trusted: Grok workers would run without the rules, skills and guard hooks', `in ${root} run \`grok --trust inspect\` once (it trusts this repo and all its worktrees)`);
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// The Grok CLI: on PATH, or where its installer puts it (~/.grok/bin).
function findGrok() {
  const onPath = run(process.platform === 'win32' ? 'where' : 'which', ['grok'], process.cwd());
  if (onPath) return onPath.split(/\r?\n/)[0];
  const home = process.env.GROK_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.grok');
  const bin = path.join(home, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return fs.existsSync(bin) ? bin : null;
}
