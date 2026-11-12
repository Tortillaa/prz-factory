#!/usr/bin/env node
// factory-managed: prz-factory git pre-push check. `factory install` copies it next to the repo's sh `pre-push`
// wrapper (shared by every worktree). Self-contained on purpose: no imports from src/.
// Git runs it after resolving the push, so no way of typing the command gets around it.
// Denies by default any push to a protected branch that is not a fast-forward (or a new branch).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZERO = /^0+$/;

// lines: `<local ref> <local sha> <remote ref> <remote sha>`. Returns the refusals (empty = allowed).
export function checkPush(lines, { protectedBranches, isAncestor }) {
  const out = [];
  for (const line of lines) {
    const [, local, remoteRef, remote] = line.trim().split(/\s+/);
    const name = remoteRef?.replace(/^refs\/heads\//, '');
    if (!remoteRef?.startsWith('refs/heads/') || !protectedBranches.includes(name)) continue;
    if (ZERO.test(local)) out.push(`deleting protected branch ${name}`);
    else if (!ZERO.test(remote) && !isAncestor(remote, local)) out.push(`${name} would not be a fast-forward`);
  }
  return out;
}

function protectedFromConfig() {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'factory.config.json'), 'utf8'));
    if (Array.isArray(cfg.protectedBranches) && cfg.protectedBranches.length) return cfg.protectedBranches;
    if (cfg.baseBranch) return [cfg.baseBranch];
  } catch {}
  return ['main', 'master'];
}

const isAncestor = (a, b) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // not an ancestor, or the object is unknown here: refuse either way
  }
};

// The sh wrapper sets FACTORY_PRE_PUSH so a path-spelling mismatch (drive case, symlink) cannot make the check a no-op.
if (process.env.FACTORY_PRE_PUSH || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const lines = fs.readFileSync(0, 'utf8').split('\n').filter((l) => l.trim());
  const refused = checkPush(lines, { protectedBranches: protectedFromConfig(), isAncestor });
  if (refused.length) {
    console.error(`prz-factory pre-push: refused: ${refused.join('; ')}. Protected branches only move forward; land code with \`factory merge\`.`);
    process.exit(1);
  }
}
