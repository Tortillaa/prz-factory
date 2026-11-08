// factory.config.json lives at the root of the project the factory works on (committed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CONFIG_NAME = 'factory.config.json';

export const DEFAULTS = Object.freeze({
  baseBranch: 'main',
  protectedBranches: ['main'],
  // Commands that prove the build. The merge gate runs every one; all must exit 0.
  verify: [],
  maxWorkers: 2,
});

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function validate(config, file) {
  const fail = (msg) => {
    throw new Error(`${file}: ${msg}`);
  };
  if (typeof config.baseBranch !== 'string' || !config.baseBranch) fail('"baseBranch" must be a non-empty string');
  if (!Array.isArray(config.protectedBranches) || !config.protectedBranches.every((b) => typeof b === 'string')) {
    fail('"protectedBranches" must be an array of strings');
  }
  if (!Array.isArray(config.verify) || !config.verify.every((c) => typeof c === 'string' && c.trim())) {
    fail('"verify" must be an array of non-empty command strings');
  }
  if (!Number.isInteger(config.maxWorkers) || config.maxWorkers < 1) fail('"maxWorkers" must be a positive integer');
  return config;
}

// Returns { file, exists, config }. A missing file yields the defaults; a broken one throws.
export function loadConfig(root = repoRoot()) {
  const file = path.join(root, CONFIG_NAME);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, exists: false, config: { ...DEFAULTS } };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${err.message})`);
  }
  return { file, exists: true, config: validate({ ...DEFAULTS, ...parsed }, file) };
}

// Best guess at the commands that prove a project builds, for a fresh config.
export function detectVerify(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    return ['lint', 'typecheck', 'test', 'build'].filter((s) => scripts[s]).map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`));
  } catch {
    return [];
  }
}

export function detectBaseBranch(root) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return DEFAULTS.baseBranch;
  }
}
