// Runs the project's verify commands (factory.config.json) in a directory and reports each one.
import { spawnSync } from 'node:child_process';

const TAIL = 4000;

export function runVerify(commands, cwd, { timeoutMinutes = 20 } = {}) {
  if (!commands.length) throw new Error('"verify" is empty in factory.config.json: nothing proves the build');
  const results = [];
  for (const command of commands) {
    const start = Date.now();
    // A whole command line goes through the shell, so "npm test" and "&&" work everywhere.
    const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMinutes * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const code = r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status ?? 1;
    results.push({ command, code, ok: code === 0, ms: Date.now() - start, output: output.length > TAIL ? `…${output.slice(-TAIL)}` : output });
    if (code !== 0) break; // later commands usually depend on earlier ones (lint → test → build)
  }
  return { ok: results.length === commands.length && results.every((r) => r.ok), results };
}

export function verifySummary({ ok, results }) {
  return results.map((r) => `${r.ok ? '✔' : '✖'} ${r.command} (${(r.ms / 1000).toFixed(1)}s${r.ok ? '' : `, exit ${r.code}`})`).join('\n') + (ok ? '' : '\n');
}
