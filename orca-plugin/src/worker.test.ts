// Runs src/worker.ts's activate(orca) over a mock host, against real git repos on disk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { discover, readBoard } from './boards'

function repoWithBoard(cards: unknown[] | null) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-')))
  const repo = path.join(dir, 'shop')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  if (cards) {
    fs.mkdirSync(path.join(repo, '.git', 'factory'))
    fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards }))
  }
  return repo
}

const cards = [
  { id: 1, title: 'Login', column: 'done', labels: ['feature'] },
  { id: 2, title: 'Reset password', column: 'ready', labels: [], blockedBy: [1, 3] },
  { id: 3, title: 'Mail sender', column: 'building', assignee: 'build-3' },
  { id: 4, title: 'Pay', column: 'blocked', labels: ['needs-you'] }
]

test('discover finds one board per repo, whatever worktree is open', () => {
  const repo = repoWithBoard(cards)
  const plain = repoWithBoard(null)
  const sub = path.join(repo, 'src')
  fs.mkdirSync(sub)
  const found = discover([repo, sub, plain, path.join(repo, 'missing')])
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'shop')
})

test('readBoard counts columns and lists unmet blockers', () => {
  const [entry] = discover([repoWithBoard(cards)])
  const board = readBoard(entry)
  assert.equal(board.counts.done, 1)
  assert.equal(board.counts.ready, 1)
  assert.deepEqual(board.cards.find((c) => c.id === 2)?.waitingOn, [3])
  assert.equal(board.cards.find((c) => c.id === 3)?.assignee, 'build-3')
})

test('the worker answers the panel with the boards of the open workspaces', async () => {
  const repo = repoWithBoard(cards)
  const host = mockHost({
    results: { 'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const snap = await worker.request('boards.get')
  assert.equal(snap.boards.length, 1, JSON.stringify({ snap, calls: host.calls, refusals: worker.refusals }))
  assert.equal(snap.boards[0].cards.length, 4)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
