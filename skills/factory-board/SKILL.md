---
name: factory-board
description: >-
  Read and update the prz-factory kanban board through the `factory` CLI. Use when you create,
  pick up, edit, move, comment on, claim or release a card, when the user mentions "the board",
  "tablero", "tarjeta" or a card number like #12, or when you are a factory lane worker (build, qa, review).
---

# factory-board

The board is one JSON file shared by every worktree of the repo (`factory path` prints it).
Never edit that file by hand: always go through the `factory` CLI, which locks and writes atomically.
Pass `--json` and read the result; a failure prints `{"error": "..."}` and exits non-zero.
If `factory` is not on PATH, run `node <prz-factory>/bin/factory.mjs` instead.

## Columns and rules

`backlog → ready → building → qa → review → done`, plus `blocked` from any lane.

- New cards start in `backlog`. Only the user moves cards into `ready`.
- A card enters `ready` only if `factory lint <id>` has no errors.
- A card leaves `ready` for work only when every card in its `blockedBy` is `done`. `factory next` lists the cards you may start now, in priority order, with `next`: `building`, or `qa` for cards labelled `qa`.
- Workers move cards forward, or to `blocked` with a comment saying why. Never back to `backlog`, and never with `--force`: that flag is for the user.

## The card body is the contract

`factory template` prints the format: `## Problem`, `## Context`, `## Fix`, `## Acceptance Criteria`
(a `- [ ] …` checklist a test can verify), `## Risk` (starts with Low, Medium or High). Build exactly
what the Acceptance Criteria say. If they are ambiguous or wrong, comment and move the card to `blocked`; do not guess.

Write long bodies to a file and pass `--body-file`. Shell quoting breaks on multi-line text.

## Commands

```text
factory next --json                              # what may start now
factory show <id> --json                         # body, lint, unmet blockers, run fields, comments
factory add "<title>" --body-file f.md [--label feature] [--blocked-by 3,7] --json
factory edit <id> [--title t] [--body-file f.md] [--label l]... [--blocked-by ids] --json
factory edit <id> --branch <b> --worktree <path> --worker <name> [--reviewed-sha <sha>] --json
factory lint [id...] --json
factory claim <id> --as <worker-name> --json     # fails if someone else holds it
factory move <id> <column> --by <worker-name> --json
factory comment <id> "<text>" --role <build|qa|review> --json
factory release <id> --json
```

## Worker loop

1. `claim` the card. If the claim fails, stop: another worker has it.
2. Record where you work: `edit <id> --branch … --worktree … --worker …`.
3. Do the lane's work.
4. `comment` with what you did and the evidence (commands run, results, commit SHA).
5. `move` it to the next column (or `blocked`, with a comment saying why), then `release` it.
