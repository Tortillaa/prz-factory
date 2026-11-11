---
name: factory-onboard
description: >-
  Set up prz-factory in a project, or repair a broken setup: install the skills and guard hooks,
  find and prove the verify commands, choose the merge policy and the agent of each lane, write the
  managed block in CLAUDE.md/AGENTS.md, and leave the board ready for a first card. Use whenever the
  factory has to be installed, configured or fixed in a repo, or `factory doctor` fails. Triggers:
  "instala la fábrica", "onboard", "configura prz-factory aquí", "set up prz-factory", "doctor falla".
---

# factory-onboard

Interactive, one step at a time, recommended answer first. It is safe to re-run: every step checks
before it changes anything, and nothing outside `.claude/`, `factory.config.json` and the managed
block is touched. Report one line per step: `✔ step · what happened`.

## 1 · Install

The factory needs nothing installed beforehand: one command fetches it from GitHub and copies it
into the project (Node 22+ and git are all it takes; GitHub access through `gh auth login` or the
user's git credentials, since the repo is private).

```text
npx -y github:Tortillaa/prz-factory install . --json
```

If the project already has `.prz-factory/`, use the copy it has instead (`node .prz-factory/bin/factory.mjs
install . --json` refreshes skills, hooks and config from it); run the `npx` line only to update
the factory to its latest version. From here on, `factory` means `node .prz-factory/bin/factory.mjs`
when it is not on PATH.

## 2 · Checks

```text
factory doctor --json
```

`node`, `git` and `git repo` must pass, or stop and say how to fix them. `orca` missing is fine for
setup (only `factory-run` needs it): say so.

## 3 · What install did

It copied the factory's own runtime into `.prz-factory/` (the CLI, the web board, the guard
hook and the skills: commit it, every worker worktree needs it), the skills and the guard hooks into `.claude/`, and wrote `factory.config.json` with a guess
for `baseBranch` and `verify` when it does not exist. A `skipped` skill means the user has their
own skill with that name: tell them, never overwrite it. Invalid `.claude/settings.json`: show the
error and ask them to fix it (or re-run with `--no-hooks` if they decline the hooks).

## 4 · Prove the build

The merge gate lands nothing without `verify`. Read `factory.config.json`, show the guessed
commands, and run them on the base branch:

```text
factory verify --json
```

- All pass: confirm them with the user.
- One fails or the list is empty: look at the project (`package.json` scripts, Makefile, CI files
  under `.github/workflows/`) and propose the commands the project's own CI runs. Edit
  `verify` only after the user agrees, and run `factory verify` again until it passes. A failure in
  the project's own code is a finding, not something to fix here: offer to file it with `factory-collect`.
- Slow suites: set `verifyTimeoutMinutes` to fit.

## 5 · Policy

Ask, with the defaults as the recommended answers:

1. `baseBranch` / `protectedBranches`: the branch work lands on (detected from HEAD).
2. `merge.maxLines` (default 400): bigger diffs wait for a person.
3. `merge.humanLabels` (default auth, payments, pricing, schema, ops, money, needs-human) and
   `merge.humanRisk` (default high): the business areas whose changes wait for the user.
4. `merge.humanPaths` (default none): globs of files that always need a person, whatever the card
   says (`src/billing/**`, `migrations/**`, `**/*.sql`, the deploy config). Ask the user where the
   money, the permissions, the schema and the deploy live in this repo, and list those paths.
5. `review.lenses` (default qa, security, code, ops): the experts of the review panel. Set
   `maxWorkers` to at least that many so a panel runs fully in parallel.
6. `maxWorkers` (default 2): parallel Orca workers. More workers, more machine and usage.
7. `agents` (default: every lane on Claude): which Orca agent, model and effort runs each lane,
   e.g. `"review": { "agent": "grok", "model": "grok-4.7", "effort": "high" }` to spare Claude's
   quota. A lane on Grok needs the Grok CLI installed and signed in (`grok`), and the project
   trusted by Grok once: `grok --trust inspect` in the main checkout. Trust covers every worktree
   of the repo; without it, Grok workers run without the rules, the skills and the guard hooks.
   `factory doctor` checks both.

Write the answers to `factory.config.json` and run `factory doctor` again: `config` must pass.

## 6 · Tell the agents

```text
factory agents-md --json
```

Writes the managed block (between `prz-factory:begin` / `prz-factory:end`) into `CLAUDE.md`, else
`AGENTS.md`, else a new `CLAUDE.md`. Re-run it after any config change.

## 7 · Commit and first card

Show `git status` and offer to commit `.prz-factory/`, `.claude/`, `factory.config.json` and the agents file
(`🔧 [chore] factory: set up prz-factory`): workers in new worktrees only get the skills and
guards if they are committed. Commit only when the user says yes.

Then offer the next step: write a first card with `factory-lint` (or `factory add` + the template),
open the board with `factory serve`, and drain it with `factory-run`.
