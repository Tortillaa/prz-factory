---
name: factory-qa
description: >-
  QA lane of prz-factory for `qa`-labelled cards: test what is already on the base branch against
  the card's Acceptance Criteria, file what you find as new cards, and close the card through the
  merge gate. Nothing is built. (Built cards are tested by the `qa` reviewer of the review panel:
  see `factory-review`.) Use when told to QA card #N, when dispatched as a factory qa worker, or
  when the user says "factory-qa".
---

# factory-qa

A `qa` card asks a question about the product as it is: "does checkout still work with an empty
cart?". You answer it with evidence. There is no branch and no diff; whatever is broken becomes a
new card for the pipeline. Board commands are in `factory-board`; formats in
`../factory-board/references/writing-standard.md`.

## 1 · Start

```text
factory start <id> --lane qa --as <your-worker-name> --json
factory show <id> --json
```

Your worktree is now on the base branch, detached. You never commit.

## 2 · Check

1. **Verify.** `factory verify --json`. A failure is itself a finding.
2. **AC ledger.** For every Acceptance Criterion, find the test that asserts it (`file:line`), or
   run the app or the flow and keep the output. One line per AC: ✅ with the evidence, or ❌ with
   the exact input and what happened.
3. **Edge cases** the card implies: boundaries, empty and very long input, 0 / 1 / many items,
   error paths.

## 3 · File what you found

Each real problem becomes its own card, as a rough idea for the spec writer (title plus what you
saw and how to reproduce it):

```text
factory add "<what is broken>" --body-file <finding.md> --column spec --json
```

## 4 · Close

Comment per writing standard §2 (role `qa`: the AC ledger, the cards you filed, `Head: <sha>`)
with `factory comment <id> --role qa --text-file <comment.md>`, then close the card through the gate:

```text
factory merge <id> --as <your-worker-name> --json
```

A `qa` card has no code, so the gate closes it without a merge. If you could not test it at all
(a service or credential is missing, the criteria cannot be checked), hand it to a person instead:

```text
factory handoff <id> blocked --lane qa --as <name> --text-file <comment.md> --json
```

## Never

- Change code, or fix what you found. Findings are cards.
- Close a card whose Acceptance Criteria you could not check. "Unverified" goes to blocked.
