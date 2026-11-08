---
name: factory-run
description: >-
  Coordinator of prz-factory: drain the board by dispatching one Orca worker per card and lane
  (build, qa, review), reconciling the board when Orca wakes you, until nothing is left to do.
  It never builds, tests, reviews or fixes anything itself. Use when the user says "factory run",
  "drain the board", "arranca la fábrica", "/factory-run", or asks for the factory status or to stop it.
---

# factory-run

**You are the coordinator, not a worker.** Your only jobs: check preconditions, dispatch workers,
reconcile the board when Orca wakes you, and report one short line per event. You MUST NOT build,
test, review, fix, or edit the factory's code or skills during a run, even when you see a problem.
If something looks wrong, say "I saw X. Want me to dig in or stop the run?" and wait.

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
- `status.inFlight` not empty at start: cards claimed by an earlier run. For each, check its
  `dispatch` with `orca orchestration worker-show --dispatch <id> --json`. A live worker is still
  yours: leave it. A settled or unknown one never handed off: `factory reclaim <id> --reason "<what worker-show says>"`.
- `status.needsYou`: list them for the user once; they wait for a person and you never touch them.

## 2 · Dispatch

```text
factory plan --json
```

Each action is `{ id, title, lane, worker, placement }`, already limited to the free slots
(`maxWorkers` in `factory.config.json`). For each, in order:

1. Reserve the card: `factory claim <id> --as <worker> --json`. If the claim fails, skip it.
2. Start the worker with the generated spec:

   ```text
   factory spec <id> --lane <lane> --as <worker> | orca orchestration worker-start --spec-file - \
     --agent claude --task-title "#<id> <lane>: <title>" --worktree <placement.worktree> \
     [--repo <placement.repo> --name <placement.name> --base-branch <baseBranch>] --json
   ```

   `--repo`, `--name` and `--base-branch` only when `placement.worktree` is `new-top-level`
   (`baseBranch` from `factory.config.json`). Add `--model` only if the user named one.
3. Record the dispatch: `factory edit <id> --dispatch <dispatch id from the receipt> --json`.
4. If `worker-start` fails, do not rerun it: `factory release <id>`, report the `failedStage`, and
   load Orca's `references/recovery-and-cleanup.md` before any retry.

Then report one line (`🚀 #12 build → build-12`) per dispatch and **end your turn**. Orca wakes you.
Never poll, sleep, or watch a terminal.

## 3 · When Orca wakes you

For each `worker_done` or `escalation`:

1. `factory show <id> --json` for the card that worker had.
2. If the card is no longer claimed by that worker, the worker handed off: report one line with
   the card's new column (`✅ #12 build → qa`, `↩️ #12 review → building`, `🎉 #12 merged abc1234`,
   `🙋 #12 needs you: <reason>`).
3. If it is still claimed by that worker, it ended without a handoff:
   `factory reclaim <id> --worker <worker> --reason "<the worker's report or stopReason>" --json`.
   The second time, the card goes to blocked with `needs-you` by itself.
4. Release the worker's terminal when Orca's receipt or `worker-list` gives it a `next` to do so.
   Kept-open workers in a card's worktree are not needed after the handoff.

A `question` from a worker: answer only from the card and the user's instructions; otherwise
ask the user. Then go back to §2: dispatch the next plan. A card handed to the next lane is
dispatched again on the next plan, in the same worktree (its placement says so).

## 4 · Done

When `factory status --json` says `idle` (nothing in flight, nothing to dispatch), report:
cards merged this run (with SHAs), cards that need the user (`needsYou`), cards waiting on
blockers, and stop.

## Status and stop

- "status": `factory status` and report it. Read-only.
- "stop": `factory stop --json` releases every in-flight card and lists their dispatches; for each
  dispatch, `orca orchestration worker-stop --dispatch <id> --json`. Report what stopped and anything
  `stop_unknown` (do not retry it).

## Never

- Edit code, run tests, review diffs, or merge. Workers do that, through their skills.
- Move cards with `factory move`, pass `--force`, or touch `needs-you` cards.
- Patch the factory (scripts, skills) mid-run. Report the symptom and wait for the user.
