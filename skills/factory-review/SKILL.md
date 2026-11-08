---
name: factory-review
description: >-
  Reviewer lane of prz-factory: review a tested card's diff against its Acceptance Criteria,
  remember findings from earlier rounds, and land it through the `factory merge` gate or send it
  back. The only lane that moves cards to Done, and only through the gate. Use when told to review
  card #N, when dispatched as a factory review worker, or when the user says "factory-review".
---

# factory-review

You decide whether this exact commit should land. Board commands are in `factory-board`; formats
in `../factory-board/references/writing-standard.md` (§3 for findings).

## 1 · Start

```text
factory start <id> --lane review --as <your-worker-name> --json
```

Your worktree is now on the branch head, detached. Note the `head` SHA from the result: that is
the commit you are reviewing, and the only one you may merge.

## 2 · Your own pass first

Before reading the builder's and QA's comments, read the card's Acceptance Criteria and the raw
diff (`git diff <base>...HEAD`), and write down 2-4 hypotheses: what must be true for this to be
right, and where it would most likely break. Then check each hypothesis against the code and tests.

Only then read the earlier comments. Each claim there is a lead, not evidence: check it.

**Remember earlier rounds.** If an earlier `[review]` comment has a findings table, re-check every
open finding first and mark it ✅ fixed (with the proof) or keep it ❌ open. Keep the IDs.

Classify every finding (Gap · Bug · Verification miss · Scope drift · Over-engineering) and give it
a severity (Blocker · Should fix · Nit). The scope is the diff, never the whole codebase. Apply the
repo's rules from `CLAUDE.md` / `AGENTS.md`. Over-engineering is always Should fix: it never blocks
alone.

## 3 · Decide

**Any open Blocker** → send it back with the findings table:

```text
factory handoff <id> building --lane review --as <name> --text-file <comment.md> --json
```

(Use `qa` instead of `building` when the problem is missing evidence, not code. Use `blocked` with
🙋 when it needs a product or design decision, or when the card has been back to building 3 times.)

**No Blockers** → merge through the gate, pinned to the head you reviewed:

```text
factory merge <id> --sha <head> --as <name> --json
```

First write your review comment with `factory comment <id> --role review --text-file <f>`
(✅ merge-ready, the findings table if any, `Head: <sha>`). The gate then decides by exit code:

| Exit | Meaning | What happened / what you do |
|---|---|---|
| 0 | merged | Card is Done. Report the merged SHA. |
| 6 | head moved after your review | Card stays in review. Review the new commits (restart from §2), never merge a head you did not see. |
| 7 | needs a person | The gate moved it to blocked with `needs-you` and the reasons. Nothing else to do. |
| 8 | branch behind base | The gate sent it to building for a rebase. Nothing else to do. |
| 9 | verify failed | The gate sent it to building with the output. Nothing else to do. |
| 10 | base checkout has uncommitted changes | Card stays in review. Tell the user; do not touch their checkout. |
| 1 | error | Report the message and release the card: `factory release <id>`. |

## Never

- Merge with `git merge`, push to the base branch, or move a card to Done yourself.
- Pass `--human` to `factory merge`: that flag means a person approved it.
- Fix the code yourself. Findings go back to build.
