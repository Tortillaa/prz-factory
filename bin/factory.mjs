#!/usr/bin/env node
// factory: CLI for the local board. Agents use this instead of editing board.json directly.
import { parseArgs } from 'node:util';
import * as store from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { install } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';

const USAGE = `factory <command> [options]

  serve [--port 4747]                    Open the board at http://localhost:<port>
  add <title> [--body t] [--label l]... [--column c]
  list [--column c]                      Cards, grouped by column
  show <id>                              One card with comments and history
  move <id> <column> [--by who]          Columns: ${store.COLUMNS.join(', ')}
  comment <id> <text> [--role r]         Role defaults to "user"
  claim <id> --as <who>                  Fails if someone else holds the card
  release <id>
  path                                   Print the board file location
  install [target]                       Copy the skills into <target>/.claude/skills, create factory.config.json
  doctor                                 Check node, git, Orca, config, board and skills (exit 1 if any fail)

  --json   machine-readable output (every command except serve)`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    port: { type: 'string', default: process.env.FACTORY_PORT || '4747' },
    body: { type: 'string' },
    label: { type: 'string', multiple: true },
    column: { type: 'string' },
    by: { type: 'string' },
    role: { type: 'string' },
    as: { type: 'string' },
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
  return `#${c.id} ${c.title}${labels}${who}`;
}

function need(value, name) {
  if (!value) throw new Error(`missing ${name}\n\n${USAGE}`);
  return value;
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
        store.addCard(b, { title: need(args.join(' '), 'title'), body: opts.body, labels: opts.label, column: opts.column }),
      );
      print(card, `added ${line(card)} → ${card.column}`);
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
      const card = store.getCard(store.load(file), need(args[0], 'id'));
      const comments = card.comments.map((c) => `  [${c.role}] ${c.at}\n    ${c.text}`).join('\n');
      print(card, `${line(card)}\ncolumn: ${card.column}\n\n${card.body || '(no body)'}\n\ncomments:\n${comments || '  (none)'}`);
      break;
    }
    case 'move': {
      const card = store.update(file, (b) => store.moveCard(b, need(args[0], 'id'), need(args[1], 'column'), opts.by ?? null));
      print(card, `moved ${line(card)} → ${card.column}`);
      break;
    }
    case 'comment': {
      const card = store.update(file, (b) =>
        store.commentCard(b, need(args[0], 'id'), { role: opts.role, text: need(args.slice(1).join(' '), 'text') }),
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
