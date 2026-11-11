// factory.config.json lives at the root of the project the factory works on (committed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CONFIG_NAME = 'factory.config.json';

// Labels that mark business-critical work. The spec writer sets them; the merge gate hands any card
// carrying one to a person. needs-human is the escape hatch any agent may add, never remove.
export const BUSINESS_LABELS = ['auth', 'payments', 'pricing', 'schema', 'ops', 'money', 'needs-human'];
// Review lenses the factory ships a checklist for (skills/factory-review/references/lenses.md).
export const LENSES = ['qa', 'security', 'code', 'ops'];

export const DEFAULTS = Object.freeze({
  baseBranch: 'main',
  protectedBranches: ['main'],
  // Commands that prove the build. The merge gate runs every one; all must exit 0.
  verify: [],
  verifyTimeoutMinutes: 20,
  maxWorkers: 2,
  // When the merge gate hands the merge to a person instead of doing it: anything that can touch
  // the business or keep the product running. humanPaths are globs checked against the diff.
  merge: { humanRisk: ['high'], humanLabels: BUSINESS_LABELS, humanPaths: [], maxLines: 400 },
  // The review panel: one expert reviewer per lens, in parallel. All must pass the same commit.
  review: { lenses: LENSES },
  // Which Orca agent runs each lane: { <lane>: { agent, model?, effort? } }. A lane without an entry
  // runs on DEFAULT_AGENT. Example: review on Grok to spare Claude's quota.
  agents: {},
  // Optional GitHub mirror: `factory pr` and, with pushBase, a push of the base after each merge.
  github: { remote: 'origin', pushBase: false, draft: true },
});

export const LANE_NAMES = ['spec', 'build', 'qa', 'review'];
export const DEFAULT_AGENT = Object.freeze({ agent: 'claude' });

// How the coordinator starts a worker for `lane`: the flags it passes to `orca orchestration worker-start`.
export function launchFor(lane, config) {
  const pick = config.agents?.[lane];
  return pick ? { agent: pick.agent, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) } : { ...DEFAULT_AGENT };
}

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
  if (!(config.verifyTimeoutMinutes > 0)) fail('"verifyTimeoutMinutes" must be a positive number');
  const m = config.merge;
  const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!m || typeof m !== 'object') fail('"merge" must be an object');
  if (!strings(m.humanRisk) || !m.humanRisk.every((r) => ['low', 'medium', 'high'].includes(r))) {
    fail('"merge.humanRisk" must list low, medium or high');
  }
  if (!strings(m.humanLabels)) fail('"merge.humanLabels" must be an array of strings');
  if (!strings(m.humanPaths)) fail('"merge.humanPaths" must be an array of glob strings');
  if (!Number.isInteger(m.maxLines) || m.maxLines < 1) fail('"merge.maxLines" must be a positive integer');
  const r = config.review;
  if (!r || !strings(r.lenses) || !r.lenses.length || !r.lenses.every((l) => LENSES.includes(l)) || new Set(r.lenses).size !== r.lenses.length) {
    fail(`"review.lenses" must list one or more of ${LENSES.join(', ')}, without repeats`);
  }
  const a = config.agents;
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('"agents" must be an object of { <lane>: { agent, model?, effort? } }');
  for (const [lane, pick] of Object.entries(a)) {
    if (!LANE_NAMES.includes(lane)) fail(`"agents.${lane}": unknown lane (use: ${LANE_NAMES.join(', ')})`);
    if (!pick || typeof pick.agent !== 'string' || !pick.agent.trim()) fail(`"agents.${lane}.agent" must name an Orca agent (claude, codex, grok, …)`);
    for (const k of ['model', 'effort']) if (pick[k] !== undefined && (typeof pick[k] !== 'string' || !pick[k].trim())) fail(`"agents.${lane}.${k}" must be a non-empty string`);
    // Orca refuses --effort without --model.
    if (pick.effort && !pick.model) fail(`"agents.${lane}.effort" needs "agents.${lane}.model"`);
  }
  const g = config.github;
  if (!g || typeof g.remote !== 'string' || !g.remote || typeof g.pushBase !== 'boolean' || typeof g.draft !== 'boolean') {
    fail('"github" must be { remote: string, pushBase: boolean, draft: boolean }');
  }
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
  return { file, exists: true, config: validate({ ...DEFAULTS, ...parsed, merge: { ...DEFAULTS.merge, ...parsed.merge }, review: { ...DEFAULTS.review, ...parsed.review }, agents: parsed.agents ?? DEFAULTS.agents, github: { ...DEFAULTS.github, ...parsed.github } }, file) };
}

// Best guess at the commands that prove a project builds, for a fresh config.
// A guess only: onboarding runs the result and asks the person before trusting it.
export function detectVerify(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      const run = (s) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : `run ${s}`}`);
      return ['lint', 'typecheck', 'test', 'build'].filter((s) => scripts[s]).map(run);
    } catch {
      return [];
    }
  }
  if (has('Cargo.toml')) return ['cargo build', 'cargo test'];
  if (has('go.mod')) return ['go vet ./...', 'go test ./...'];
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) return has('tests') || has('test') ? ['python -m pytest'] : [];
  if (has('Makefile')) {
    const make = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
    return /^test:/m.test(make) ? ['make test'] : [];
  }
  return [];
}

export function detectBaseBranch(root) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return DEFAULTS.baseBranch;
  }
}
