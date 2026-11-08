// Keeps a short, managed "how this project uses prz-factory" block in the file agents read
// (CLAUDE.md for Claude Code, AGENTS.md for others). Only the text between the markers is ours.
import fs from 'node:fs';
import path from 'node:path';

export const BEGIN = '<!-- prz-factory:begin (managed by `factory agents-md`; edits inside are overwritten) -->';
export const END = '<!-- prz-factory:end -->';

export function block(config) {
  return `${BEGIN}
## prz-factory

This project is worked by prz-factory: cards on a local board, one Orca worker per card and lane.
Board: backlog · ready · building · qa · review · blocked · done (\`factory serve\` shows it).

| When | Use | Never |
|---|---|---|
| Write or check a card | \`factory-lint\` skill · \`factory lint\` | Move a card to ready with lint errors |
| Drain the board | \`factory-run\` skill | Build, test or merge from the coordinator |
| Build / QA / review one card | \`factory-build\` · \`factory-qa\` · \`factory-review\` | Work outside the card's worktree |
| Land a card | \`factory merge\` (review lane) | \`git merge\` or push to ${config.baseBranch} by hand |
| Turn problems into cards | \`factory-collect\` skill | File a card without verifying the problem |

| Rule | Value |
|---|---|
| Base branch | \`${config.baseBranch}\` (protected: ${config.protectedBranches.join(', ')}) |
| Proof of build | ${config.verify.length ? config.verify.map((v) => `\`${v}\``).join(', ') : '**not set: add `verify` to factory.config.json**'} |
| Merge by a person | risk ${config.merge.humanRisk.join('/')} · labels ${config.merge.humanLabels.join(', ')} · diff > ${config.merge.maxLines} lines |
| Writing | commits and comments: \`.claude/skills/factory-board/references/writing-standard.md\` |
| Secrets | never read \`.env\` or key files; never write a key literal (guard hooks block both) |
${END}`;
}

// Picks CLAUDE.md, else AGENTS.md, else creates CLAUDE.md.
export function targetFile(root) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) if (fs.existsSync(path.join(root, name))) return path.join(root, name);
  return path.join(root, 'CLAUDE.md');
}

export function writeBlock(root, config, file = targetFile(root)) {
  const text = block(config);
  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, 'utf8') : '';
  const start = current.indexOf('<!-- prz-factory:begin');
  const end = current.indexOf(END);
  let next;
  if (start !== -1 && end > start) next = current.slice(0, start) + text + current.slice(end + END.length);
  else if (start !== -1) throw new Error(`${file} has a prz-factory begin marker without an end marker; fix it by hand`);
  else next = current ? `${current.replace(/\s*$/, '')}\n\n${text}\n` : `${text}\n`;
  if (next === current) return { file, status: 'unchanged' };
  fs.writeFileSync(file, next);
  return { file, status: exists ? 'updated' : 'created' };
}
