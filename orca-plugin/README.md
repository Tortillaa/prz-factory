# prz-factory board (Orca plugin)

A right-sidebar panel that shows the prz-factory board of every repo open in Orca: one board per
repo (worktrees of the same repo share it), the cards per column, who holds each card, what waits
on blockers, and the cards that need a person. It updates live when a card moves, whether the CLI,
an agent or the web board moved it. "Web board" opens `factory serve` (`http://localhost:4747`).

- `src/worker.ts`: the plugin's worker. Lists Orca's workspaces (`workspace:read`), finds each repo's
  `<git common dir>/factory/board.json`, answers the panel's `boards.get`, and watches each board's
  folder to post `boards.changed`.
- `src/boards.ts`: discovery and reading, plain Node (mirrors `src/store.mjs#resolveBoardPath`).
- `src/panel.tsx`: the panel (components UI). `src/protocol.ts`: the panel ↔ worker contract.

It is read-only: moving cards stays with the CLI, the web board and the lanes, which enforce the
board's rules.

## Install

It runs its own Node worker (`trusted-worker`), so Orca asks you to approve it:

```sh
orca plugin inspect ./orca-plugin --json        # what it gets, and its fingerprint
orca plugin install ./orca-plugin --approve <fingerprint>
orca plugin open local.prz-factory-board --panel board
```

Without `--approve`, `install` stops and prints the fingerprint to approve.

## Develop

```sh
orca plugin test .                 # src/*.test.ts(x) with orca/testing
orca plugin check .                # renders the panel in each src/panel.check.ts scenario
orca plugin dev watch . --check    # load into Orca, reload on save
```

Type-check needs `typescript` and `@types/node` (the plugin has no dependencies): point
`typeRoots` at both `.orca/types` and your `@types` folder.
