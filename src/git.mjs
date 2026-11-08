// Thin git helpers. Every call takes an explicit cwd: lanes run in their own worktrees.
import { execFileSync } from 'node:child_process';

export function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')}: ${msg}`);
  }
}

export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export const toplevel = (cwd) => git(['rev-parse', '--show-toplevel'], cwd);
export const commonDir = (cwd) => git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
export const revParse = (ref, cwd) => tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);

// No tracked changes. Untracked files do not block a switch or a fast-forward unless they collide.
export const isClean = (cwd) => git(['status', '--porcelain', '--untracked-files=no'], cwd) === '';

export function isAncestor(ancestor, descendant, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// [{ path, head, branch }] for every worktree; the first one is the main checkout.
export function worktrees(cwd) {
  const list = [];
  let cur = null;
  for (const line of git(['worktree', 'list', '--porcelain'], cwd).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9), head: null, branch: null }));
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

// Lines added + deleted between two commits.
export function diffLines(from, to, cwd) {
  return git(['diff', '--numstat', `${from}...${to}`], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((sum, l) => {
      const [a, d] = l.split('\t');
      return sum + (Number(a) || 0) + (Number(d) || 0); // binary files show "-"
    }, 0);
}

export function samePath(a, b) {
  const norm = (p) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

export function slugify(text, max = 40) {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '') || 'card';
}
