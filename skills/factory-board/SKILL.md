---
name: factory-board
description: >-
  Read and update the prz-factory kanban board through the `factory` CLI. Use when you pick up,
  move, comment on, claim or release a card, when the user mentions "the board", "tablero",
  "tarjeta" or a card number like #12, or when you are a factory lane worker (build, qa, review).
---

# factory-board

The board is one JSON file shared by every worktree of the repo (`factory path` prints it).
Never edit that file by hand: always go through the CLI, which locks and writes atomically.

Run the CLI as `node <repo>/bin/factory.mjs` (or `factory` if it is linked). Pass `--json` and
read the result; a failure prints `{"error": "..."}` and exits non-zero.

## Columns

`backlog → ready → building → qa → review → done`, plus `blocked` from any lane.
Only the user moves cards into `ready`. Workers move cards forward, or to `blocked`, never back to `backlog`.

## Commands

```text
factory list [--column ready] --json
factory show <id> --json
factory claim <id> --as <worker-name> --json   # before you start; fails if someone else holds it
factory move <id> <column> --by <worker-name> --json
factory comment <id> "<text>" --role <build|qa|review> --json
factory release <id> --json                    # when you hand the card to the next lane
```

## Worker loop

1. `claim` the card. If the claim fails, stop: another worker has it.
2. Do the lane's work.
3. `comment` with what you did and the evidence (commands run, results, PR link).
4. `move` it to the next column (or `blocked`, with a comment saying why), then `release` it.
