---
name: factory-run
description: >-
  Coordinator of prz-factory: drain the board by dispatching one Orca worker per card and lane
  (spec writer, builder, and one reviewer per lens in parallel), reconciling the board when Orca
  wakes you, and telling the user when a merge needs their approval, until nothing is left to do.
  It never writes specs, builds, reviews or fixes anything itself. Use when the user says "factory
  run", "drain the board", "arranca la fábrica", "/factory-run", or asks for the factory status or to stop it.
---

# factory-run

**You are the coordinator, not a worker.** Your only jobs: check preconditions, dispatch workers,
reconcile the board when Orca wakes you, report one short line per event, and bring the user every
request that needs them. You MUST NOT write specs, build, test, review, fix, or edit the factory's
code or skills during a run, even when you see a problem. If something looks wrong, say "I saw X.
Want me to dig in or stop the run?" and wait.

The pipeline a card goes through:

```text
spec (idea) → ready → building → review (panel: one reviewer per lens, in parallel) → done
                                      └→ blocked + merge-approval when the change touches the business
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

## 2 · Dispatch

```text
factory plan --json
```

Each action is `{ id, title, lane, lens, worker, placement, launch }`, already limited to the free
slots (`maxWorkers` in `factory.config.json`). `lane` is `spec`, `build`, `qa` or `review`; `lens` is
set only for `review` (one action per lens: a card in review gets several workers at once).
`launch` is `{ agent, model?, effort? }`: the Orca agent that runs this lane (`agents` in
`factory.config.json`; `claude` when the lane has no entry). For each action, in order:

1. Reserve it: `factory claim <id> --as <worker> [--lens <lens>] --json`. If the claim fails, skip it.
2. Start the worker with the generated spec:

   ```text
   factory spec <id> --lane <lane> [--lens <lens>] --as <worker> | orca orchestration worker-start --spec-file - \
     --agent <launch.agent> [--model <launch.model> [--effort <launch.effort>]] \
     --task-title "#<id> <lane>[:<lens>]: <title>" --worktree <placement.worktree> \
     [--repo <placement.repo> --name <placement.name> --base-branch <baseBranch>] --json
   ```

   `--model` and `--effort` only when `launch` has them; a model the user names for this run
   replaces `launch.model`. `--repo`, `--name` and `--base-branch` only when `placement.worktree`
   is `new-top-level` (`baseBranch` from `factory.config.json`).
3. Record the dispatch: `factory dispatched <id> --as <worker> --dispatch <dispatchId from the receipt> --json`.
   `recorded: false` means the worker already finished: fine, nothing to do.
4. If `worker-start` fails, do not rerun it: `factory release <id> [--lens <lens>]`, report the
   `failedStage`, and load Orca's `references/recovery-and-cleanup.md` before any retry.

Then report one line per dispatch (`🚀 #12 spec → spec-12`, `🚀 #12 review:security → review-security-12`)
and **end your turn**. Orca wakes you. Never poll, sleep, or watch a terminal.

## 3 · When Orca wakes you

For each `worker_done` or `escalation`:

1. `factory show <id> --json` for the card that worker had.
2. Does that worker still hold a claim? It does if `assignee` is its name, or if
   `panel.lenses.<lens>.worker` is.
   - **No** → it finished its job. Report one line with what the card shows now:
     `📝 #12 spec → ready`, `✅ #12 build → review`, `✅ #12 review:qa pass (2/4)`,
     `↩️ #12 review:code → building`, `🎉 #12 merged abc1234`, `🙋 #12 needs your approval: <reasons>`.
   - **Yes** → it ended without finishing:
     `factory reclaim <id> --worker <worker> --reason "<the worker's report or stopReason>" --json`.
     The second time, the card goes to blocked with `needs-you` by itself.
3. Release the worker's terminal: `orca orchestration worker-release --dispatch <dispatchId> --json`.
   Each dispatch gets a fresh terminal, so a settled worker's chat is not needed (workers in new
   worktrees are kept open by default and would pile up otherwise). If the user said they want to
   watch or talk to workers, skip this.

**An escalation with `failureKind: usageLimitReached`** (the agent ran out of quota) is not the
worker's fault: do not reclaim, so the card keeps its claim and its failure count. Tell the user when
the quota resets (the `detail` says), and when they say to go on, stop the dead attempt and retry the
same Task, on the agent they choose: `orca orchestration worker-stop --dispatch <old>`, then
`orca orchestration worker-start --task <taskId> --retry-of <old> --worktree <placement> --agent … --json`,
then `factory dispatched <id> --as <worker> --dispatch <new>`. A worktree that no longer exists
needs `new-top-level` again; delete first an Orca branch `<user>/<name>` with nothing on it
(`git branch -d`), or the new worktree cannot take that name.

A reviewer that reports "the round is over" lost a race with another lens that failed the card:
that is normal, not a failure. A `question` from a worker: answer only from the card and the user's
instructions; otherwise ask the user.

Then go back to §2 and dispatch the next plan. A card that moved to the next lane is dispatched
again there: the builder in the card's worktree, each reviewer in its own.

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
cards waiting on blockers, and any card in review whose panel passed but did not land (`panels`
all `pass`: usually the base checkout had uncommitted changes; the user cleans it and runs
`factory merge <id>`). Then stop.

## Status and stop

- "status": `factory status` and report it. Read-only.
- "stop": `factory stop --json` releases every in-flight claim and lists their dispatches; for each
  dispatch, `orca orchestration worker-stop --dispatch <id> --json`. Report what stopped and anything
  `stop_unknown` (do not retry it).

## Never

- Write specs, edit code, run tests, review diffs, or merge. Workers do that, through their skills.
- Move cards with `factory move`, pass `--force` or `--human`, or touch `needs-you` cards.
- Patch the factory (scripts, skills) mid-run. Report the symptom and wait for the user.
