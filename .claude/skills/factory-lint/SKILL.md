---
name: factory-lint
description: >-
  Turn rough ideas or vague cards into cards a worker can build without guessing: write them in the
  card format, run `factory lint`, and resolve the judgment calls the linter cannot (ambiguity, size,
  title/body mismatch, missing decisions) by asking the user. Use when the user says "lint the board",
  "revisa las tarjetas", "write a card for…", "crea una tarjeta", or before moving cards to ready.
---

# factory-lint

Workers cannot ask questions mid-run; a vague card makes them guess. This skill asks now, while
the user can still answer. One card at a time, plain product language, recommended answer first.

## 1 · Scope

- "Write a card for X": draft it (step 3) and file it with `factory add --body-file`.
- "Lint the board": `factory lint --json` lints every backlog and ready card. Also read each
  backlog/ready card yourself (`factory show <id> --json`) for the judgment checks in step 2:
  the linter only checks the deterministic ones.

Read the project's `CLAUDE.md` / `AGENTS.md` and README once, so the questions use its words.

## 2 · Judgment checks (the linter's blind spots)

Flag a card when:

1. **Ambiguous:** a criterion could reasonably mean two different things. Name both readings.
2. **No trigger + outcome:** "login works". Rewrite as given / when / then.
3. **No test surface:** nothing says where it is seen (route, command, file, function).
4. **Too big:** likely over the project's `merge.maxLines`, or touches several unrelated areas. Split it into vertical slices, each with its own ACs, linked with `--blocked-by`.
5. **Bundled:** unrelated features in one card. Split.
6. **Title and body disagree.** Ask which is right.
7. **A decision is missing:** product, design, data or security choices a worker would have to invent. Ask the user; write the answer into Context.
8. **Proven against a fake only:** an AC tested with a mock while nothing builds the real thing. Name the card that does, or file it.

## 3 · Fix it with the user

For each flagged card, ask the fewest questions that settle it (multiple choice when you can), then
rewrite the body in the template (`factory template`): Problem from the user's side, Context
(where, who), Fix in 1-3 lines, Acceptance Criteria as a checklist a test can assert, Risk
(Low/Medium/High plus why), dependencies as `--blocked-by`.

```text
factory edit <id> --body-file <card.md> [--label feature|bug|qa] [--blocked-by ids] --json
factory lint <id> --json
```

Loop until `factory lint` has no errors and every judgment check is settled. Warnings (vague
words, many ACs) need an answer too: fix them or tell the user why they stay.

Writing the card yourself is optional: an idea filed in the `spec` column (`factory add "<idea>"
--column spec`, or "Nueva idea" on the board) is written up by the spec writer (`factory-spec`) and
sent to ready with nobody in between. Use this skill when the user wants to decide the details.

## 4 · Hand back

List each card: `✔ #12 ready to move` or `❓ #13 waiting on <question>`. Moving cards to `ready` is
the user's call (on the board, or `factory move <id> ready` when they ask you to).

## Never

- Invent answers to product questions. Ask.
- Move a card to ready with `--force`, or edit a card that is in flight (spec with a worker, building, qa, review).
