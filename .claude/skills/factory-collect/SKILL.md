---
name: factory-collect
description: >-
  Find problems in a project, verify each one, and file the real ones as deduplicated backlog cards
  in the card format. Sources: failing verify, test and type errors, TODO/FIXME debt, dependency
  audits, and logs or reports the user hands over. Never edits code. Use when the user says
  "collect", "busca problemas", "what's broken", "turn these errors into cards", or hands over logs.
---

# factory-collect

You turn evidence into cards. You never fix anything: every finding goes to `backlog`, where the
user decides what moves to `ready`. Default is a **dry run**: show the findings first, file only on
the user's yes.

## 1 · Gather

Run the sources that apply (ask which when the user did not say), and record each as
`read (n findings)`, `empty` or `unavailable (why)`. Never report a source you could not read as empty.

| Source | How |
|---|---|
| verify | `factory verify --json` on the base branch: each failing command |
| tests / types | the project's test and type-check commands with full output, when verify stops at the first failure |
| debt | `git grep -nE "TODO|FIXME|HACK|XXX"`: only items that describe a defect or a missing piece, not notes |
| dependencies | `npm audit --json`, `pip-audit`, `cargo audit` or similar, when installed |
| user evidence | logs, stack traces, bug reports, screenshots the user gives you |

## 2 · Verify each candidate

A candidate becomes a finding only with proof you reproduced: the command and its output, the
`file:line`, the exact input that breaks it. Can't reproduce it: drop it and say why in the report.
Group duplicates (the same root cause seen from several places) into one finding.

## 3 · Fingerprint

Each finding gets a stable key that does not change between runs: `<source>:<where>:<what>`, with
no line numbers, timestamps or IDs that move. Examples:
`verify:npm-test:test/cart.test.mjs#empty-cart-average`, `debt:src/api/users.mjs#no-pagination`,
`audit:lodash#CVE-2021-23337`.

## 4 · File (after the user says yes)

Write each finding as a full card (template from `factory template`) with an extra `## Evidence`
section: the command, the trimmed output, the `file:line`. Acceptance Criteria must be checkable;
risk follows the impact. Then:

```text
factory add "<problem, in user terms>" --body-file <card.md> --label bug --source <fingerprint> --evidence "<one-line proof>" --json
```

`status` tells you what happened: `created`, `duplicate` (an open card already has this fingerprint:
it got a "seen again" comment, do not file another), or `recurrence` (it was done and came back: a
new card naming the old one, labelled `recurrence`). Run `factory lint <id>` on each new card and fix
what it reports.

## 5 · Report

```
factory-collect · <dry run | filed>
Sources: verify read (2) · debt read (5) · dependencies unavailable (no npm audit)
Created: #14 #15 · Seen again: #9 · Recurrence: #16 (was #4) · Dropped: 3 (not reproducible)
```

## Never

- Edit code, tests or config to make a finding go away.
- File without the dedupe key, or file a finding you did not reproduce.
- Move cards out of backlog.
