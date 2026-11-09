# Review lenses

One section per lens of the review panel. Read only yours. Each lens has its own finding IDs
(`Q1`, `S1`, `C1`, `O1`…) so tables from different reviewers never collide.

A Blocker in your lens fails the card. Everything else goes in your comment and does not.

## qa · does it do what the card says, and would a test notice if it stopped?

IDs `Q1`… You prove the card works, or show exactly where it does not.

1. **Verify.** `factory verify --json`. Any failure is a Blocker.
2. **AC ledger.** For every Acceptance Criterion, find the test that asserts it (`file:line`) and
   check that it really asserts the AC: a test that runs the code but asserts nothing about the AC
   does not count. Run the app or the flow when the AC is about behaviour a unit test cannot see.
   Report one line per AC: `AC1 ✅ test/login.test.mjs:12`.
3. **Edge cases** on each changed input or branch: boundaries (limit−1, limit, limit+1; 0, null,
   empty), unicode and very long input, 0 / 1 / many items, every error path, double submit. Mark
   each covered (`file:line`), a gap (with the exact input that breaks it) or not applicable.
4. **Test the tests.** Flag a test that asserts on its own mock or cannot fail. For risky logic,
   name the small mutation (`>` → `>=`, a dropped branch) no test would catch.

Blockers: verify fails; an AC with no real test; an AC you could not check ("unverified" is a
fail); an edge case that breaks the feature. You never write the missing test: list it (input,
expected result, target file) for the builder. Medium and low gaps go under "Test gaps (not written)".

## security · can this change be abused?

IDs `S1`… Only the diff, and only issues you can point to on a line and explain how to exploit.
Drop the rest: a vague worry is not a finding.

- **Injection:** SQL, shell, path traversal, template, header. Follow each new input to where it is used.
- **XSS** and unsafe HTML; unsafe deserialization; SSRF; open redirects.
- **Authorization:** can user A reach or change user B's data? Is every new route, command or job
  behind the same checks as its neighbours?
- **Secrets:** keys, tokens or passwords in code, tests, fixtures, logs or error messages.
- **Input validation** at trust boundaries: size, type, range, encoding.
- **Dependencies:** a new or upgraded package: is it the real one, pinned, and needed?
- **Fail closed:** on error, does it deny, or let through?

Blockers: any exploitable finding; any secret in the diff. A hardening idea with no exploit is Should fix.

## code · is this the right change, and only this change?

IDs `C1`… You decide whether this diff belongs in the codebase as written.

- **Correctness:** logic errors, off-by-one, null and empty handling, error paths, concurrency,
  resource leaks. Read the code the diff calls, not only the diff.
- **Scope:** does it build what the Acceptance Criteria say, all of it and nothing more? A change
  the card did not ask for is Scope drift.
- **Fit:** does it follow the repo's rules (`CLAUDE.md` / `AGENTS.md`), its patterns and its names?
  Does it reuse what exists before adding a dependency, abstraction, option or file?
- **Simplicity:** is there a clearly smaller change with the same result? (Over-engineering:
  Should fix, never a Blocker alone.)
- **Readability:** would the next person understand why, six months from now?
- **Commits:** in the format of the writing standard §1, each with `Card: #<id>`. The merge gate
  fast-forwards: these commits land as they are.

Blockers: wrong behaviour, a broken or missing AC, a broken repo rule, scope drift that changes
behaviour the card did not mention.

## ops · what does this do to the business and to the running product?

IDs `O1`… You are the last line before a change that can cost money, lose data or take the product
down merges with nobody watching. Read `merge` in `factory.config.json` first: `humanLabels` are
this project's business areas, `humanPaths` the files that always need a person.

1. **Business areas.** Does the diff touch any of these, whatever the card says?
   - `auth`: login, sessions, permissions, roles, tokens.
   - `payments`: charging, refunds, invoices, payment providers.
   - `pricing`: prices, discounts, taxes, plans, limits, any number a customer pays or is quoted.
   - `schema`: database schema, migrations, backfills, formats other systems read.
   - `ops`: deploy, config, environment, queues, scheduled jobs, integrations, data sources.
2. **Classification.** If it does and the card lacks that label or is not `High` risk, the spec
   writer missed it: **pass with `--escalate "<area>: <what could go wrong>"`** (when the code is
   sound) so the user approves the merge. Never let it through quietly.
3. **Operability.** Can it be deployed and rolled back safely? Is the migration reversible and
   safe on real data volumes? Is it backward compatible with what is already running (old clients,
   stored data, queued jobs, config that is not there yet)? What happens on a retry, a timeout, a
   partial failure? Would anyone notice if it broke (logs, errors, a metric)?
4. **Blast radius.** Who and what is affected if this is wrong, and can it be undone?

Blockers: data loss or corruption; an irreversible migration with no plan; a change that breaks
what is already running; a business rule changed beyond what the card asked. When the code is
sound but a person should still decide, that is an escalation, not a fail.
