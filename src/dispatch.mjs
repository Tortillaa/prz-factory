// `factory dispatch`: one coordinator step, deterministic. It stops the workers whose round is over,
// releases the Orca terminals of workers that finished, and starts a worker for every action of
// `plan` (claim → spec → `orca orchestration worker-start` → record), so the coordinator never runs
// those steps by hand. Orca is reached through `orcaCli()`, which tests replace with a fake.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';
import * as run from './run.mjs';
import { findLeftovers, applyCleanup } from './cleanup.mjs';

// The Orca CLI as [command, ...prefix args]. FACTORY_ORCA points at a replacement (a .mjs runs on node).
export function orcaCli(env = process.env) {
  const cmd = env.FACTORY_ORCA || env.ORCA_CLI_COMMAND || 'orca';
  return /\.m?js$/i.test(cmd) ? [process.execPath, cmd] : [cmd];
}

// Runs one Orca command; returns its JSON result, or { error } when it failed.
function orca(args, { input } = {}) {
  const [cmd, ...prefix] = orcaCli();
  const r = spawnSync(cmd, [...prefix, ...args, '--json'], { input, encoding: 'utf8', windowsHide: true });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  if (r.status !== 0 || !out?.ok) return { error: out?.error?.message || (r.stderr || r.stdout || r.error?.message || 'orca failed').trim().slice(0, 400) };
  return out.result ?? {};
}

const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');

// A live `factory serve` for this board: serve.json (next to it) holds a pid that still exists.
function serveAlive(file) {
  try {
    process.kill(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'serve.json'), 'utf8')).pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // the process exists but is not ours
  }
}

export function dispatch({ file, config, repoRoot, dryRun = false }) {
  const events = [];

  // 0 · The web board lives in its own Orca terminal, outside this agent's session (background tasks
  // of a session are cut after two hours or when Orca restarts).
  if (!dryRun && !serveAlive(file)) {
    const r = orca(['terminal', 'create', '--worktree', `path:${repoRoot}`, '--title', 'Tablero web', '--command', `node "${CLI}" serve`]);
    events.push({ kind: 'served', ...(r.error ? { note: `terminal create: ${r.error}` } : {}) });
  }

  // 1 · Workers still running on a round that is over: stop them and drop them from the list.
  for (const o of run.status(store.load(file), config, repoRoot).toStop) {
    if (dryRun) {
      events.push({ kind: 'would-stop', id: o.id, worker: o.worker, dispatch: o.dispatch });
      continue;
    }
    const stop = orca(['orchestration', 'worker-stop', '--dispatch', o.dispatch]);
    orca(['orchestration', 'worker-release', '--dispatch', o.dispatch]);
    // A worker that already ended has nothing left to stop: forget it all the same.
    store.update(file, (b) => {
      store.forgetOrphan(b, o.id, o.dispatch);
      const rec = b.workers.find((x) => x.dispatch === o.dispatch);
      if (rec) Object.assign(rec, { released: true, endedAt: rec.endedAt ?? new Date().toISOString(), outcome: 'round-over' });
    });
    events.push({ kind: 'stopped', id: o.id, worker: o.worker, dispatch: o.dispatch, ...(stop.error ? { note: stop.error } : {}) });
  }

  // 2 · Terminals of workers that no longer hold their claim (they handed off, or were reclaimed):
  // release them so Orca does not fill up. Orca refuses a worker that is still running; it stays listed.
  for (const w of (store.load(file).workers || []).filter((x) => !x.released)) {
    const card = store.load(file).cards.find((c) => c.id === w.id);
    if (card && store.holding(card, w.worker)) continue;
    if (dryRun) {
      events.push({ kind: 'would-release', id: w.id, worker: w.worker, dispatch: w.dispatch });
      continue;
    }
    const rel = orca(['orchestration', 'worker-release', '--dispatch', w.dispatch]);
    if (rel.error && !/settled|released|unknown|not found/i.test(rel.error)) continue;
    store.update(file, (b) => {
      const rec = b.workers.find((x) => x.dispatch === w.dispatch);
      if (rec) {
        rec.released = true;
        rec.endedAt ??= new Date().toISOString();
      }
    });
    events.push({ kind: 'released', id: w.id, worker: w.worker, dispatch: w.dispatch });
  }

  // 3 · Start what the plan says, up to the free slots.
  for (const a of run.plan(store.load(file), config, repoRoot)) {
    if (dryRun) {
      events.push({ kind: 'would-start', id: a.id, lane: a.lane, lens: a.lens, worker: a.worker, launch: a.launch });
      continue;
    }
    try {
      store.update(file, (b) => (a.lens ? store.claimLens(b, a.id, a.lens, a.worker) : store.claimCard(b, a.id, a.worker)));
    } catch (err) {
      events.push({ kind: 'skipped', id: a.id, worker: a.worker, note: err.message });
      continue;
    }
    const card = store.getCard(store.load(file), a.id);
    const spec = run.spec(card, a.lane, a.worker, repoRoot, a.lens);
    const p = a.placement;
    const role = run.roleTitle(card, a.lane, a.lens, run.round(card, a.lane));
    const args = ['orchestration', 'worker-start', '--spec-file', '-', '--agent', a.launch.agent,
      ...(a.launch.model ? ['--model', a.launch.model] : []), ...(a.launch.effort ? ['--effort', a.launch.effort] : []),
      '--task-title', `${role}: ${a.title}`.slice(0, 120), '--worktree', p.worktree,
      ...(p.worktree === 'new-top-level' ? ['--repo', p.repo, '--name', p.name, '--base-branch', config.baseBranch, '--display-name', role] : [])];
    const started = orca(args, { input: spec });
    if (started.error || !started.dispatchId) {
      // Nothing started: give the claim back so the next dispatch retries it.
      store.update(file, (b) => (a.lens ? store.releaseLens(b, a.id, a.lens) : store.releaseCard(b, a.id)));
      events.push({ kind: 'failed', id: a.id, lane: a.lane, lens: a.lens, worker: a.worker, note: started.error || 'no dispatchId in the receipt' });
      continue;
    }
    store.update(file, (b) => {
      run.recordDispatch(b, a.id, { worker: a.worker, dispatch: started.dispatchId });
      (b.workers ??= []).push({ id: a.id, worker: a.worker, dispatch: started.dispatchId, lane: a.lane, lens: a.lens, agent: a.launch.agent, model: a.launch.model ?? null, startedAt: new Date().toISOString() });
    });
    // The role changes while the workspace stays: rename it, and the terminal tab. A failure only leaves a note.
    const notes = [];
    if (p.worktree !== 'new-top-level') {
      const r = orca(['worktree', 'set', '--worktree', p.worktree, '--display-name', role]);
      if (r.error) notes.push(`worktree set: ${r.error}`);
    }
    const handle = started.terminal ?? started.terminalHandle;
    if (handle) {
      const r = orca(['terminal', 'rename', '--terminal', handle, '--title', role]);
      if (r.error) notes.push(`terminal rename: ${r.error}`);
    }
    events.push({ kind: 'started', id: a.id, lane: a.lane, lens: a.lens, worker: a.worker, dispatch: started.dispatchId, launch: a.launch, worktree: path.basename(started.workspace || p.name || p.worktree), ...(notes.length ? { note: notes.join('; ') } : {}) });
  }

  // 4 · Workspaces of cards already in done: nobody will use them again, so they leave Orca now.
  if (!dryRun && fs.existsSync(repoRoot)) {
    const found = findLeftovers({ cwd: repoRoot, board: store.load(file), config });
    // The fake Orca of the tests is not on the shell path that cleanup uses: git removes the worktree.
    const done = applyCleanup(found, { cwd: repoRoot, ...(process.env.FACTORY_ORCA ? { useOrca: false } : {}) });
    for (const p of done.worktrees) events.push({ kind: 'cleaned', path: p, id: found.worktrees.find((w) => w.path === p)?.card });
    for (const note of done.errors) events.push({ kind: 'clean-failed', note });
  }
  return { events };
}

// One line per event, in the coordinator's report style.
export function describe(e) {
  const who = `#${e.id} ${e.lens ? `${e.lane}:${e.lens}` : e.lane ?? ''}`.trim();
  const model = e.launch ? ` (${e.launch.agent}${e.launch.model ? ` ${e.launch.model}` : ''})` : '';
  switch (e.kind) {
    case 'started': return `🚀 ${who} → ${e.worker}${model} ${e.dispatch}`;
    case 'stopped': return `⛔ #${e.id} stopped ${e.worker} (round over)${e.note ? ` · ${e.note}` : ''}`;
    case 'served': return `🖥 web board ${e.note ? `not started · ${e.note}` : 'started in the "Tablero web" terminal'}`;
    case 'released': return `🧹 #${e.id} released ${e.worker}`;
    case 'clean-failed': return `✖ cleanup: ${e.note}`;
    case 'cleaned': return `🧹 #${e.id} removed workspace ${e.path}`;
    case 'failed': return `✖ ${who} ${e.worker}: ${e.note}`;
    case 'skipped': return `· ${who} ${e.worker}: ${e.note}`;
    default: return `${e.kind} ${who} ${e.worker ?? ''}${model}`;
  }
}
