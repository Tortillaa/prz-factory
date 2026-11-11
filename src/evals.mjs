// Skill evals: each case builds a throwaway repo from a fixture, sets up the board and git state
// for one lane (and, in review, one lens), hands an agent the same spec a real worker gets, and grades what changed with
// deterministic checks. The agent is a shell command (headless Claude Code by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import * as store from './store.mjs';
import * as run from './run.mjs';
import { install, FACTORY_ROOT } from './install.mjs';
import { loadConfig } from './config.mjs';
import { runVerify } from './verify.mjs';
import { git, revParse, isAncestor } from './git.mjs';
import { riskLevel } from './ticket.mjs';

export const EVALS_DIR = path.join(FACTORY_ROOT, 'evals');
export const DEFAULT_AGENT = 'claude -p --permission-mode acceptEdits --allowedTools "Bash Read Edit Write Glob Grep Skill"';

export function listCases(dir = EVALS_DIR) {
  return fs
    .readdirSync(path.join(dir, 'cases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadCase(name, dir = EVALS_DIR) {
  return { name, ...JSON.parse(fs.readFileSync(path.join(dir, 'cases', `${name}.json`), 'utf8')) };
}

function sh(command, cwd) {
  execSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

// Builds the case's world. Returns { root, repo, worktree, file, config, branchShas }.
export function prepare(c, { dir = EVALS_DIR } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `factory-eval-${c.name}-`)));
  const repo = path.join(root, 'repo');
  fs.cpSync(path.join(dir, 'fixtures', c.fixture), repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'eval@example.com'], repo);
  git(['config', 'user.name', 'eval'], repo);
  install(repo);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'factory.config.json'), 'utf8'));
  if (c.verify) cfg.verify = c.verify;
  // A case reviews with its own panel: one lens lets a single agent complete it and reach the gate.
  if (c.lenses) cfg.review = { lenses: c.lenses };
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'fixture'], repo);

  const file = store.resolveBoardPath(repo);
  let worktree = null;
  const where = (step) => (step.cwd === 'worktree' ? worktree : repo);
  const expand = (v) => (typeof v === 'string' ? v.replace('${worktree}', worktree ?? '') : v);

  for (const step of c.setup) {
    if (step.card) {
      const { title, bodyFile, labels, column = 'backlog' } = step.card;
      const body = bodyFile ? fs.readFileSync(path.join(dir, 'fixtures', c.fixture, bodyFile), 'utf8') : step.card.body;
      store.update(file, (b) => {
        const card = store.addCard(b, { title, body, labels });
        if (column !== 'backlog') store.moveCard(b, card.id, column, 'eval', { force: true });
      });
    } else if (step.worktree) {
      worktree = path.join(root, `factory-1`);
      git(['worktree', 'add', '-q', '--detach', worktree, 'main'], repo);
    } else if (step.sh) {
      sh(step.sh, where(step));
    } else if (step.write) {
      const target = path.join(where(step.write), step.write.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, step.write.content);
    } else if (step.run) {
      const { id, ...fields } = step.run;
      store.update(file, (b) => store.editCard(b, id, { run: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, expand(v)])) }));
    } else if (step.comment) {
      store.update(file, (b) => store.commentCard(b, step.comment.id, step.comment));
    } else if (step.claim) {
      store.update(file, (b) => (step.claim.lens ? store.claimLens(b, step.claim.id, step.claim.lens, step.claim.as) : store.claimCard(b, step.claim.id, step.claim.as)));
    } else if (step.panel) {
      // The whole panel passed the branch head: what a card in merge looks like.
      const card = store.getCard(store.load(file), step.panel.id);
      const head = revParse(`refs/heads/${card.run.branch}`, repo);
      const lenses = loadConfig(repo).config.review.lenses;
      store.update(file, (b) => {
        const c = store.getCard(b, step.panel.id);
        c.panel = { head, lenses: Object.fromEntries(lenses.map((l) => [l, { verdict: 'pass', sha: head }])) };
        store.editCard(b, c.id, { run: { reviewedSha: head } });
      });
    } else {
      throw new Error(`${c.name}: unknown setup step ${JSON.stringify(step)}`);
    }
  }
  // Branch heads as setup left them: noCommits graders compare against these.
  const branchShas = Object.fromEntries(
    store.load(file).cards.filter((k) => k.run.branch).map((k) => [k.id, revParse(`refs/heads/${k.run.branch}`, repo)]),
  );
  return { root, repo, worktree, file, config: loadConfig(repo).config, branchShas };
}

export function promptFor(c, world) {
  if (!c.prompt.startsWith('spec:')) return c.prompt;
  const id = Number(c.prompt.slice(5));
  const card = store.getCard(store.load(world.file), id);
  return run.spec(card, c.lane, run.workerName(id, c.lane, c.lens ?? null), world.repo, c.lens ?? null);
}

const GRADERS = {
  card: ({ id, column }, w) => {
    const c = store.getCard(store.load(w.file), id);
    return [c.column === column, `column ${c.column}, expected ${column}`];
  },
  released: ({ id }, w) => {
    const c = store.getCard(store.load(w.file), id);
    const held = store.claimsOf(c).map((k) => k.worker);
    return [held.length === 0, held.length ? `still claimed by ${held.join(', ')}` : 'released'];
  },
  comment: ({ id, role, matches }, w) => {
    const all = store.getCard(store.load(w.file), id).comments.filter((x) => x.role === role);
    const hit = matches ? all.filter((x) => new RegExp(matches, 'i').test(x.text)) : all;
    return [hit.length > 0, `${all.length} ${role} comments${matches ? `, ${hit.length} matching /${matches}/` : ''}`];
  },
  // The spec writer's output: a body that passes lint (and, optionally, matches a pattern).
  spec: ({ id, matches }, w) => {
    const board = store.load(w.file);
    const c = store.getCard(board, id);
    const errors = store.lintCard(c, board).filter((i) => i.severity === 'error');
    if (errors.length) return [false, `lint: ${errors.map((e) => e.message).join('; ')}`];
    const ok = !matches || new RegExp(matches, 'i').test(c.body);
    return [ok, ok ? 'body passes lint' : `body does not match /${matches}/`];
  },
  labels: ({ id, includes = [], excludes = [] }, w) => {
    const { labels } = store.getCard(store.load(w.file), id);
    const missing = includes.filter((l) => !labels.includes(l));
    const extra = excludes.filter((l) => labels.includes(l));
    return [!missing.length && !extra.length, `labels [${labels.join(', ')}]${missing.length ? `, missing ${missing.join(', ')}` : ''}${extra.length ? `, unexpected ${extra.join(', ')}` : ''}`];
  },
  risk: ({ id, level }, w) => {
    const got = riskLevel(store.getCard(store.load(w.file), id).body);
    return [got === level, `risk ${got}, expected ${level}`];
  },
  branchChanges: ({ id, paths }, w) => {
    const branch = store.getCard(store.load(w.file), id).run.branch;
    if (!branch || !revParse(`refs/heads/${branch}`, w.repo)) return [false, 'no branch'];
    const changed = git(['diff', '--name-only', `main...${branch}`], w.repo).split(/\r?\n/).filter(Boolean);
    const missing = paths.filter((p) => !changed.some((f) => f === p || f.startsWith(p)));
    return [missing.length === 0, missing.length ? `not changed: ${missing.join(', ')} (changed: ${changed.join(', ') || 'nothing'})` : changed.join(', ')];
  },
  verifyAt: ({ id }, w) => {
    const branch = store.getCard(store.load(w.file), id).run.branch;
    if (!branch) return [false, 'no branch'];
    const tmp = path.join(w.root, `verify-${id}`);
    git(['worktree', 'add', '-q', '--detach', tmp, branch], w.repo);
    try {
      const r = runVerify(w.config.verify, tmp, w.config);
      return [r.ok, r.results.map((x) => `${x.command}: ${x.code}`).join(', ')];
    } finally {
      git(['worktree', 'remove', '--force', tmp], w.repo);
    }
  },
  behaviour: ({ id, run: command }, w) => {
    const branch = store.getCard(store.load(w.file), id).run.branch;
    if (!branch) return [false, 'no branch'];
    const tmp = path.join(w.root, `behaviour-${id}`);
    git(['worktree', 'add', '-q', '--detach', tmp, branch], w.repo);
    try {
      const r = spawnSync(command, { cwd: tmp, shell: true, encoding: 'utf8' });
      return [r.status === 0, `exit ${r.status}`];
    } finally {
      git(['worktree', 'remove', '--force', tmp], w.repo);
    }
  },
  onBase: ({ id }, w) => {
    const branch = store.getCard(store.load(w.file), id).run.branch;
    const head = branch && revParse(`refs/heads/${branch}`, w.repo);
    return [!!head && isAncestor(head, 'refs/heads/main', w.repo), head ? `main ${revParse('main', w.repo).slice(0, 8)}` : 'no branch'];
  },
  noCommits: ({ id }, w) => {
    const branch = store.getCard(store.load(w.file), id).run.branch;
    const now = branch && revParse(`refs/heads/${branch}`, w.repo);
    return [now === w.branchShas[id], now === w.branchShas[id] ? 'branch untouched' : `branch moved to ${now?.slice(0, 8)}`];
  },
};

export function grade(c, world) {
  return c.graders.map((g) => {
    const [kind, args] = Object.entries(g)[0];
    if (!GRADERS[kind]) return { grader: kind, ok: false, detail: 'unknown grader' };
    try {
      const [ok, detail] = GRADERS[kind](args, world);
      return { grader: kind, ok, detail };
    } catch (err) {
      return { grader: kind, ok: false, detail: err.message };
    }
  });
}

// Runs one case end to end. agent: a shell command that reads the prompt on stdin.
export function runCase(name, { agent = process.env.FACTORY_EVAL_AGENT || DEFAULT_AGENT, dir = EVALS_DIR, keep = false, timeoutMinutes } = {}) {
  const c = loadCase(name, dir);
  const started = Date.now();
  const world = prepare(c, { dir });
  const prompt = promptFor(c, world);
  const cwd = world.worktree ?? world.repo;
  const r = spawnSync(agent, {
    cwd,
    shell: true,
    input: prompt,
    encoding: 'utf8',
    timeout: (timeoutMinutes ?? c.timeoutMinutes ?? 20) * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FACTORY_BOARD: '' },
  });
  const log = path.join(world.root, 'agent.log');
  fs.writeFileSync(log, `$ ${agent}\n\n--- prompt ---\n${prompt}\n--- stdout ---\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}\n`);
  const graders = grade(c, world);
  const result = {
    case: name,
    ok: graders.every((g) => g.ok),
    agentExit: r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status,
    seconds: Math.round((Date.now() - started) / 1000),
    graders,
    log,
  };
  if (!keep && result.ok) fs.rmSync(world.root, { recursive: true, force: true });
  else result.kept = world.root;
  return result;
}
