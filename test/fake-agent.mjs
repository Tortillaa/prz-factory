// A stand-in for a coding agent, for testing the eval harness without an LLM. Reads the worker
// spec on stdin and does what a good build worker would do, through the real CLI.
// FAKE_AGENT=noop does nothing (a failing run).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'factory.mjs');
const factory = (...args) => execFileSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8' });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_AGENT === 'noop') process.exit(0);

const [, id, lane, worker] = prompt.match(/factory start (\d+) --lane (\w+) --as (\S+)/);
if (lane !== 'build') throw new Error(`fake agent only builds, got ${lane}`);

factory('start', id, '--lane', 'build', '--as', worker);
fs.writeFileSync('src/cart.mjs', 'export function average(prices) {\n  if (prices.length === 0) return 0;\n  return prices.reduce((sum, p) => sum + p, 0) / prices.length;\n}\n');
fs.writeFileSync('test/cart-empty.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { average } from '../src/cart.mjs';\ntest('empty', () => assert.equal(average([]), 0));\n");
git('add', '-A');
git('-c', 'user.email=fake@example.com', '-c', 'user.name=fake', 'commit', '-qm', `🐛 [fix] cart: empty cart average is 0

- guard for an empty list
Card: #${id}`);
factory('verify');
factory('handoff', id, 'review', '--lane', 'build', '--as', worker, '--text', '[build] ✅ built · round 1\nAC1 AC2 AC3 test/cart-empty.test.mjs');
console.log('done');
