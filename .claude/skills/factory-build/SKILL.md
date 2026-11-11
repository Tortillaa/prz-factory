---
name: factory-build
description: >-
  Builder lane of prz-factory: take one card from Ready (or one sent back to Building), make the
  smallest safe change that meets its Acceptance Criteria test-first, commit on the card's branch
  and hand it to the review panel. Never merges. Use when told to build card #N, when dispatched as a factory
  build worker, or when the user says "factory-build" / "construye la tarjeta".
---

# factory-build

You build exactly one card, in your own worktree, and hand it to the review panel. Board commands are in the
`factory-board` skill; commit and comment shapes in `../factory-board/references/writing-standard.md`.
Pass `--json` to `factory` and stop on any error.

## 1 · Start

```text
factory start <id> --lane build --as <your-worker-name> --json
```

This claims the card, moves it Ready → Building and switches this worktree to the card's branch
(`factory/<id>-<slug>`, created from the base branch the first time). If it fails, report the error
and stop: another worker has the card, the worktree is dirty, or the card is not yours to build.

Then read the card: `factory show <id> --json`. Read every comment too: a card that came back
from the review panel or the merge gate says exactly what to fix (findings `Q1`, `S1`, `C1`, `O1`…, a failing
verify, or a rebase).

## 2 · Build

**Load the `ponytail` skill before you write a line** (if it is not installed, read
`../ponytail/SKILL.md`) and keep it on, at level `full`, for the whole card. Before each piece of
code, walk its ladder and take the first rung that fully works: does this need to exist → is it
already in this codebase → standard library or platform → an installed dependency → one clear
line → the minimum code that works. Where this skill and ponytail differ, this skill wins: the
card's Acceptance Criteria and the tests that prove them are what the task asks for, and ponytail
never cuts what the task asks for.

1. **Rebase first if the card came back for it**: `git rebase <base>` (base from `factory.config.json`).
   Resolve conflicts within the card's scope; if that needs a product decision, block (step 4).
2. **Test first.** For each Acceptance Criterion, write the test that asserts it, run it, see it
   fail for the right reason, then write the code that makes it pass. One AC at a time.
3. **Smallest complete change** (ponytail's ladder). Reuse what the codebase already has before
   adding a dependency, abstraction, config option or file. Build what the ACs need, nothing more:
   no "for later" code, no drive-by refactors. Lazy about the solution, never about the change:
   finish every caller, test and fixture your change touches. A shortcut with a known limit gets
   the comment `shortcut: <the limit>, <when to upgrade>`.
4. **Third-party APIs, upgrades, auth, payments:** read the official docs for the version in use
   before writing code. Do not code from memory.
5. **Follow the repo's own rules** in `CLAUDE.md` / `AGENTS.md`.
6. Commit as you go, in the commit format, with `Card: #<id>` in each body.

### When a part needs more capacity: an Opus subagent

You run on a mid-size model (the project's `agents.build` in `factory.config.json`). Most cards fit
it. Call in a **Claude Opus 5.5 subagent** for one bounded part, only when one of these is true:

- **Hard reasoning:** concurrency, locking or ordering of writes; a security-sensitive check
  (auth, permissions, input that crosses a trust boundary); money or date/time arithmetic; a parser.
- **A bug you cannot explain** after reproducing it and two honest attempts at the root cause.
- **A change across several modules** whose design you are not sure of: the subagent proposes it,
  you build it.
- **The card came back** from the panel or the gate with a Blocker you could not fix the first time.

Not for routine work: a clear AC, a small fix, a test you know how to write. Opus costs several
times more; if you are unsure, try it yourself first.

How: start a subagent with your agent's subagent tool (in Claude Code, the Agent tool with
`model: "opus"`), working in this same worktree. Give it a self-contained brief: the card id and
its Acceptance Criteria, the exact files and functions, what you tried and what failed, and the
one deliverable you want back (a diagnosis, a design, or the change with its test). It must not
run `factory` commands, commit, or touch other cards: you stay the builder. Check what it returns
as you would a colleague's work (read the diff, run the tests), commit it under your name, and say
it in your handoff comment: `Opus: <the part and why>`.

If your agent has no subagent tool, hand the card to `blocked` with the part you could not solve
and why, instead of guessing.

## 3 · Prove it

```text
factory verify --json
```

It runs every `verify` command from `factory.config.json` in this worktree. All must pass before
you hand off. Also run the tests you added on their own and keep their output for the comment.
Leave the worktree clean (`git status` shows nothing to commit).

## 4 · Hand off

Write the comment to a file (writing standard §2: one line per AC with the test that proves it,
the verify result, `Head: <sha>`). Add ponytail's closing line as `Skipped:` — what you chose not
to build or could not check, every `shortcut:` you left, and any risk the reviewers must know
(`Skipped: nothing` when there is none). Then:

```text
factory handoff <id> review --lane build --as <your-worker-name> --text-file <comment.md> --json
```

**Block instead** when you cannot meet the ACs without guessing: the ACs contradict the code or
each other, a product/design/security decision is missing, or a credential or service you need is
absent. Commit any useful partial work as `🚧 [wip]`, then hand off to `blocked` with a 🛑 comment
saying exactly what decision or input unblocks it.

## Never

- Merge, push to the base branch, or move a card to Done. Only `factory merge` lands code.
- Use `--force` on `factory move`, edit the card's Acceptance Criteria to fit your code, or skip
  a failing test to get green.
- Work on a second card in the same run.
