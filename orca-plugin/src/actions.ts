// The panel's card actions. Each one runs the repo's own factory CLI (`--json`), so lint, blockers and
// the merge gate stay in the CLI; this file only maps a request to arguments. Plain Node, no Orca API.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { CardAction, CardReply } from './protocol'

export function cliOf(repo: string): string | null {
  return [path.join(repo, '.prz-factory', 'bin', 'factory.mjs'), path.join(repo, 'bin', 'factory.mjs')].find((f) => fs.existsSync(f)) ?? null
}

/** Runs the CLI and returns its JSON; a failing exit still carries `{ error }` or a `held` result on stdout. */
function run(cli: string, repo: string, file: string, args: string[]): Promise<CardReply> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args, '--json'], { cwd: repo, env: { ...process.env, FACTORY_BOARD: file }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve({ error: (stdout.trim() || stderr.trim() || err?.message) ?? 'the factory CLI produced no output' })
      }
    })
  })
}

const flags = (flag: string, values: string[] = []) => values.flatMap((v) => [flag, v])

export async function runAction(board: { key: string; file: string }, req: CardAction): Promise<CardReply> {
  const repo = path.dirname(board.key)
  const cli = cliOf(repo)
  if (!cli) return { error: `no factory CLI in ${repo}: expected .prz-factory/bin/factory.mjs or bin/factory.mjs` }
  const go = (args: string[]) => run(cli, repo, board.file, args)
  const id = String('id' in req ? req.id : '')
  const force = 'force' in req && req.force ? ['--force'] : []
  switch (req.action) {
    case 'get':
      return go(['show', id])
    case 'add':
      return go([
        'add', req.title,
        ...(req.body === undefined ? [] : ['--body', req.body]),
        ...flags('--label', req.labels),
        ...(req.blockedBy ? ['--blocked-by', req.blockedBy.join(',')] : []),
        ...(req.column ? ['--column', req.column] : [])
      ])
    case 'edit':
      return go([
        'edit', id,
        ...(req.title === undefined ? [] : ['--title', req.title]),
        ...(req.body === undefined ? [] : ['--body', req.body]),
        ...flags('--label', req.labels),
        ...(req.blockedBy ? ['--blocked-by', req.blockedBy.join(',')] : [])
      ])
    case 'move':
      return go(['move', id, req.column, ...(req.before === undefined ? [] : ['--before', String(req.before)]), '--by', 'user', ...force])
    case 'comment':
      return go(['comment', id, req.text, '--role', 'user'])
    case 'approve': {
      const card = await go(['show', id])
      if ('error' in card) return card
      if (!card.labels?.includes('merge-approval')) return { error: `card #${id} is not waiting for a merge approval` }
      if (!card.run?.branch) return { error: `card #${id} has no branch to merge` }
      if (!req.sha) return { error: 'approving a merge needs the sha the panel shows' }
      return go(['merge', id, '--human', '--as', 'user', '--sha', req.sha])
    }
  }
}
