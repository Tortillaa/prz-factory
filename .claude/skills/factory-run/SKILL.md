---
name: factory-run
description: >-
  Coordinator of prz-factory: drain the board by dispatching one Orca worker per card and lane (spec
  writer, builder, one reviewer per lens in parallel, merge agent), reconcile the board when Orca
  wakes you, and bring the user every approval request. Never writes specs, builds, reviews or
  merges itself. Use whenever the user wants the factory to work through the board, wants its
  status, or wants it stopped. Triggers: "arranca la fábrica", "procesa el tablero", "factory run",
  "drain the board", "¿cómo va la fábrica?", "para la fábrica", "/factory-run".
---

# factory-run

**You are the coordinator, not a worker.** Your only jobs: check preconditions, dispatch workers,
reconcile the board when Orca wakes you, report one short line per event, and bring the user every
request that needs them. You MUST NOT write specs, build, test, review, fix, or edit the factory's
code or skills during a run, even when you see a problem. If something looks wrong, say "I saw X.
Want me to dig in or stop the run?" and wait.

The pipeline a card goes through:

```text
spec (idea) → ready → building → review (panel: one reviewer per lens, in parallel) → merge → done
                                                                                  └→ blocked + merge-approval
                                                                                     when it touches the business
```

State lives on the board (`factory status`) and in Orca, never in your memory: after any wake,
re-read it.

Commands: `factory` (CLI, see the `factory-board` skill) and Orca's CLI. Load Orca's orchestration
guide once per session with `orca skills get orchestration` (on Linux outside Orca: `orca-ide`).
Pass `--json` everywhere and branch on the result, not on wording.

## 1 · Preconditions (once, before the first dispatch)

```text
factory doctor --json
factory status --json
orca orchestration run-current --json
```

- `doctor` must pass `config` (a non-empty `verify`: the merge gate needs it) and `orca`. Anything
  else failing: report it and stop.
- `status.inFlight` not empty at start: claims left by an earlier run. For each, check its
  `dispatch` with `orca orchestration worker-show --dispatch <id> --json`. A live worker is still
  yours: leave it. A settled or unknown one never finished:
  `factory reclaim <id> --worker <worker> --reason "<what worker-show says>"`.
- `status.approvals` and `status.needsYou`: tell the user once (see §4); you never touch those cards.
- Leftovers in Orca from earlier runs: `orca orchestration worker-list --run <runId> --json` and
  `worker-release` every worker with `terminalState: retained` and `liveness: exited` (its job is
  settled; a kept-open chat the user asked for is the only exception). Then `factory cleanup --apply`:
  worktrees and branches of cards already in done.

## 2 · Dispatch

```text
factory dispatch --json
```

One command does the whole step, so you never claim, start or record a worker by hand:

1. Stops the workers whose round is over (another lens failed the card, or the card was moved) and
   releases their terminals.
2. Releases the Orca terminals of workers that no longer hold a claim (they finished), so Orca
   does not fill up with idle agents.
3. Starts a worker for every action of `factory plan`, up to the free slots (`maxWorkers`, shared
   or per agent): it claims the card or lens, generates the spec, runs `orca orchestration
   worker-start` with the lane's agent, model and effort (`agents` in `factory.config.json`), and
   records the dispatch. A start Orca refuses gives the claim back.

Each event is `{ kind, id, lane, lens, worker, dispatch, launch }`, `kind` one of `started`,
`stopped`, `released`, `failed`, `skipped`. Report one line each (`🚀 #12 review:security →
review-security-12 (grok grok-4.7)`, `⛔ #12 stopped review-qa-12 (round over)`, `🧹 #12 released
spec-12`). For a `failed` start, load Orca's `references/recovery-and-cleanup.md` before any retry.

`factory dispatch --dry-run --json` shows what it would do without doing it. If the user names a
model for this run, change `agents` in `factory.config.json` instead of starting workers by hand.

Then **end your turn**. Orca wakes you. Never poll, sleep, or watch a terminal.

## 3 · When Orca wakes you

For each `worker_done` or `escalation`:

1. `factory show <id> --json` for the card that worker had.
2. Does that worker still hold a claim? It does if `assignee` is its name, or if
   `panel.lenses.<lens>.worker` is.
   - **No** → it finished its job. Report one line with what the card shows now:
     `📝 #12 spec → ready`, `✅ #12 build → review`, `✅ #12 review:qa pass (2/2)`,
     `↩️ #12 review:code → building`, `🔀 #12 review → merge`, `🎉 #12 merged abc1234`,
     `🙋 #12 needs your approval: <reasons>`.
   - **Yes** → it ended without finishing:
     `factory reclaim <id> --worker <worker> --reason "<the worker's report or stopReason>" --json`.
     The second time, the card goes to blocked with `needs-you` by itself.
3. After a merge (`🎉`): `factory cleanup --apply`, so the card's worktrees and branches leave Orca.
4. `factory status --json`: an `inFlight` claim with `stale: true` (older than 3 hours) gets checked
   with `orca orchestration worker-show`; a settled or unknown worker never finished: `factory reclaim`.

Then go back to §2: `factory dispatch` releases the finished workers' terminals, stops the ones
whose round ended, and starts what comes next.

**An escalation with `failureKind: usageLimitReached`** (the agent ran out of quota) is not the
worker's fault: do not reclaim, so the card keeps its claim and its failure count. Tell the user when
the quota resets (the `detail` says), and when they say to go on, stop the dead attempt and retry the
same Task, on the agent they choose: `orca orchestration worker-stop --dispatch <old>` and
`orca orchestration worker-release --dispatch <old>` (a stopped attempt keeps its terminal otherwise), then
`orca orchestration worker-start --task <taskId> --retry-of <old> --worktree <placement> --agent … --json`,
then `factory dispatched <id> --as <worker> --dispatch <new>`. A worktree that no longer exists
needs `new-top-level` again; delete first an Orca branch `<user>/<name>` with nothing on it
(`git branch -d`), or the new worktree cannot take that name.

Worker names carry the round after the first one (`build-12-r2`, `review-qa-12-r3`), so a worker
left over from an earlier round is refused by the board instead of acting under the new claim.

A reviewer that reports "the round is over" lost a race with another lens that failed the card:
that is normal, not a failure (`factory dispatch` stops the rest of that round). A `question` from a
worker: answer only from the card and the user's instructions; otherwise ask the user.

## 4 · Requests for the user

After every reconcile, read `factory status --json` and tell the user, once per card, right away
(do not wait for the end of the run):

- **`approvals`** — the merge gate held a change that touches the business (high risk, a business
  label, a sensitive path, a big diff, or a reviewer escalated it). Say it plainly:

  ```text
  🙋 #12 «<title>» needs your approval to merge
  Why: <the reasons in the card's last [merge] comment>
  Reviewed: <branch> @ <sha> — the whole panel passed it
  Approve: open the card on the board and press "Aprobar y mergear", or run
           factory merge 12 --sha <sha> --human
  ```

- **`needsYou`** — something is stuck: a spec that needs a decision, a card that bounced three
  times, a worker that failed twice. Quote the question or the reason from the last comment and
  say what unblocks it (answer in a comment and move the card back to `spec`, `ready` or `building`).

Never approve, answer or move those cards yourself. Keep dispatching everything else meanwhile.

## 5 · Done

When `factory status --json` says `idle` (nothing in flight, nothing to dispatch), report: cards
merged this run (with SHAs), merges waiting for the user's approval, cards that need the user,
and cards waiting on blockers. Then stop.

## Status and stop

- "status": `factory status` and report it. Read-only.
- "stop": `factory stop --json` releases every in-flight claim and lists their dispatches; for each
  dispatch, `orca orchestration worker-stop --dispatch <id> --json`. Report what stopped and anything
  `stop_unknown` (do not retry it).

## Never

- Write specs, edit code, run tests, review diffs, or merge. Workers do that, through their skills.
- Move cards with `factory move`, pass `--force` or `--human`, or touch `needs-you` cards.
- Patch the factory (scripts, skills) mid-run. Report the symptom and wait for the user.
