// Optional GitHub mirror. Merges stay local (the gate fast-forwards the base); GitHub only shows
// the work: `factory pr` pushes a card's branch and opens or updates its PR, and with
// github.pushBase the gate pushes the base after landing, which GitHub reads as the PR merged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { git, revParse } from './git.mjs';

// The gh command; FACTORY_GH overrides it (tests use a fake).
function gh(args, cwd) {
  const cmd = [process.env.FACTORY_GH || 'gh', ...args.map((a) => JSON.stringify(a))].join(' ');
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function prBody(card) {
  const last = card.comments.filter((c) => ['build', 'qa', 'review'].includes(c.role)).at(-1);
  return `${card.body.trim()}\n\n---\nCard #${card.id} on the prz-factory board · column: ${card.column}${last ? `\n\n<details><summary>Last lane comment (${last.role})</summary>\n\n${last.text}\n\n</details>` : ''}\n`;
}

// Pushes the card's branch and creates its PR, or updates the body of the existing one. Returns { url, created }.
export function openPr({ card, cwd, config }) {
  const branch = card.run.branch;
  if (!branch) throw new Error(`card #${card.id} has no branch yet`);
  if (!revParse(`refs/heads/${branch}`, cwd)) throw new Error(`branch ${branch} does not exist`);
  const remote = config.github.remote;
  git(['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], cwd);

  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pr-')), 'body.md');
  fs.writeFileSync(bodyFile, prBody(card));
  try {
    let url = null;
    try {
      url = JSON.parse(gh(['pr', 'view', branch, '--json', 'url'], cwd)).url;
    } catch {
      // no PR for this branch yet
    }
    if (url) {
      gh(['pr', 'edit', branch, '--body-file', bodyFile], cwd);
      return { url, created: false };
    }
    const out = gh(['pr', 'create', '--base', config.baseBranch, '--head', branch, '--title', card.title, '--body-file', bodyFile, ...(config.github.draft ? ['--draft'] : [])], cwd);
    return { url: out.split(/\r?\n/).filter(Boolean).at(-1), created: true };
  } finally {
    fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
  }
}

// After a local merge: fast-forward the remote base. A rejected push is reported, never forced.
export function pushBase({ cwd, config }) {
  try {
    git(['push', config.github.remote, `refs/heads/${config.baseBranch}:refs/heads/${config.baseBranch}`], cwd);
    return { pushed: true };
  } catch (err) {
    return { pushed: false, error: err.message.split('\n').slice(0, 3).join(' ') };
  }
}
