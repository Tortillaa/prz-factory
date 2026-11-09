---
name: factory-review
description: >-
  Reviewer lane of prz-factory: one expert of a parallel review panel (lenses qa, security, code,
  ops). Review a built card's diff through your lens only, record a verdict with `factory verdict`,
  and let the merge gate land the card when the whole panel has passed it. Use when told to review
  card #N, when dispatched as a factory review worker, or when the user says "factory-review".
---

# factory-review

A built card is reviewed by a panel: one reviewer per lens, all at the same time, each in its own
worktree, all on the same commit. You are one of them. The card lands only when **every** lens
passes that commit; one fail sends it back to the builder and ends the round for everyone.

Your lens is in your task (`--lens <qa|security|code|ops>`). Read its section in
[references/lenses.md](references/lenses.md) and review through it only: the other reviewers
cover the rest, and a finding outside your lens is theirs to make. Board commands are in
`factory-board`; formats in `../factory-board/references/writing-standard.md` (§3 for findings).

## 1 · Start

```text
factory start <id> --lane review --lens <lens> --as <your-worker-name> --json
factory show <id> --json
```

Your worktree is now on the branch head, detached. Note `head` in the result: it is the commit the
panel reviews and the only one your verdict may name. You never commit.

The diff under review: `git diff <base>...HEAD` (`base` is in the result).

## 2 · Your own pass first

**Load the `ponytail-review` skill before you read the diff** (if it is not installed, read
`../ponytail-review/SKILL.md`). Review like the senior developer who will be paged when this
breaks. Take from it:

- **How to read:** the diff, then the code it touches (callers of every changed function, what
  it calls, the tests), and the real flow of the data. A change can break code it does not touch.
- **What to look for:** the categories your lens owns (your section of `references/lenses.md`
  names them: bug, risk, scale, missing test, speed, lean).
- **When a finding counts:** only with a concrete case, "this input or situation leads to this
  wrong result", confirmed on the lines. No case, no finding. No style taste, no "consider".
- **What a fix looks like:** the smallest one that works, preferring fixes that delete code. A
  `shortcut:` comment that names its limit is a decision, not a finding, unless the expected load
  already crosses it.

It does not change how you report: findings go in this skill's table, and you end with
`factory verdict`, not with ponytail-review's "Verdict:" line.

Before reading the builder's comment or earlier reviews, read the card's Acceptance Criteria and
the raw diff, and write down 2-4 hypotheses for your lens: what must be true for this to be right,
and where it would most likely break. Check each against the code and the tests, following your
lens's checklist. Only then read the comments: each claim there is a lead, not evidence.

**Remember earlier rounds.** If an earlier comment of your lens (`review:<lens>`) has a findings
table, re-check every open finding first and mark it ✅ fixed (with the proof) or keep it ❌ open.
Keep the IDs.

Classify each finding (Gap · Bug · Verification miss · Scope drift · Over-engineering) with a
severity (Blocker · Should fix · Nit). You judge the diff, reading whatever code it touches. Report
only what you can point to on a line and explain. Code that could be shorter never blocks alone;
code that should not exist at all does, in the `code` lens.

## 3 · Verdict

Write the comment to a file (writing standard §2, role `review:<lens>`, your findings table,
`Head: <sha>`), then exactly one:

```text
# No open Blocker in your lens:
factory verdict <id> --lens <lens> --as <name> --sha <head> --pass --text-file <comment.md> --json

# Pass, but a person must approve the merge (see "Escalate"):
factory verdict <id> --lens <lens> --as <name> --sha <head> --pass --escalate "<why>" --text-file <comment.md> --json

# Any open Blocker: back to the builder, with the findings table
factory verdict <id> --lens <lens> --as <name> --sha <head> --fail --text-file <comment.md> --json

# It needs a product or design decision only the user can make
factory verdict <id> --lens <lens> --as <name> --sha <head> --fail --to blocked --text-file <comment.md> --json
```

**Escalate** when the change touches the business or what keeps the product running (auth,
payments, pricing, schema, operations) and the card does not already say so, or when a mistake
here would be costly and hard to undo. It adds `needs-human`: the gate will ask the user instead
of merging. You may raise that bar; you may never lower it.

Read the result:

- `complete: false` → other lenses are still reviewing. You are done.
- `merge` present → your verdict completed the panel and the merge gate ran:

| Exit | `merge.status` | What happened |
|---|---|---|
| 0 | merged | The card is Done. Report the merged SHA. |
| 7 | needs-human | The gate moved it to blocked with `needs-you` + `merge-approval`: the user approves it on the board. Report the reasons. |
| 8 | behind | The branch is behind the base: back to building for a rebase. |
| 9 | verify-failed | Verify failed on that commit: back to building with the output. |
| 10 | base-dirty | The base checkout has uncommitted changes. The card stays in review, fully passed. Tell the user; do not touch their checkout. |
| 6 · 1 | head-moved · error | Report the message. |

- An error saying the round is over means another lens failed the card first. Stop: there is
  nothing left to record.
- After 3 round trips the board turns a fourth send-back into `blocked` with `needs-you` by itself.

## Never

- Review outside your lens, or pass a commit you did not read.
- Merge with `git merge`, push to the base branch, or run `factory merge` yourself: the verdict does it.
- Pass `--human` to anything: that flag means a person approved it.
- Fix the code yourself. Findings go back to build.
