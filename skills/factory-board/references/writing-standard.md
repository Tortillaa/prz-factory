# Writing standard

Every factory lane writes commits and card comments in these shapes. Adapted from super-board's
`writing-standard.md` (MIT). Evidence before adjectives: the command, the SHA, the `file:line`.
Don't restate the card. Don't narrate ("I have successfully…").

## 1 · Commit

```
<emoji> [<type>] <scope>: <subject>

- <short bullet: what changed>
- <short bullet: what proves it>
Card: #<id>
```

- Subject: imperative, ≤ 72 characters, scope in lowercase (`login`, `api/users`, `board`).
- Body: 1-4 bullets. `Card: #<id>` on every commit made for a card.

| Emoji | Type | Use for |
|---|---|---|
| ✨ | `feat` | new behaviour |
| 🐛 | `fix` | bug fix |
| 🔧 | `chore` | tooling, config |
| ♻️ | `refactor` | same behaviour, better shape |
| 🧪 | `test` | tests only |
| ⚡ | `perf` | faster, same behaviour |
| 📝 | `docs` | docs only |
| 👷 | `ci` | CI pipelines |
| 💄 | `ui` | visual polish |
| 🔒 | `security` | auth, secrets, hardening |
| ⏪ | `revert` | revert a commit |
| 🚧 | `wip` | partial work, checkpoints |

The merge gate fast-forwards, so these commits land on the base branch as they are: keep them clean.

## 2 · Lane comment (the `--text-file` of a handoff or a verdict)

```
[<role>] <status-emoji> <status> · <round or short context>
Did: <what this lane did, one line>
✅ Done: <what passed or landed, with evidence>
❌ Not done: <what failed or was skipped, and why>     (omit when nothing)
Next: <build | review | merge | user | none>
Head: <commit SHA this comment is about>
```

- Roles: `spec` · `build` · `qa` · `review:<lens>` (`review:qa`, `review:security`, `review:code`, `review:ops`). Status emoji: ✅ pass · ❌ fail · 🛑 blocked · 🙋 needs you · ↩️ sent back · ⚠️ warning.
- ≤ 8 lines of prose. Machine lines (`Head:`, `Verify:`) go last and do not count.
- One AC per line when you report on Acceptance Criteria: `AC1 ✅ test/login.test.mjs:12`.

Example:

```
[review:qa] ❌ failing · round 1
Did: AC ledger, edge cases on the new form, security pass on the diff
✅ Done: AC1 test/login.test.mjs:14 · security: 0 findings
❌ Not done: AC2 no test asserts the error text; wrong password returns 500, not the message
Next: build
Head: 3f2a91c0
```

## 3 · Review findings

Each reviewer of the panel keeps one finding list per card for its lens and repeats it, updated,
in every comment. IDs carry the lens (`Q1` qa · `S1` security · `C1` code · `O1` ops) and never
change; a new finding takes the next free ID of its lens.

```
| ID | Class | Severity | Where | Finding | Status |
|---|---|---|---|---|---|
| C1 | Bug | Blocker | `src/cart.mjs:12` | average divides by zero on an empty cart | ❌ open |
```

- Class: Gap (an AC is missing) · Bug · Verification miss (code may be right, evidence does not prove it) · Scope drift · Over-engineering.
- Severity: Blocker (correctness, security, data loss, failing tests, broken AC) · Should fix · Nit.
- Status: ❌ open · ✅ fixed (with the proof) · ➖ dropped (with the reason).
