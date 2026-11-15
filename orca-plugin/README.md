# prz-factory board (Orca plugin)

A right-sidebar panel that shows the prz-factory board of every repo open in Orca: one board per
repo (worktrees of the same repo share it), the cards per column, who holds each card, what waits
on blockers, and the cards that need a person. It updates live when a card moves, whether the CLI,
an agent or the web board moved it. "Web board" opens the `factory serve` of that repo, on the port it listens on (it appears only while `factory serve` runs).

- `src/worker.ts`: the plugin's worker. Lists Orca's workspaces (`workspace:read`), finds each repo's
  `<git common dir>/factory/board.json`, answers the panel's `boards.get`, and watches each board's
  folder to post `boards.changed`. It also feeds the `waiting` status bar item ("1 te espera", "N te esperan": cards in
  `blocked`); that item keeps the worker alive, since Orca stops an idle worker and its watchers with it.
- `src/boards.ts`: discovery and reading, plain Node (mirrors `src/store.mjs#resolveBoardPath`).
- `src/panel.tsx`: the panel (components UI). `src/protocol.ts`: the panel ↔ worker contract. The card sheet reads, comments, moves (a refused move offers Forzar), edits title and body, and approves a held merge after a confirmation; each button is off while its request runs, and a late `card.get` for another card is dropped.

It never writes `board.json`. Besides `boards.get`, the worker answers six card requests, each carrying
the board's `key` (`BoardView.key`) and running that repo's CLI with `--json` (`src/actions.ts`:
`<repo>/.prz-factory/bin/factory.mjs`, else `<repo>/bin/factory.mjs`; no shell, `FACTORY_BOARD` set), so lint,
blockers and the merge gate stay in the CLI. Free text (id, column, title, text) goes after `--` and option values as `--flag=value`, so text such as `- item` or `--force` is never read as an option. `card.edit` with `labels: []` is an error (the CLI cannot clear all labels). It replies with the CLI's JSON, or its `error` unchanged:

| Request | CLI |
|---|---|
| `card.get` `{ id }` | `show <id>` |
| `card.add` `{ title, body?, labels?, blockedBy?, column? }` | `add <title> [--body] [--label]… [--blocked-by] [--column]` |
| `card.edit` `{ id, title?, body?, labels?, blockedBy? }` | `edit <id> …` |
| `card.move` `{ id, column, before?, force? }` | `move <id> <column> [--before] --by user [--force]` |
| `card.comment` `{ id, text }` | `comment <id> <text> --role user` |
| `card.approve` `{ id, sha }` | `merge <id> --human --as user --sha <sha>`, only if the card has `merge-approval` and `run.branch` |

Spawning the CLI needs no extra capability: the `trusted-worker` profile already runs Node code, and Orca asks for that approval at install.

## Install

Once per machine. `factory install` copies this folder into every project as
`.prz-factory/orca-plugin`, so no clone of prz-factory is needed (from a clone, the folder is
`./orca-plugin`). It runs its own Node worker (`trusted-worker`), so Orca asks you to approve it:

```sh
orca plugin install .prz-factory/orca-plugin                        # installs nothing: shows the access and a fingerprint
orca plugin install .prz-factory/orca-plugin --approve ap1-<fingerprint>
orca plugin open local.prz-factory-board --panel board
```

The fingerprint is bound to these exact files and this access: after an update that changes the
plugin, Orca asks again.

## Develop

```sh
orca plugin test .                 # src/*.test.ts(x) with orca/testing
orca plugin check .                # renders the panel in each src/panel.check.ts scenario
orca plugin dev watch . --check    # load into Orca, reload on save
```

Type-check needs `typescript` and `@types/node` (the plugin has no dependencies): point
`typeRoots` at both `.orca/types` and your `@types` folder.
