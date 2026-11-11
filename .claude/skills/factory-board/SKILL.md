---
name: factory-board
description: >-
  Read and change the prz-factory kanban board (cards, columns, labels, comments, claims) through
  the `factory` CLI, never by editing board.json. Use whenever a task involves the board or a card:
  creating, showing, editing, moving, commenting on, claiming or releasing one, checking what is
  ready or in flight, or answering about a card number like #12. Triggers: "the board", "tablero",
  "tarjeta", "card", "mueve la tarjeta", "qué hay en el tablero", "estado de la #12".
---

# factory-board

The board is one JSON file shared by every worktree of the repo (`factory path` prints it).
Never edit that file by hand: always go through the `factory` CLI, which locks and writes atomically.
Pass `--json` and read the result; a failure prints `{"error": "..."}` and exits non-zero.
If `factory` is not on PATH, run `node <prz-factory>/bin/factory.mjs` instead.

## Columns and rules

`spec → ready → building → review → merge → done`, plus `backlog` (parked), `qa` (cards labelled `qa`)
and `blocked` (waiting for a person) from any lane.

- **`spec`** holds rough ideas in the user's words. The spec writer turns each into a full card and
  sends it to `ready` by itself. `backlog` is for cards nobody should work on yet: the factory never
  takes a card from there.
- A card enters `ready` only if `factory lint <id>` has no errors.
- A card leaves `ready` for work only when every card in its `blockedBy` is `done`. `factory next`
  lists the cards that may start now, in priority order, with `next`: `building`, or `qa` for cards labelled `qa`.
- **`review`** is a panel: one reviewer per lens (`review.lenses` in `factory.config.json`), in
  parallel, on the same commit. Every lens must pass it; one fail sends the card back to `building`.
  The verdict that completes the panel moves the card to `merge`.
- **`merge`** belongs to the merge agent: it decides who lands the card and runs the merge gate.
  A card reaches `done` only through the gate. It merges by itself when the change is small and
  safe, and waits for the user in `blocked` (labels `needs-you` + `merge-approval`) when it touches
  the business: high risk, a business label, a sensitive path, a big diff, or an escalation.
- Workers move cards forward, or to `blocked` with a comment saying why (the board adds
  `needs-you`). Never back to `backlog`, and never with `--force`: that flag is for the user.

## The card body is the contract

`factory template` prints the format: `## Problem`, `## Context`, `## Fix`, `## Acceptance Criteria`
(a `- [ ] …` checklist a test can verify), `## Risk` (starts with Low, Medium or High). Build exactly
what the Acceptance Criteria say. If they are ambiguous or wrong, comment and send the card to `blocked`; do not guess.

Labels route and classify: `bug` / `feature` (built), `qa` (tested on the base branch, nothing
built), and the business areas `auth`, `payments`, `pricing`, `schema`, `ops` (plus `needs-human`),
which make the merge wait for the user. Agents may add a business label; they never remove one.

Write long bodies to a file and pass `--body-file`. Shell quoting breaks on multi-line text.

## Commands

```text
factory next --json                              # what may start now
factory show <id> --json                         # body, lint, unmet blockers, run fields, panel, comments
factory add "<title>" --body-file idea.md --column spec --json          # a rough idea for the spec writer
factory add "<title>" --body-file f.md [--label feature] [--blocked-by 3,7] [--column ready] --json
factory edit <id> [--title t] [--body-file f.md] [--label l]... [--blocked-by ids] --json
factory lint [id...] --json
factory claim <id> --as <worker-name> [--lens <lens>] --json     # fails if someone else holds it
factory move <id> <column> --by <worker-name> --json
factory comment <id> "<text>" --role <spec|build|qa|review:<lens>> --json
factory release <id> [--lens <lens>] --json
factory status --json                            # in flight, review panels, approvals waiting for the user
```

## Lanes

Lane workers follow their own skill (`factory-spec`, `factory-build`, `factory-review`, `factory-merge`, `factory-qa`), which uses:

```text
factory start <id> --lane <spec|build|qa|review|merge> [--lens <lens>] --as <name> --json   # claim + checkout, in your own worktree
factory verify --json                                                       # the project's verify commands, here
factory handoff <id> <column> --lane <spec|build|qa|merge> --as <name> --text-file f --json   # comment + move + release
factory verdict <id> --lens <lens> --as <name> --sha <head> (--pass [--escalate why] | --fail [--to blocked]) --text-file f --json
factory merge <id> --sha <reviewed-head> [--human] --json                   # the merge gate (merge lane); --human is the user approving
```

| Lane | Works in | Ends with |
|---|---|---|
| spec | `spec` | `handoff` to `ready` (or `blocked` with questions) |
| build | `building` | `handoff` to `review` (or `blocked`) |
| review, one per lens | `review` | `verdict`; the one that completes the panel moves the card to `merge` |
| merge | `merge` | `merge` (the gate lands it or holds it for the user), or `handoff` to `blocked` |
| qa (`qa` cards only) | `qa` | `merge` (closes the card, nothing to merge) |

Comments and commits follow `references/writing-standard.md`. A card reaches `done` only through
the merge gate; no lane moves it there by hand.
