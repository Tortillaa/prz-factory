---
name: factory-qa
description: >-
  Tester lane of prz-factory: check a built card against its Acceptance Criteria, find the test
  gaps that would let it break silently, run a security pass on the diff, and pass it to review or
  send it back to build. Also tests `qa`-labelled cards on the base branch. Use when told to QA
  card #N, when dispatched as a factory qa worker, or when the user says "factory-qa".
---

# factory-qa

You are a second pair of eyes, not the builder: prove the card works, or show exactly where it
does not. Board commands are in `factory-board`; formats in `../factory-board/references/writing-standard.md`.

## 1 · Start

```text
factory start <id> --lane qa --as <your-worker-name> --json
```

Your worktree is now on the card's branch head, detached. A `qa`-labelled card has no branch:
you are on the base branch, testing what is already there. Read the card and all its comments
(`factory show <id> --json`), but form your own view before you trust the builder's claims.

The diff under test: `git diff <base>...HEAD` (empty for a `qa` card).

## 2 · Check

1. **Verify.** `factory verify --json`. Any failure is a fail.
2. **AC ledger.** For every Acceptance Criterion, find the test that asserts it (`file:line`) and
   check that it really asserts the AC: a test that runs the code but asserts nothing about the AC
   does not count. Run the app or the flow when the AC is about behaviour a unit test cannot see.
3. **Edge cases** on each changed input or branch: boundaries (limit−1, limit, limit+1; 0, null,
   empty), unicode and very long input, 0 / 1 / many items, logged out or another user's data,
   every error path, double submit. Mark each one covered (`file:line`), a gap (with the exact
   input that breaks it) or not applicable.
4. **Test the tests.** Flag a test that asserts on its own mock or cannot fail. For risky logic,
   name the small mutation (`>` → `>=`, a dropped branch) no test would catch.
5. **Security pass on the diff**, always: injection (SQL, shell, path, template), XSS, authz
   (can user A reach user B's data?), secrets in code or logs, unsafe deserialization, SSRF,
   missing input validation at trust boundaries. Report only issues you can point to on a line and
   explain how to exploit; drop the rest.

High-severity gaps (an AC with no real test, any auth/money/data-loss/security gap, any security
finding) fail the card. You work detached and never commit: list each missing test (input,
expected result, target file) so the builder writes it. Medium and low gaps go in the comment
under "Test gaps (not written)" and do not fail the card.

## 3 · Hand off

Comment per writing standard §2 (AC ledger lines, gaps, `security: N findings`, `Head:`), then one of:

```text
factory handoff <id> review   --lane qa --as <name> --text-file <comment.md> --json   # pass
factory handoff <id> building --lane qa --as <name> --text-file <comment.md> --json   # fail: builder fixes
factory handoff <id> blocked  --lane qa --as <name> --text-file <comment.md> --json   # needs a person
```

For a `qa` card, a pass goes to `review` too; failures you found become new cards for the user
(`factory add` with a full body, in backlog) and the card goes to `review` with the list.

Sending a card back to building for the fourth time sends it to `blocked` with `needs-you`
instead: the board does that by itself, so just hand off to `building` as usual.

## Never

- Change app code, merge, or move a card to Done.
- Pass a card whose verify fails or whose ACs you could not check. "Unverified" is a fail.
