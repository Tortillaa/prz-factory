// Runs src/worker.ts's activate(orca) over a mock host, against real git repos on disk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
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

test('readBoard puts a card in an unknown column in unknown, not in counts', () => {
  const [entry] = discover([repoWithBoard([cards[0], { id: 5, title: 'Old', column: 'archived' }])])
  const board = readBoard(entry)
  assert.deepEqual(board.unknown.map((c) => c.id), [5])
  assert.equal(board.counts.archived, undefined)
  assert.equal(board.counts.done, 1)
})

test('a broken board.json shows up with an error, next to a healthy repo', async () => {
  const bad = repoWithBoard(cards)
  fs.writeFileSync(path.join(bad, '.git', 'factory', 'board.json'), '{ not json')
  const good = repoWithBoard(cards)
  const host = mockHost({
    results: { 'workspace.list': { workspaces: [bad, good].map((p, i) => ({ id: `w${i}`, kind: 'worktree', name: 'shop', path: p, branch: 'main', hostId: null })), truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const snap = await worker.request('boards.get')
  const broken = snap.boards.find((b) => b.error)
  assert.ok(broken?.error)
  assert.equal(broken.name, 'shop')
  assert.deepEqual(broken.cards, [])
  assert.equal(snap.boards.find((b) => !b.error)?.cards.length, 4)
  await worker.deactivate()
})

for (const [hostId, expected] of [[null, 1], ['local', 1], ['ssh:devbox', 0], ['runtime:x', 0]] as const) {
  test(`the worker answers the panel with the boards of the open workspaces (hostId ${hostId})`, async () => {
    const repo = repoWithBoard(cards)
    const host = mockHost({
      results: { 'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId }], truncated: false } }
    })
    const worker = await mountWorker(main, { host })
    const snap = await worker.request('boards.get')
    assert.equal(snap.boards.length, expected, JSON.stringify({ snap, calls: host.calls, refusals: worker.refusals }))
    if (expected) assert.equal(snap.boards[0].cards.length, 4)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })
}

function hostFor(repo: string) {
  return mockHost({
    results: { 'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }], truncated: false } }
  })
}
const waiting = (host: ReturnType<typeof mockHost>) => host.calls.filter((c) => c.method === 'statusBar.update').map((c) => c.params as Record<string, unknown>)

test('the status bar item shows the blocked cards as soon as the worker mounts', async () => {
  const host = hostFor(repoWithBoard(cards))
  const worker = await mountWorker(main, { host })
  assert.deepEqual(waiting(host)[0], { id: 'waiting', text: '1 te esperan', tone: 'warning', tooltip: waiting(host)[0].tooltip })
  await worker.deactivate()
})

test('the status bar item is neutral when nobody is waiting', async () => {
  const host = hostFor(repoWithBoard(cards.slice(0, 3)))
  const worker = await mountWorker(main, { host })
  assert.equal(waiting(host)[0].text, 'Sin esperas')
  assert.equal(waiting(host)[0].tone, 'neutral')
  await worker.deactivate()
})

test('the status bar item follows the board when a card moves', async () => {
  const repo = repoWithBoard(cards.slice(0, 3))
  const host = hostFor(repo)
  const worker = await mountWorker(main, { host })
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(waiting(host).at(-1)?.text, '1 te esperan')
  await worker.deactivate()
})

test('a failing statusBar.update does not break boards.get', async () => {
  const repo = repoWithBoard(cards)
  const host = mockHost({
    results: { 'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }], truncated: false } },
    requests: { 'statusBar.update': () => { throw hostError('internal', 'boom') } }
  })
  const worker = await mountWorker(main, { host })
  const snap = await worker.request('boards.get')
  assert.equal(snap.boards.length, 1)
  await worker.deactivate()
})

test('the manifest declares the waiting status bar item that keeps the worker alive', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.engines.orca, '>=1.4.248')
  assert.ok(manifest.contributes.statusBarItems.some((item: { id: string }) => item.id === 'waiting'))
})
