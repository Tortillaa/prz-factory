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
Pipeline: spec (an idea) → ready → building → review (a panel, one reviewer per lens) → merge → done.
Also backlog (parked), qa (\`qa\` cards) and blocked (waiting for a person). \`factory serve\` shows it.

| When | Use | Never |
|---|---|---|
| Ask for a change | an idea in the \`spec\` column (\`factory add "<idea>" --column spec\`) | Move a card to ready with lint errors |
| Write a card yourself | \`factory-lint\` skill · \`factory lint\` | Invent a product decision |
| Drain the board | \`factory-run\` skill | Write specs, build, review or merge from the coordinator |
| Spec / build / review / merge one card | \`factory-spec\` · \`factory-build\` · \`factory-review\` (one lens) · \`factory-merge\` | Work outside your own worktree |
| Land a card | \`factory verdict\` (the panel) → \`factory-merge\` (the merge agent) → \`factory merge\` (the gate) | \`git merge\` or push to ${config.baseBranch} by hand |
| Turn problems into cards | \`factory-collect\` skill | File a card without verifying the problem |

| Rule | Value |
|---|---|
| CLI | \`factory\`, or \`node .prz-factory/bin/factory.mjs\` (the factory lives in this repo: nothing to install) |
| Base branch | \`${config.baseBranch}\` (protected: ${config.protectedBranches.join(', ')}) |
| Proof of build | ${config.verify.length ? config.verify.map((v) => `\`${v}\``).join(', ') : '**not set: add `verify` to factory.config.json**'} |
| Review panel | ${config.review.lenses.join(' · ')}${config.review.light?.length ? ` (Low risk with no business label: ${config.review.light.filter((l) => config.review.lenses.includes(l)).join(' · ')})` : ''}: every lens must pass the same commit |
| Merge by a person | risk ${config.merge.humanRisk.join('/')} · labels ${config.merge.humanLabels.join(', ')}${config.merge.humanPaths.length ? ` · paths ${config.merge.humanPaths.map((p) => `\`${p}\``).join(', ')}` : ''} · diff > ${config.merge.maxLines} lines |
| Business labels | agents may add one (or \`needs-human\`), never remove one |
| Craft | every step loads \`ponytail\` (spec, build) or \`ponytail-review\` (reviewers): the smallest change that fully works, and no code that should not exist |
| Writing | commits and comments: \`.claude/skills/factory-board/references/writing-standard.md\` |
| Agents | ${Object.keys(config.agents || {}).length ? Object.entries(config.agents).map(([lane, a]) => `${lane} on ${a.agent}${a.model ? ` ${a.model}` : ''}${a.effort ? ` (${a.effort})` : ''}`).join(' · ') + ' · other lanes on claude' : 'every lane on claude'}; Claude Code and Grok read the same \`.claude/\` skills, this file and the guard hooks |
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
