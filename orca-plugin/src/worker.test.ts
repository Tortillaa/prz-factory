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

// A host whose workspace list the test can change (set), as Orca does when a workspace opens or closes.
function liveHost(open: string[]) {
  const host = mockHost({ results: {} })
  const set = (paths: string[]) =>
    host.respond('workspace.list', { workspaces: paths.map((p, i) => ({ id: `w${i}`, kind: 'worktree', name: 'shop', path: p, branch: 'main', hostId: null })), truncated: false })
  set(open)
  return Object.assign(host, { set })
}
const wait = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
const boardsPosted = (worker: { posts: readonly { event: string }[] }) => worker.posts.filter((p) => p.event === 'boards.changed')

test('workspace.created shows the board of a repo opened after the worker started', async () => {
  const first = repoWithBoard(null)
  const host = liveHost([first])
  const worker = await mountWorker(main, { host })
  const repo = repoWithBoard(cards)
  host.set([first, repo])
  await worker.emit('workspace.created', { workspaceId: 'x', kind: 'worktree', path: repo, branch: 'main' })
  await wait()
  assert.equal(boardsPosted(worker).length, 1)
  assert.equal((boardsPosted(worker)[0].payload as { boards: unknown[] }).boards.length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a board created in a repo that had none shows up without any Orca event', async () => {
  const repo = repoWithBoard(null)
  const worker = await mountWorker(main, { host: liveHost([repo]) })
  fs.mkdirSync(path.join(repo, '.git', 'factory'))
  await wait()
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 2, cards: [cards[0]] }))
  await wait()
  const boards = (boardsPosted(worker).at(-1)?.payload as { boards: { cards: unknown[] }[] }).boards
  assert.equal(boards.length, 1)
  assert.equal(boards[0].cards.length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('workspace.removed closes the watcher of a board, and of a repo still waiting for one', async () => {
  const withBoard = repoWithBoard(cards)
  const without = repoWithBoard(null)
  const host = liveHost([withBoard, without])
  const worker = await mountWorker(main, { host })
  host.set([])
  await worker.emit('workspace.removed', { workspaceId: 'x', kind: 'worktree', path: withBoard })
  await wait()
  const before = boardsPosted(worker).length
  fs.writeFileSync(path.join(withBoard, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  fs.mkdirSync(path.join(without, '.git', 'factory'))
  await wait()
  assert.equal(boardsPosted(worker).length, before)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the manifest listens to workspace.created and workspace.removed', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.contributes.events.map((e: { on: string }) => e.on), ['workspace.created', 'workspace.removed'])
})

test('deactivate closes every watcher: a board and a pending repo stay silent afterwards', async () => {
  const withBoard = repoWithBoard(cards)
  const without = repoWithBoard(null)
  const worker = await mountWorker(main, { host: liveHost([withBoard, without]) })
  await worker.deactivate()
  fs.writeFileSync(path.join(withBoard, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  fs.mkdirSync(path.join(without, '.git', 'factory'))
  await wait()
  assert.equal(boardsPosted(worker).length, 0)
  assert.deepEqual(worker.refusals, [])
})

test('deactivate while a refresh waits for workspace.list opens no watcher and posts nothing', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  // The host answers the next workspace.list by deactivating the worker: the stop lands while snapshot() awaits it.
  host.respond('workspace.list', {
    get workspaces() {
      void worker.deactivate()
      return [{ id: 'w0', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }]
    },
    truncated: false
  })
  await worker.emit('workspace.created', { workspaceId: 'x', kind: 'worktree', path: repo, branch: 'main' })
  await wait(300)
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  await wait()
  assert.equal(boardsPosted(worker).length, 0)
  assert.deepEqual(worker.refusals, [])
})

test('a slow workspace.list that returns after workspace.removed does not bring the closed repo back', async () => {
  const withBoard = repoWithBoard(cards)
  const without = repoWithBoard(null)
  const host = liveHost([withBoard, without])
  const worker = await mountWorker(main, { host })
  // The next workspace.list answers late, with the list it read before the repo closed; the ones after it are empty.
  const late = { workspaces: [withBoard, without].map((p, i) => ({ id: `w${i}`, kind: 'worktree', name: 'shop', path: p, branch: 'main', hostId: null })), truncated: false }
  host.respond('workspace.list', async () => {
    host.set([])
    await wait(800)
    return late
  })
  await worker.emit('workspace.created', { workspaceId: 'x', kind: 'worktree', path: withBoard, branch: 'main' })
  await wait(200)
  await worker.emit('workspace.removed', { workspaceId: 'x', kind: 'worktree', path: withBoard })
  await wait(1200)
  assert.equal((boardsPosted(worker).at(-1)?.payload as { boards: unknown[] }).boards.length, 0)
  const before = boardsPosted(worker).length
  fs.writeFileSync(path.join(withBoard, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  fs.mkdirSync(path.join(without, '.git', 'factory'))
  await wait()
  assert.equal(boardsPosted(worker).length, before)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
