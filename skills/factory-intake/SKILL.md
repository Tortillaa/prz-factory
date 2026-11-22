---
name: factory-intake
description: >-
  Reception of prz-factory in the IDE agent: turn what the user asks for in the chat into cards on the
  board. For each request decide whether to park it in backlog or write it as a complete card, ask the
  user in the chat for any decision the code does not settle, lint it and create it in ready. Never
  builds or reviews. Use whenever the user asks for a change, a feature or a fix in the chat, or wants
  something noted on the board. Triggers: "quiero que", "añade al backlog", "apunta esto", "necesito
  que la web", "crea una tarjeta para", "I want", "add this to the board", "can you change".
---

# factory-intake

The user asks for changes in this chat; you are the front desk of the factory. You turn each request
into a card the builder can build without guessing, and you never build or review it yourself. Board
commands are in the `factory-board` skill; card format and writing rules in
`../factory-spec/SKILL.md` and `../factory-board/references/writing-standard.md`. Pass `--json` to
`factory` and stop on any error. The web board is never a background task of this session (it dies with
it): `factory dispatch` opens it in an Orca terminal titled "Tablero web", or run `orca terminal create
--worktree path:<main checkout> --title "Tablero web" --command "<cli> serve"`.

## 1 · Split the request

One card per outcome. For each one decide:

- **Park it** (vague, "someday", or the user says so): `factory add "<idea, in their words>" --column backlog --json`. No code reading, no questions.
- **Leave it as an idea** only if the user asks for the Spec Writer worker to write it: `--column spec`.
- **Write it** (the default when they want it done): continue below.

## 2 · Write the card

Follow `factory-spec` from step 2 ("Understand it in the code") to step 4 ("Classify the business
impact"), in this worktree and without claiming anything: read the code the request touches, cut the
scope with `ponytail`, load `unslop` and write the `Direction` when the card changes a screen, and
classify business labels and risk. Where `factory-spec` says "block", ask the user instead.

**Ask in the chat** the fewest questions that settle what the code does not, each with the options
you see and the one you recommend. Never invent a product, design, data or security decision, and
never lower a risk or drop a business label to make a card easier to merge. Write the answer into
the card's Context (`- **Decision (<date>):** …`).

## 3 · Create it

```text
factory add "<title>" --body-file <card.md> --label <bug|feature|qa> [--label <area>]... [--blocked-by ids] --column ready --json
factory lint <id> --json
```

Fix every lint error before telling the user. When the card touches the same files as one already in
`building`, `review` or `merge` (check `factory status --json`), chain it with `--blocked-by <id>`.
A request too big for one card becomes vertical slices, chained in order, as `factory-spec` step 5 says.

## 4 · Report and offer

Tell the user, in one short list: each card's number, title, risk and labels, and what you parked.
Then offer to start the factory (`factory-run`). Do not start it unasked.

## Never

- Write code, build, review, merge or move a card past `ready`.
- Create a card in `ready` that fails lint, or one with a decision you made up.
- Use `--force`, or edit a card you did not create.
