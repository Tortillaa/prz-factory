#!/usr/bin/env node
// factory: CLI for the local board. Agents use this instead of editing board.json directly.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as store from '../src/store.mjs';
import { TEMPLATE } from '../src/ticket.mjs';
import { createServer } from '../src/server.mjs';
import { install } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';
import { loadConfig, repoRoot } from '../src/config.mjs';
import { startLane, handoff, verdict } from '../src/lanes.mjs';
import { runVerify, verifySummary } from '../src/verify.mjs';
import { mergeCard } from '../src/merge.mjs';
import * as run from '../src/run.mjs';
import { worktrees } from '../src/git.mjs';
import { findLeftovers, applyCleanup } from '../src/cleanup.mjs';
import { writeBlock } from '../src/agentsmd.mjs';
import { openPr } from '../src/github.mjs';
import { listCases, runCase, DEFAULT_AGENT } from '../src/evals.mjs';

const USAGE = `factory <command> [options]

Board
  serve [--port 4747]                    Open the board at http://localhost:<port>
  add <title> [--body t | --body-file f] [--label l]... [--blocked-by ids] [--column backlog|spec|ready]
      [--source kind:key [--evidence t]]
                                         New card, in backlog by default. --column spec files a rough idea
                                         for the spec writer (free text); ready needs a card that passes lint.
                                         With --source, dedupes by fingerprint: an open twin gets "seen again"
  edit <id> [--title t] [--body t | --body-file f] [--label l]... [--blocked-by ids]
            [--branch b] [--worktree p] [--worker w] [--reviewed-sha s]
                                         --label replaces all labels; --blocked-by "" clears
  list [--column c]                      Cards, grouped by column, in board order
  show <id>                              One card with lint, blockers, comments and history
  move <id> <column> [--before id] [--by who] [--force]
                                         Columns: ${store.COLUMNS.join(', ')}
                                         Ready needs a card that passes lint; leaving Ready
                                         for work needs its blockers done. --force skips both.
  lint [id...]                           Lint cards (default: every backlog and ready card)
  next                                   Ready cards a worker may start now, in order
  comment <id> (<text> | --text-file f) [--role r]
                                         Role defaults to "user"
  claim <id> --as <who> [--lens l]       Fails if someone else holds the card (or that review lens)
  release <id> [--lens l]
  template                               Print the card body template
  path                                   Print the board file location

Lanes (run inside the worker's own worktree)
  start <id> --lane <spec|build|qa|review|merge> [--lens l] --as <who> [--allow-main]
                                         Claim, leave Ready if needed, check out the card's code
                                         (spec: base, detached; build: branch factory/<id>-<slug>;
                                         qa/review/merge: the branch, detached). review needs --lens
  handoff <id> <column> --lane <l> --as <who> (--text t | --text-file f)
                                         Comment + move + release in one write (spec, build, qa, merge)
  verdict <id> --lens <l> --as <who> --sha <head> (--pass [--escalate why] | --fail [--to building|blocked])
          (--text t | --text-file f)     A reviewer's verdict on the head the panel reviews. The verdict
                                         that completes the panel moves the card to merge
  verify                                 Run the config's verify commands here (exit 1 on failure)
  merge <id> [--sha <reviewed>] [--as who] [--human]
                                         Merge gate, for cards in merge. Exit 0 merged · 6 head moved
                                         (back to review) · 7 needs a person · 8 behind base · 9 verify
                                         failed · 10 base checkout dirty · 11 review panel incomplete

Run (the coordinator; it dispatches, never builds)
  plan                                   Next dispatches for the free worker slots, with placement
  spec <id> --lane <l> [--lens l] --as <worker>
                                         The task text for that worker (pipe to --spec-file -)
  dispatched <id> --as <worker> --dispatch <d>
                                         Record the Orca dispatch, only while that worker holds the card
  status                                 Snapshot: columns, in flight (stale claims), needs-you, next
  reclaim <id> [--worker w] [--reason t] Worker ended without a handoff: release it (2nd time: blocked)
  stop [--reason t]                      Release every in-flight card; prints the dispatches to stop
  stopped <id> --dispatch <d>            Forget an orphaned dispatch (status.toStop) once it is stopped in Orca

Setup
  install [target] [--no-hooks]          Copy skills and guard hooks into <target>/.claude, create factory.config.json
  eval [case...] [--agent cmd] [--keep] [--list]
                                         Run skill evals: a real agent on a throwaway repo, graded by checks
  pr <id>                                Push the card's branch and open or update its GitHub PR (optional mirror)
  agents-md [--file f]                   Write the managed prz-factory block into CLAUDE.md (or AGENTS.md)
  cleanup [--apply]                      Worktrees and branches of merged cards, temp verify folders (dry run by default)
  doctor                                 Check node, git, Orca, config, board and skills (exit 1 if any fail)
  version, --version                     Print the installed factory version

  --json   machine-readable output (every command except serve)`;

// A mistyped option is a usage error (exit 64, like an unknown command), not a crash.
function parseOptions(config) {
  try {
    return parseArgs(config);
  } catch (err) {
    if (!err.code?.startsWith('ERR_PARSE_ARGS_')) throw err;
    if (process.argv.includes('--json')) console.log(JSON.stringify({ error: err.message }));
    else console.error(`error: ${err.message}\nrun factory --help for usage`);
    process.exit(64);
  }
}

const { values: opts, positionals } = parseOptions({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    port: { type: 'string', default: process.env.FACTORY_PORT || '4747' },
    title: { type: 'string' },
    body: { type: 'string' },
    'body-file': { type: 'string' },
    label: { type: 'string', multiple: true },
    'blocked-by': { type: 'string' },
    column: { type: 'string' },
    before: { type: 'string' },
    force: { type: 'boolean' },
    by: { type: 'string' },
    role: { type: 'string' },
    as: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    worker: { type: 'string' },
    'reviewed-sha': { type: 'string' },
    lane: { type: 'string' },
    lens: { type: 'string' },
    pass: { type: 'boolean' },
    fail: { type: 'boolean' },
    to: { type: 'string' },
    escalate: { type: 'string' },
    text: { type: 'string' },
    'text-file': { type: 'string' },
    sha: { type: 'string' },
    human: { type: 'boolean' },
    'allow-main': { type: 'boolean' },
    dispatch: { type: 'string' },
    reason: { type: 'string' },
    apply: { type: 'boolean' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    file: { type: 'string' },
    hint: { type: 'boolean' },
    'no-hooks': { type: 'boolean' },
    agent: { type: 'string' },
    keep: { type: 'boolean' },
    list: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
  },
});

const [cmd, ...args] = opts.version ? ['version'] : positionals;
const file = store.resolveBoardPath();

function print(value, text) {
  console.log(opts.json ? JSON.stringify(value, null, 2) : text);
}

function line(c) {
  const labels = c.labels.length ? ` [${c.labels.join(', ')}]` : '';
  const who = c.assignee ? ` @${c.assignee}` : '';
  const deps = c.blockedBy?.length ? ` ⛓ ${c.blockedBy.map((d) => `#${d}`).join(' ')}` : '';
  return `#${c.id} ${c.title}${labels}${who}${deps}`;
}

function lintText(issues) {
  return issues.map((i) => `  ${i.severity === 'error' ? '✖' : '⚠'} ${i.message}`).join('\n');
}

function need(value, name) {
  if (!value) throw new Error(`missing ${name}\n\n${USAGE}`);
  return value;
}

// The person's checkout (first worktree): new worker worktrees are created from that repo.
function mainCheckout() {
  try {
    return worktrees(process.cwd())[0].path;
  } catch {
    return process.cwd(); // not a git repo: the board still works, the git features do not
  }
}

function bodyOpt() {
  if (opts['body-file'] !== undefined) return fs.readFileSync(opts['body-file'], 'utf8');
  return opts.body;
}

function depsOpt() {
  const raw = opts['blocked-by'];
  if (raw === undefined) return undefined;
  return raw.split(/[\s,]+/).filter(Boolean).map((d) => Number(d.replace(/^#/, '')));
}

try {
  switch (cmd) {
    case 'serve': {
      const port = /^\d+$/.test(opts.port) ? Number(opts.port) : NaN;
      if (!(port >= 1 && port <= 65535)) {
        console.error(`error: invalid port "${opts.port}": use a whole number from 1 to 65535 (--port <n> or FACTORY_PORT)`);
        process.exit(1);
      }
      const server = createServer({ boardFile: file, repoRoot: mainCheckout() });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`error: port ${port} is already in use; a board is probably already open at http://localhost:${port} (choose another port with --port <n> or FACTORY_PORT)`);
        } else {
          console.error(`error: ${err.message}`);
        }
        process.exit(1);
      });
      server.listen(port,'127.0.0.1', () => {
        console.log(`board: http://localhost:${port}\nfile:  ${file}`);
      });
      break;
    }
    case 'add': {
      if (opts.source !== undefined) {
        const [kind, ...key] = opts.source.split(':');
        const r = store.update(file, (b) =>
          store.collectCard(b, { title: need(args.join(' '), 'title'), body: bodyOpt(), labels: opts.label, source: { kind, key: key.join(':') }, evidence: opts.evidence }),
        );
        print(r, `${r.status}: ${line(r.card)}${r.previous ? ` (reaparece #${r.previous})` : ''}`);
        break;
      }
      const card = store.update(file, (b) =>
        store.addCard(b, { title: need(args.join(' '), 'title'), body: bodyOpt(), labels: opts.label, blockedBy: depsOpt(), column: opts.column ?? 'backlog' }),
      );
      print(card, `added ${line(card)} → ${card.column}`);
      break;
    }
    case 'edit': {
      const run = { branch: opts.branch, worktree: opts.worktree, worker: opts.worker, reviewedSha: opts['reviewed-sha'], dispatch: opts.dispatch };
      const patch = {
        title: opts.title,
        body: bodyOpt(),
        labels: opts.label,
        blockedBy: depsOpt(),
        run: Object.fromEntries(Object.entries(run).filter(([, v]) => v !== undefined)),
      };
      const card = store.update(file, (b) => store.editCard(b, need(args[0], 'id'), patch));
      print(card, `edited ${line(card)}`);
      break;
    }
    case 'list': {
      const board = store.load(file);
      const cards = opts.column ? board.cards.filter((c) => c.column === opts.column) : board.cards;
      const text = store.COLUMNS.filter((col) => !opts.column || col === opts.column)
        .map((col) => {
          const inCol = cards.filter((c) => c.column === col);
          return `${col.toUpperCase()} (${inCol.length})${inCol.map((c) => `\n  ${line(c)}`).join('')}`;
        })
        .join('\n');
      print(cards, text);
      break;
    }
    case 'show': {
      const card = store.annotate(store.load(file)).cards.find((c) => c.id === Number(need(args[0], 'id')));
      if (!card) throw new Error(`card #${args[0]} not found`);
      const run = Object.entries(card.run).map(([k, v]) => `${k}: ${v}`).join(' · ');
      const comments = card.comments.map((c) => `  [${c.role}] ${c.at}\n    ${c.text}`).join('\n');
      print(
        card,
        [
          line(card),
          `column: ${card.column}${card.unmet.length ? ` · waiting on ${card.unmet.map((d) => `#${d}`).join(', ')}` : ''}`,
          run ? `run: ${run}` : null,
          '',
          card.body || '(no body)',
          '',
          `lint:\n${lintText(card.lint) || '  ✔ ok'}`,
          `comments:\n${comments || '  (none)'}`,
        ]
          .filter((l) => typeof l === 'string')
          .join('\n'),
      );
      break;
    }
    case 'move': {
      const card = store.update(file, (b) =>
        store.moveCard(b, need(args[0], 'id'), need(args[1], 'column'), opts.by ?? null, { before: opts.before ?? null, force: opts.force }),
      );
      print(card, `moved ${line(card)} → ${card.column}`);
      break;
    }
    case 'lint': {
      const board = store.annotate(store.load(file));
      const ids = args.map(Number);
      const cards = ids.length
        ? ids.map((id) => board.cards.find((c) => c.id === id) || (() => { throw new Error(`card #${id} not found`); })())
        : board.cards.filter((c) => ['backlog', 'ready'].includes(c.column));
      const results = cards.map((c) => ({ id: c.id, title: c.title, ok: !store.hasErrors(c.lint), issues: c.lint }));
      print(results, results.map((r) => `${r.ok ? '✔' : '✖'} #${r.id} ${r.title}${r.issues.length ? `\n${lintText(r.issues)}` : ''}`).join('\n') || 'no cards to lint');
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      break;
    }
    case 'next': {
      const queue = store.readyQueue(store.load(file));
      print(queue, queue.map((c) => `${line(c)} → ${c.next}`).join('\n') || 'nothing ready');
      break;
    }
    case 'comment': {
      const card = store.update(file, (b) =>
        store.commentCard(b, need(args[0], 'id'), {
          role: opts.role,
          text: need(opts['text-file'] !== undefined ? fs.readFileSync(opts['text-file'], 'utf8') : args.slice(1).join(' '), 'text'),
        }),
      );
      print(card, `commented on ${line(card)}`);
      break;
    }
    case 'claim': {
      const card = store.update(file, (b) =>
        opts.lens ? store.claimLens(b, need(args[0], 'id'), opts.lens, need(opts.as, '--as')) : store.claimCard(b, need(args[0], 'id'), need(opts.as, '--as')),
      );
      print(card, `claimed ${line(card)}${opts.lens ? ` (lens ${opts.lens})` : ''}`);
      break;
    }
    case 'release': {
      const card = store.update(file, (b) => (opts.lens ? store.releaseLens(b, need(args[0], 'id'), opts.lens) : store.releaseCard(b, need(args[0], 'id'))));
      print(card, `released ${line(card)}`);
      break;
    }
    case 'start': {
      const r = startLane({
        file, id: need(args[0], 'id'), who: opts.as, lane: need(opts.lane, '--lane'), lens: opts.lens ?? null,
        cwd: process.cwd(), config: loadConfig(repoRoot()).config, allowMain: opts['allow-main'],
      });
      print(r, `${r.lane}${r.lens ? ` (${r.lens})` : ''}: ${line(r.card)}\n  ${r.branch ? `branch ${r.branch}` : `base ${r.base}`} @ ${r.head.slice(0, 8)}${r.lane === 'build' ? '' : ' (detached)'}\n  worktree ${r.worktree}`);
      break;
    }
    case 'handoff': {
      const text = opts['text-file'] !== undefined ? fs.readFileSync(opts['text-file'], 'utf8') : opts.text;
      const card = handoff({ file, id: need(args[0], 'id'), to: need(args[1], 'column'), lane: need(opts.lane, '--lane'), who: need(opts.as, '--as'), text });
      print(card, `handed off ${line(card)} → ${card.column}`);
      break;
    }
    case 'verdict': {
      if (!!opts.pass === !!opts.fail) throw new Error('pass exactly one of --pass or --fail');
      const text = opts['text-file'] !== undefined ? fs.readFileSync(opts['text-file'], 'utf8') : opts.text;
      const { config } = loadConfig(repoRoot());
      const id = Number(need(args[0], 'id'));
      const who = need(opts.as, '--as');
      const v = verdict({ file, id, who, lens: need(opts.lens, '--lens'), sha: need(opts.sha, '--sha'), pass: !!opts.pass, to: opts.to, escalate: opts.escalate, text, config });
      const out = { verdict: v.verdict, complete: v.complete, column: v.card.column };
      // The verdict that completes the panel moves the card to merge, where the merge agent lands it.
      const tail = v.complete ? '\npanel complete: the merge agent takes it from here' : v.verdict === 'pass' ? '\npanel still waiting on other lenses' : '';
      print(out, `${v.verdict} recorded on ${line(v.card)} → ${v.card.column}${tail}`);
      break;
    }
    case 'verify': {
      const { config } = loadConfig(repoRoot());
      const r = runVerify(config.verify, process.cwd(), config);
      const failed = r.results.find((x) => !x.ok);
      print(r, verifySummary(r) + (failed ? `\n${failed.output}` : ''));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'merge': {
      const r = mergeCard({
        file, id: Number(need(args[0], 'id')), who: opts.as ?? (opts.human ? 'user' : 'merge-gate'), sha: opts.sha,
        human: opts.human, cwd: process.cwd(), config: loadConfig(repoRoot()).config,
      });
      print(r, `${r.status === 'merged' ? '✅' : '✖'} ${r.status}: ${r.message}`);
      process.exitCode = r.code;
      break;
    }
    case 'plan': {
      const root = mainCheckout();
      const actions = run.plan(store.load(file), loadConfig(root).config, root);
      print(actions, actions.map((a) => `#${a.id} ${(a.lens ? `${a.lane}:${a.lens}` : a.lane).padEnd(15)} as ${a.worker} · ${a.placement.worktree}`).join('\n') || 'nothing to dispatch');
      break;
    }
    case 'spec': {
      const card = store.getCard(store.load(file), need(args[0], 'id'));
      const text = run.spec(card, need(opts.lane, '--lane'), need(opts.as, '--as'), mainCheckout(), opts.lens ?? null);
      print({ spec: text }, text);
      break;
    }
    case 'status': {
      const root = mainCheckout();
      const s = run.status(store.load(file), loadConfig(root).config, root);
      const lines = [
        store.COLUMNS.map((c) => `${c} ${s.counts[c]}`).join(' · '),
        `in flight ${s.inFlight.length}/${typeof s.maxWorkers === 'number' ? s.maxWorkers : Object.entries(s.maxWorkers).map(([a, n]) => `${a} ${n}`).join(' · ')}`,
        ...(s.toStop.length ? ['⛔ to stop (their round is over)', ...s.toStop.map((o) => `  #${o.id} ${o.worker} dispatch ${o.dispatch}`)] : []),
        ...s.inFlight.map((f) => `  #${f.id} ${f.column}${f.lens ? `:${f.lens}` : ''} ${f.worker} ${f.ageMinutes ?? '?'}min${f.stale ? ' ⚠️ stale' : ''}${f.dispatch ? ` dispatch ${f.dispatch}` : ''}`),
        ...(s.approvals.length ? ['🙋 waiting for your approval (web board, or factory merge <id> --sha <sha> --human)', ...s.approvals.map((a) => `  #${a.id} ${a.title} (${a.branch} @ ${(a.sha || '').slice(0, 8)})`)] : []),
        ...s.panels.map((p) => `  review #${p.id}: ${Object.entries(p.lenses).map(([l, v]) => `${l} ${v}`).join(' · ')}`),
        ...(s.needsYou.length ? ['needs you', ...s.needsYou.map((n) => `  #${n.id} ${n.title} (${n.column})`)] : []),
        ...(s.waitingOnDeps.length ? ['waiting on blockers', ...s.waitingOnDeps.map((w) => `  #${w.id} ← ${w.waitingOn.map((d) => `#${d}`).join(' ')}`)] : []),
        `next: ${s.next.map((a) => `#${a.id} ${a.lane}`).join(', ') || 'nothing'}${s.idle ? ' · idle' : ''}`,
      ];
      print(s, lines.join('\n'));
      break;
    }
    case 'stopped': {
      // The coordinator stopped an orphaned worker in Orca: drop it from the list to stop.
      const card = store.update(file, (b) => store.forgetOrphan(b, need(args[0], 'id'), need(opts.dispatch, '--dispatch')));
      print(card, `forgot orphan ${opts.dispatch} of ${line(card)}`);
      break;
    }
    case 'dispatched': {
      const r = store.update(file, (b) => run.recordDispatch(b, need(args[0], 'id'), { worker: need(opts.as, '--as'), dispatch: need(opts.dispatch, '--dispatch') }));
      print(r, r.recorded ? `recorded ${opts.dispatch} on ${line(r.card)}` : `not recorded: ${r.note}`);
      break;
    }
    case 'reclaim': {
      const r = store.update(file, (b) => run.reclaim(b, need(args[0], 'id'), { worker: opts.worker, reason: opts.reason }));
      print(r, `${r.action}${r.lens ? ` (lens ${r.lens})` : ''}: ${line(r.card)}${r.note ? ` (${r.note})` : ''}`);
      break;
    }
    case 'stop': {
      const r = store.update(file, (b) => run.stop(b, opts.reason));
      print(r, r.stopped.map((s) => `released #${s.id}${s.lens ? `:${s.lens}` : ''} from ${s.worker}${s.dispatch ? ` · stop dispatch ${s.dispatch}` : ''}`).join('\n') || 'nothing in flight');
      break;
    }
    case 'cleanup': {
      const root = mainCheckout();
      const found = findLeftovers({ cwd: process.cwd(), board: store.load(file), config: loadConfig(root).config });
      const total = found.worktrees.length + found.branches.length + found.temp.length;
      if (opts.hint) {
        // SessionStart hook: one line of context, and only when there is something to clean.
        if (total) console.log(`prz-factory: ${found.worktrees.length} worktrees y ${found.branches.length} ramas de tarjetas ya mergeadas se pueden limpiar con \`factory cleanup --apply\`.`);
        break;
      }
      if (!opts.apply) {
        const text = [
          ...found.worktrees.map((w) => `worktree ${w.path} (#${w.card}, ${w.reason})`),
          ...found.branches.map((b) => `branch   ${b.branch} (#${b.card})`),
          ...found.temp.map((t) => `temp     ${t}`),
        ].join('\n');
        print(found, text ? `${text}\n\nrun again with --apply to remove them` : 'nothing to clean');
        break;
      }
      const done = applyCleanup(found, { cwd: process.cwd() });
      print(done, [`removed ${done.worktrees.length} worktrees, ${done.branches.length} branches, ${done.temp.length} temp folders`, ...done.errors.map((e) => `✖ ${e}`)].join('\n'));
      if (done.errors.length) process.exitCode = 1;
      break;
    }
    case 'pr': {
      const root = mainCheckout();
      const card = store.getCard(store.load(file), need(args[0], 'id'));
      const r = openPr({ card, cwd: root, config: loadConfig(root).config });
      store.update(file, (bd) => store.editCard(bd, card.id, { run: { pr: r.url } }));
      print(r, `${r.created ? 'opened' : 'updated'} ${r.url}`);
      break;
    }
    case 'eval': {
      if (opts.list) {
        print(listCases(), listCases().join('\n'));
        break;
      }
      const names = args.length ? args : listCases();
      const results = names.map((name) => {
        if (!opts.json) console.error(`… ${name}`);
        return runCase(name, { agent: opts.agent, keep: opts.keep });
      });
      const text = results
        .map((r) => [`${r.ok ? '✔' : '✖'} ${r.case} (${r.seconds}s, agent exit ${r.agentExit})`, ...r.graders.map((g) => `    ${g.ok ? '✔' : '✖'} ${g.grader}: ${g.detail}`), r.kept ? `    kept: ${r.kept}` : null].filter(Boolean).join('\n'))
        .join('\n');
      print(results, text);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      break;
    }
    case 'agents-md': {
      const root = mainCheckout();
      const r = writeBlock(root, loadConfig(root).config, opts.file ? path.resolve(opts.file) : undefined);
      print(r, `${r.status} ${r.file}`);
      break;
    }
    case 'template':
      print({ template: TEMPLATE }, TEMPLATE);
      break;
    case 'version': {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      print({ version: pkg.version }, pkg.version);
      break;
    }
    case 'path':
      print({ file }, file);
      break;
    case 'install': {
      const report = install(args[0] || '.', { hooks: !opts['no-hooks'] });
      const skills = report.skills.map((s) => `  ${s.status.padEnd(9)} ${s.name}${s.reason ? ` (${s.reason})` : ''}`).join('\n');
      const rt = report.runtime;
      const next = rt.status === 'skipped' ? '' : `\n\nNext:\n  1. Commit .claude/, ${path.basename(rt.dir)}/ and factory.config.json (worker worktrees need them).\n  2. Ask your agent: "onboard" (skill factory-onboard): it proves verify and sets the merge policy.\n  3. The CLI is now in the repo: node ${path.basename(rt.dir)}/bin/factory.mjs <command> (or \`factory\` if on PATH).`;
      print(report, `skills → ${report.target}\n${skills}\nruntime: ${rt.status} ${rt.dir}${rt.reason ? ` (${rt.reason})` : ''}\nconfig: ${report.config.status} ${report.config.file}\nhooks: ${report.hooks ? report.hooks.file : 'skipped (--no-hooks)'}${next}`);
      break;
    }
    case 'doctor': {
      const result = doctor();
      const text = result.checks
        .map((c) => `${c.ok ? '✔' : '✖'} ${c.name.padEnd(16)} ${c.detail}${c.fix ? `\n  → ${c.fix}` : ''}`)
        .join('\n');
      print(result, text);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    default:
      console.log(USAGE);
      if (cmd && !opts.help) process.exitCode = 64;
  }
} catch (err) {
  if (opts.json) console.log(JSON.stringify({ error: err.message }));
  else console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
