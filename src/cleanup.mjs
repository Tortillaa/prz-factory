// Cleans up what finished cards leave behind: their worktrees, their branches (the factory's
// `factory/<id>-<slug>` and Orca's `<user>/factory-<id>`), and temporary verify worktrees.
// Only things the factory created, only when fully merged and clean, never for an active card.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { git, tryGit, worktrees, isAncestor, commonDir, samePath, revParse } from './git.mjs';

const ACTIVE = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'blocked'];
// factory-<id> for the card, factory-<id>-<lens> for each reviewer of its panel.
const FACTORY_WT = /^factory-(\d+)(?:-[a-z]+)?$/;
const FACTORY_BRANCH = /^factory\/(\d+)-|^[^/]+\/factory-(\d+)(?:-[a-z]+)?$/;

function cardIdOf(name, re) {
  const m = name.match(re);
  return m ? Number(m[1] ?? m[2]) : null;
}

// Nothing at all in `git status`, untracked files included: removing it loses nothing.
function pristine(dir) {
  return tryGit(['status', '--porcelain'], dir) === '';
}

export function findLeftovers({ cwd, board, config }) {
  const base = config.baseBranch;
  const trees = worktrees(cwd);
  const main = trees[0].path;
  const active = new Set(board.cards.filter((c) => ACTIVE.includes(c.column)).map((c) => c.id));
  const activeTrees = board.cards
    .filter((c) => ACTIVE.includes(c.column))
    .flatMap((c) => [c.run.worktree, ...Object.values(c.panel?.lenses || {}).map((s) => s.worktree)])
    .filter(Boolean);
  const here = tryGit(['rev-parse', '--show-toplevel'], cwd);

  const worktreesOut = [];
  for (const w of trees.slice(1)) {
    const id = cardIdOf(path.basename(w.path), FACTORY_WT);
    if (id == null || active.has(id) || activeTrees.some((t) => samePath(t, w.path))) continue;
    if (here && samePath(here, w.path)) continue;
    if (!fs.existsSync(w.path)) {
      worktreesOut.push({ path: w.path, card: id, reason: 'missing on disk' });
      continue;
    }
    if (!pristine(w.path) || !w.head || !isAncestor(w.head, `refs/heads/${base}`, main)) continue;
    worktreesOut.push({ path: w.path, card: id, reason: `merged into ${base}` });
  }

  const checkedOut = new Set(trees.filter((w) => w.branch).map((w) => w.branch));
  const branchesOut = [];
  for (const name of (tryGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], main) || '').split(/\r?\n/).filter(Boolean)) {
    const id = cardIdOf(name, FACTORY_BRANCH);
    if (id == null || active.has(id) || name === base) continue;
    const leaving = worktreesOut.find((w) => w.card === id);
    if (checkedOut.has(name) && !leaving) continue;
    if (!isAncestor(`refs/heads/${name}`, `refs/heads/${base}`, main)) continue;
    branchesOut.push({ branch: name, card: id, sha: revParse(`refs/heads/${name}`, main) });
  }

  const tmpRoot = path.join(commonDir(cwd), 'factory');
  // A merge in progress owns its verify worktree: leave temp folders alone until it ends.
  const merging = fs.existsSync(path.join(tmpRoot, 'merge.lock'));
  const tempOut = fs.existsSync(tmpRoot) && !merging
    ? fs.readdirSync(tmpRoot).filter((n) => n.startsWith('verify-')).map((n) => path.join(tmpRoot, n))
    : [];

  return { worktrees: worktreesOut, branches: branchesOut, temp: tempOut };
}

// Through the shell so the Windows .cmd shim resolves; every argument is quoted.
const orca = (...args) => execSync([process.env.ORCA_CLI_COMMAND || 'orca', ...args].map((a) => JSON.stringify(a)).join(' '), { stdio: 'ignore' });

function orcaAvailable() {
  try {
    orca('--help');
    return true;
  } catch {
    return false;
  }
}

// Removes what findLeftovers found. Worktrees go through Orca when it is there, so its UI drops them.
export function applyCleanup(leftovers, { cwd, useOrca = orcaAvailable() }) {
  const main = worktrees(cwd)[0].path;
  const done = { worktrees: [], branches: [], temp: [], errors: [] };
  for (const w of leftovers.worktrees) {
    try {
      if (useOrca && fs.existsSync(w.path)) {
        orca('worktree', 'rm', '--worktree', `path:${w.path}`, '--json');
      } else if (fs.existsSync(w.path)) {
        git(['worktree', 'remove', w.path], main);
      }
      done.worktrees.push(w.path);
    } catch (err) {
      done.errors.push(`${w.path}: ${err.message.split('\n')[0]}`);
    }
  }
  tryGit(['worktree', 'prune'], main);
  for (const b of leftovers.branches) {
    // Re-check: Orca may have deleted it with the worktree, or it may have moved since.
    const sha = revParse(`refs/heads/${b.branch}`, main);
    if (!sha) continue;
    if (sha !== b.sha) {
      done.errors.push(`${b.branch}: moved since it was checked`);
      continue;
    }
    try {
      git(['branch', '-D', b.branch], main); // merged: verified by findLeftovers
      done.branches.push(b.branch);
    } catch (err) {
      done.errors.push(`${b.branch}: ${err.message.split('\n')[0]}`);
    }
  }
  for (const t of leftovers.temp) {
    fs.rmSync(t, { recursive: true, force: true });
    done.temp.push(t);
  }
  tryGit(['worktree', 'prune'], main);
  return done;
}
