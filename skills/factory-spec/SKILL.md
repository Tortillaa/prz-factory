---
name: factory-spec
description: >-
  Spec writer lane of prz-factory: take one rough idea from the `spec` column, read the code it
  touches, write it as a card a builder can build without guessing, classify its business impact,
  and send it to Ready by itself. Never writes code. Use when told to spec card #N, when dispatched
  as a factory spec worker, or when the user says "factory-spec" / "redacta la tarjeta".
---

# factory-spec

The user sends an idea in their own words. You turn it into the contract the builder builds
against and the reviewers review against, and you approve it yourself: nobody reads your spec
before it is built. So it must be right, small and testable. Board commands are in the
`factory-board` skill; comment shape in `../factory-board/references/writing-standard.md`.
Pass `--json` to `factory` and stop on any error.

## 1 · Start

```text
factory start <id> --lane spec --as <your-worker-name> --json
factory show <id> --json
```

This claims the card and puts this worktree on the base branch, detached: you read, you never
commit. The card's title and body are the idea, exactly as the user wrote it. Read the comments
too: a card that came back from `blocked` carries the user's answers to your earlier questions.

## 2 · Understand it in the code

Before writing a word, find where the idea lands: the route, command, file and function, the tests
that already cover that area, and the project rules in `CLAUDE.md` / `AGENTS.md`. Name real paths
and symbols in the card. If the idea is already true in the code, say so in the handoff to
`blocked` instead of writing a card for nothing.

## 3 · Write the card

**First, cut the scope like a lazy senior developer.** Load the `ponytail` skill (if it is not
installed, read `../ponytail/SKILL.md`) and run its ladder on the idea itself, before any section
exists. You write no code, so apply it to what the card will ask for:

1. **Does it need to exist?** Is the problem real in the code today? If it is already solved, or
   the idea asks for something nobody needs, block (step 6) and say so. Drop features, options
   and flexibility the idea did not ask for.
2. **Is it already in this codebase?** Name the helper, component or pattern the builder must
   reuse, in Context or Fix. A card that makes the builder rebuild what exists is a bad card.
3. **Does the standard library, the platform or an installed dependency do it?** Say which, in Fix.
4. **Otherwise, the smallest version that does the core job.** That is the card. Everything else
   is a later card, or nothing.

Never cut what ponytail never cuts: validation at trust boundaries, error handling that prevents
data loss, security, accessibility, anything the user explicitly asked for. Write what you left
out, and why, in one `- **Not doing:**` line under Context, so the builder and the reviewers do
not add it back.

`factory template` prints the format. Fill every section:

- **Title:** the outcome, in the imperative ("Return 0 for the average of an empty cart").
- **Problem:** what fails or is missing, from the user's side, in 1-3 sentences.
- **Context:** `Where` (real path, route or command) and `Who` (who sees it).
- **Fix:** the intended change in 1-3 lines. The approach, not the code.
- **Acceptance Criteria:** 1-6 checklist lines, each one a result a test can assert: given / when
  / then, with the exact input and the exact expected output. Include the test itself as a
  criterion when the area has none.
- **Risk:** `Low`, `Medium` or `High`, plus one line saying why (step 4 decides the level).

Then check it against what the linter cannot see:

1. **Ambiguous:** could a criterion mean two things? Pick the reading the idea supports and write it out.
2. **No test surface:** every criterion names where it is observed.
3. **Too big:** over the project's `merge.maxLines`, or several unrelated areas. Split it (step 5).
4. **Decision missing:** a product, design, data or security choice the idea does not make and the
   code does not settle. Do not invent it: block (step 6).

## 4 · Classify the business impact

This decides whether the change merges by itself or waits for the user. Read `merge` in
`factory.config.json`: `humanLabels` are the project's business areas and `humanPaths` the files
that always need a person. Add every label that applies:

| Label | The change touches |
|---|---|
| `auth` | login, sessions, permissions, roles, tokens, who can see or do what |
| `payments` | charging, refunds, invoices, payment providers, anything that moves money |
| `pricing` | prices, discounts, taxes, plans, limits, any number the customer pays or is quoted |
| `schema` | database schema, migrations, data backfills, formats other systems read |
| `ops` | what keeps the product running: deploy, config, environment, queues, jobs, integrations, data sources, anything that can take it down or lose data |

- **Any label above, or a file matching `humanPaths` → Risk is `High`**, and the Risk line says
  which area and what could go wrong.
- `Medium`: no business area, but it changes behaviour existing users rely on.
- `Low`: additive or contained, covered by tests.

When you are unsure whether an area applies, it applies. A change wrongly held for the user costs
them a minute; one wrongly merged can cost them the business. Never drop a label to let a card through.

Also set the routing label: `bug` or `feature` (built), or `qa` (only tests what is already on the
base branch; nothing is built).

## 5 · Save it

```text
factory edit <id> --title "<title>" --body-file <card.md> --label <routing> [--label <area>]... [--blocked-by ids] --json
factory lint <id> --json
```

Fix every lint error; fix every warning or be ready to say why it stays.

**Splitting.** A card too big becomes vertical slices, each buildable and testable alone. Keep this
card as the first slice and file the others complete, straight into ready, chained in order:

```text
factory add "<title>" --body-file <slice.md> --label <routing> [--label <area>]... --blocked-by <id> --column ready --json
```

## 6 · Hand off

Comment per writing standard §2 (role `spec`): what the idea became, where it lands in the code,
the risk and labels with the reason, the slices you filed. Then exactly one of:

```text
factory handoff <id> ready   --lane spec --as <name> --text-file <comment.md> --json   # the builder takes it
factory handoff <id> blocked --lane spec --as <name> --text-file <comment.md> --json   # needs the user
```

`ready` fails if the card does not pass lint: fix the card and hand off again.

**Block** with 🙋 when a decision is missing, the idea contradicts the code, or it is already done.
Write the fewest questions that settle it, each with the options you see and the one you
recommend. The user answers on the board and moves the card back to `spec`.

## Never

- Write, change or commit code, or run anything that changes the repo.
- Invent a product decision, or lower a risk or drop a business label so the card merges by itself.
- Use `--force`, or edit a card that is not the one you claimed (except the slices you file).
