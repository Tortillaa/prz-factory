---
name: factory-onboard
description: >-
  Set up prz-factory in a project, or repair a setup: install skills and guard hooks, find and
  prove the verify commands, choose the merge policy, write the managed block in CLAUDE.md/AGENTS.md,
  and leave the board ready for a first card. Use when the user says "onboard", "instala la fábrica",
  "set up prz-factory here", or `factory doctor` fails in a project.
---

# factory-onboard

Interactive, one step at a time, recommended answer first. It is safe to re-run: every step checks
before it changes anything, and nothing outside `.claude/`, `factory.config.json` and the managed
block is touched. Report one line per step: `✔ step · what happened`.

## 1 · Checks

```text
factory doctor --json
```

`node`, `git` and `git repo` must pass, or stop and say how to fix them. `orca` missing is fine for
setup (only `factory-run` needs it): say so. `factory on PATH` missing: offer `npm link` in the
prz-factory checkout.

## 2 · Install

```text
factory install . --json
```

Copies the skills and the guard hooks into `.claude/` and writes `factory.config.json` with a guess
for `baseBranch` and `verify` when it does not exist. A `skipped` skill means the user has their
own skill with that name: tell them, never overwrite it. Invalid `.claude/settings.json`: show the
error and ask them to fix it (or re-run with `--no-hooks` if they decline the hooks).

## 3 · Prove the build

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

## 4 · Policy

Ask, with the defaults as the recommended answers:

1. `baseBranch` / `protectedBranches`: the branch work lands on (detected from HEAD).
2. `merge.maxLines` (default 400): bigger diffs wait for a person.
3. `merge.humanLabels` (default auth, money, schema, needs-human) and `merge.humanRisk` (default high).
4. `maxWorkers` (default 2): parallel Orca workers. More workers, more machine and usage.

Write the answers to `factory.config.json` and run `factory doctor` again: `config` must pass.

## 5 · Tell the agents

```text
factory agents-md --json
```

Writes the managed block (between `prz-factory:begin` / `prz-factory:end`) into `CLAUDE.md`, else
`AGENTS.md`, else a new `CLAUDE.md`. Re-run it after any config change.

## 6 · Commit and first card

Show `git status` and offer to commit `.claude/`, `factory.config.json` and the agents file
(`🔧 [chore] factory: set up prz-factory`): workers in new worktrees only get the skills and
guards if they are committed. Commit only when the user says yes.

Then offer the next step: write a first card with `factory-lint` (or `factory add` + the template),
open the board with `factory serve`, and drain it with `factory-run`.
