#!/usr/bin/env node
// factory: CLI for the local board. Agents use this instead of editing board.json directly.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import * as store from '../src/store.mjs';
import { TEMPLATE } from '../src/ticket.mjs';
import { createServer } from '../src/server.mjs';
import { install } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';
import { loadConfig, repoRoot } from '../src/config.mjs';
import { startLane, handoff } from '../src/lanes.mjs';
import { runVerify, verifySummary } from '../src/verify.mjs';
import { mergeCard } from '../src/merge.mjs';
import * as run from '../src/run.mjs';
import { worktrees } from '../src/git.mjs';

const USAGE = `factory <command> [options]

Board
  serve [--port 4747]                    Open the board at http://localhost:<port>
  add <title> [--body t | --body-file f] [--label l]... [--blocked-by ids]
                                         New card in backlog (body defaults to the template)
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
  claim <id> --as <who>                  Fails if someone else holds the card
  release <id>
  template                               Print the card body template
  path                                   Print the board file location

Lanes (run inside the worker's own worktree)
  start <id> --lane <build|qa|review> --as <who> [--allow-main]
                                         Claim, leave Ready if needed, check out the card's code
                                         (build: branch factory/<id>-<slug>; qa/review: detached)
  handoff <id> <column> --lane <l> --as <who> (--text t | --text-file f)
                                         Comment + move + release in one write
  verify                                 Run the config's verify commands here (exit 1 on failure)
  merge <id> --sha <reviewed> [--as who] [--human]
                                         Merge gate. Exit 0 merged · 6 head moved · 7 needs a person
                                         · 8 behind base · 9 verify failed · 10 base checkout dirty

Run (the coordinator; it dispatches, never builds)
  plan                                   Next dispatches for the free worker slots, with placement
  spec <id> --lane <l> --as <worker>     The task text for that worker (pipe to --spec-file -)
  status                                 Snapshot: columns, in flight (stale claims), needs-you, next
  reclaim <id> [--worker w] [--reason t] Worker ended without a handoff: release it (2nd time: blocked)
  stop [--reason t]                      Release every in-flight card; prints the dispatches to stop

Setup
  install [target]                     Copy the skills into <target>/.claude/skills, create factory.config.json
  doctor                                 Check node, git, Orca, config, board and skills (exit 1 if any fail)

  --json   machine-readable output (every command except serve)`;

const { values: opts, positionals } = parseArgs({
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
    text: { type: 'string' },
    'text-file': { type: 'string' },
    sha: { type: 'string' },
    human: { type: 'boolean' },
    'allow-main': { type: 'boolean' },
    dispatch: { type: 'string' },
    reason: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...args] = positionals;
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
  return worktrees(process.cwd())[0].path;
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
      const server = createServer({ boardFile: file });
      server.listen(Number(opts.port), '127.0.0.1', () => {
        console.log(`board: http://localhost:${opts.port}\nfile:  ${file}`);
      });
      break;
    }
    case 'add': {
      const card = store.update(file, (b) =>
        store.addCard(b, { title: need(args.join(' '), 'title'), body: bodyOpt(), labels: opts.label, blockedBy: depsOpt() }),
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
      const card = store.update(file, (b) => store.claimCard(b, need(args[0], 'id'), need(opts.as, '--as')));
      print(card, `claimed ${line(card)}`);
      break;
    }
    case 'release': {
      const card = store.update(file, (b) => store.releaseCard(b, need(args[0], 'id')));
      print(card, `released ${line(card)}`);
      break;
    }
    case 'start': {
      const r = startLane({
        file, id: need(args[0], 'id'), who: opts.as, lane: need(opts.lane, '--lane'),
        cwd: process.cwd(), config: loadConfig(repoRoot()).config, allowMain: opts['allow-main'],
      });
      print(r, `${r.lane}: ${line(r.card)}\n  ${r.branch ? `branch ${r.branch}` : `base ${r.base}`} @ ${r.head.slice(0, 8)}${r.lane === 'build' ? '' : ' (detached)'}\n  worktree ${r.worktree}`);
      break;
    }
    case 'handoff': {
      const text = opts['text-file'] !== undefined ? fs.readFileSync(opts['text-file'], 'utf8') : opts.text;
      const card = handoff({ file, id: need(args[0], 'id'), to: need(args[1], 'column'), lane: need(opts.lane, '--lane'), who: need(opts.as, '--as'), text });
      print(card, `handed off ${line(card)} → ${card.column}`);
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
      print(actions, actions.map((a) => `#${a.id} ${a.lane.padEnd(6)} as ${a.worker} · ${a.placement.worktree}`).join('\n') || 'nothing to dispatch');
      break;
    }
    case 'spec': {
      const card = store.getCard(store.load(file), need(args[0], 'id'));
      const text = run.spec(card, need(opts.lane, '--lane'), need(opts.as, '--as'), mainCheckout());
      print({ spec: text }, text);
      break;
    }
    case 'status': {
      const root = mainCheckout();
      const s = run.status(store.load(file), loadConfig(root).config, root);
      const lines = [
        store.COLUMNS.map((c) => `${c} ${s.counts[c]}`).join(' · '),
        `in flight ${s.inFlight.length}/${s.maxWorkers}`,
        ...s.inFlight.map((f) => `  #${f.id} ${f.column} ${f.worker} ${f.ageMinutes ?? '?'}min${f.stale ? ' ⚠️ stale' : ''}${f.dispatch ? ` dispatch ${f.dispatch}` : ''}`),
        ...(s.needsYou.length ? ['needs you', ...s.needsYou.map((n) => `  #${n.id} ${n.title} (${n.column})`)] : []),
        ...(s.waitingOnDeps.length ? ['waiting on blockers', ...s.waitingOnDeps.map((w) => `  #${w.id} ← ${w.waitingOn.map((d) => `#${d}`).join(' ')}`)] : []),
        `next: ${s.next.map((a) => `#${a.id} ${a.lane}`).join(', ') || 'nothing'}${s.idle ? ' · idle' : ''}`,
      ];
      print(s, lines.join('\n'));
      break;
    }
    case 'reclaim': {
      const r = store.update(file, (b) => run.reclaim(b, need(args[0], 'id'), { worker: opts.worker, reason: opts.reason }));
      print(r, `${r.action}: ${line(r.card)}${r.note ? ` (${r.note})` : ''}`);
      break;
    }
    case 'stop': {
      const r = store.update(file, (b) => run.stop(b, opts.reason));
      print(r, r.stopped.map((s) => `released #${s.id} from ${s.worker}${s.dispatch ? ` · stop dispatch ${s.dispatch}` : ''}`).join('\n') || 'nothing in flight');
      break;
    }
    case 'template':
      print({ template: TEMPLATE }, TEMPLATE);
      break;
    case 'path':
      print({ file }, file);
      break;
    case 'install': {
      const report = install(args[0] || '.');
      const skills = report.skills.map((s) => `  ${s.status.padEnd(9)} ${s.name}${s.reason ? ` (${s.reason})` : ''}`).join('\n');
      print(report, `skills → ${report.target}\n${skills}\nconfig: ${report.config.status} ${report.config.file}`);
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
