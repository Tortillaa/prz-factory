// Read-only health check of the factory in a project. Each check: { name, ok, detail, fix? }.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { loadConfig, repoRoot } from './config.mjs';
import { listSkills, MARKER } from './install.mjs';
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
  add('factory on PATH', !!factoryOnPath, factoryOnPath ? factoryOnPath.split(/\r?\n/)[0] : 'not found', 'run `npm link` in the prz-factory repo');

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

  const missing = listSkills().filter((name) => !fs.existsSync(path.join(root, '.claude', 'skills', name, MARKER)));
  add('skills', missing.length === 0, missing.length ? `not installed: ${missing.join(', ')}` : 'all installed', 'run `factory install`');

  return { ok: checks.every((c) => c.ok), checks };
}
