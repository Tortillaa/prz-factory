// The panel's card actions. Each one runs the repo's own factory CLI (`--json`), so lint, blockers and
// the merge gate stay in the CLI; this file only maps a request to arguments. Plain Node, no Orca API.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { CardAction, CardReply } from './protocol'

export function cliOf(repo: string): string | null {
  return [path.join(repo, '.prz-factory', 'bin', 'factory.mjs'), path.join(repo, 'bin', 'factory.mjs')].find((f) => fs.existsSync(f)) ?? null
}

/**
 * Runs the CLI and returns its JSON; a failing exit still carries `{ error }` or a `held` result on stdout.
 * Nothing from the request may be read as an option: values go as one `--flag=value` and every free
 * text (id, column, title, text) goes after `--`, so `- item` or `--force` stays text.
 */
function run(cli: string, repo: string, file: string, cmd: string, options: string[], positionals: string[] = []): Promise<CardReply> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, cmd, ...options, '--json', '--', ...positionals], { cwd: repo, env: { ...process.env, FACTORY_BOARD: file }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve({ error: (stdout.trim() || stderr.trim() || err?.message) ?? 'the factory CLI produced no output' })
      }
    })
  })
}

const flags = (flag: string, values: string[] = []) => values.map((v) => `${flag}=${v}`)
const opt = (flag: string, value?: string | number) => (value === undefined ? [] : [`${flag}=${value}`])
const deps = (ids?: number[]) => (ids ? [`--blocked-by=${ids.join(',')}`] : [])

export async function runAction(board: { key: string; file: string }, req: CardAction): Promise<CardReply> {
  const repo = path.dirname(board.key)
  const cli = cliOf(repo)
  if (!cli) return { error: `no factory CLI in ${repo}: expected .prz-factory/bin/factory.mjs or bin/factory.mjs` }
  const go = (cmd: string, options: string[], positionals: string[]) => run(cli, repo, board.file, cmd, options, positionals)
  const id = String('id' in req ? req.id : '')
  const force = 'force' in req && req.force === true ? ['--force'] : []
  switch (req.action) {
    case 'get':
      return go('show', [], [id])
    case 'add':
      return go('add', [...opt('--body', req.body), ...flags('--label', req.labels), ...deps(req.blockedBy), ...opt('--column', req.column)], [req.title])
    case 'edit':
      // the CLI's --label replaces all labels and has no way to say "none": refuse instead of answering OK without doing it
      if (req.labels?.length === 0) return { error: 'the factory CLI cannot clear all labels of a card; send the labels to keep' }
      return go('edit', [...opt('--title', req.title), ...opt('--body', req.body), ...flags('--label', req.labels), ...deps(req.blockedBy)], [id])
    case 'move':
      return go('move', [...opt('--before', req.before), '--by=user', ...force], [id, req.column])
    case 'comment':
      return go('comment', ['--role=user'], [id, req.text])
    case 'approve': {
      const card = await go('show', [], [id])
      if ('error' in card) return card
      if (!card.labels?.includes('merge-approval')) return { error: `card #${id} is not waiting for a merge approval` }
      if (!card.run?.branch) return { error: `card #${id} has no branch to merge` }
      if (!req.sha) return { error: 'approving a merge needs the sha the panel shows' }
      return go('merge', ['--human', '--as=user', `--sha=${req.sha}`], [id])
    }
  }
}
