// Runs src/worker.ts's activate(orca) over a mock host, against real git repos on disk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { discover, panelTotal, readBoard } from './boards'

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
  assert.deepEqual(waiting(host)[0], { id: 'waiting', text: '1 te espera', tone: 'warning', tooltip: waiting(host)[0].tooltip })
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
  assert.equal(waiting(host).at(-1)?.text, '1 te espera')
  await worker.deactivate()
})

test('the status bar item uses the plural from two blocked cards', async () => {
  const host = hostFor(repoWithBoard([...cards, { id: 6, title: 'Refund', column: 'blocked' }]))
  const worker = await mountWorker(main, { host })
  assert.equal(waiting(host)[0].text, '2 te esperan')
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

test('a slow boards.get that returns after workspace.removed answers with the newer snapshot', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const late = { workspaces: [{ id: 'w0', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }], truncated: false }
  host.respond('workspace.list', async () => {
    host.set([]) // the next call, from the removal refresh, sees no workspace
    await wait(600)
    return late
  })
  const get = worker.request('boards.get')
  await wait(40)
  await worker.emit('workspace.removed', { workspaceId: 'w0', kind: 'worktree', path: repo })
  const snap = (await get) as { boards: unknown[] }
  assert.equal(snap.boards.length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// workspace.list answers in the order the test releases them, not the order they were asked: each call
// takes the next scripted list and waits for its `release`.
function scriptedList(host: ReturnType<typeof liveHost>, lists: string[][]) {
  const turns = lists.map((paths) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const reply = { workspaces: paths.map((p, i) => ({ id: `w${i}`, kind: 'worktree', name: 'shop', path: p, branch: 'main', hostId: null })), truncated: false }
    return { release, gate, reply }
  })
  let next = 0
  host.respond('workspace.list', async () => {
    const turn = turns[next++]
    await turn.gate
    return turn.reply
  })
  return turns.map((t) => t.release)
}
// A request in flight holds worker.emit back, so mid-request refreshes come from the board file, as in real life.
const touch = (repo: string) => fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards }))
const tick = () => wait(250) // past the 150 ms debounce
const lastPost = (worker: Parameters<typeof boardsPosted>[0]) => (boardsPosted(worker).at(-1)?.payload as { boards: unknown[] } | undefined)?.boards.length

test('arrival order slow-fast: the older list lands last and changes nothing', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const [first, second] = scriptedList(host, [[repo], []])
  const get = worker.request('boards.get') // list 1: still has the repo, slow
  await tick()
  touch(repo) // the repo closed: its list is the empty one
  await tick() // list 2: empty
  second()
  await tick()
  assert.equal(lastPost(worker), 0)
  first()
  assert.equal(((await get) as { boards: unknown[] }).boards.length, 0)
  await tick()
  assert.equal(boardsPosted(worker).length, 1)
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  await tick()
  assert.equal(boardsPosted(worker).length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('arrival order fast-slow: the newer list lands first and the older one waits for it', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const [first, second] = scriptedList(host, [[repo], []])
  const get = worker.request('boards.get')
  await tick()
  touch(repo) // the repo closed: its list is the empty one
  await tick()
  first() // the older list lands first: it must not apply, nor answer yet with its own data
  await tick()
  assert.equal(boardsPosted(worker).length, 0)
  second()
  assert.equal(((await get) as { boards: unknown[] }).boards.length, 0)
  await tick()
  assert.equal(lastPost(worker), 0)
  assert.equal(boardsPosted(worker).length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('three in a chain with workspace.removed in the middle: boards.get, the last post and the watchers agree', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const [one, two, three] = scriptedList(host, [[repo], [repo], []])
  const get = worker.request('boards.get') // 1: slow, repo open
  await tick()
  touch(repo)
  await tick() // 2: slow, repo open
  touch(repo) // the repo closed: its list is the empty one
  await tick() // 3: empty
  three()
  await tick()
  one()
  two()
  assert.equal(((await get) as { boards: unknown[] }).boards.length, 0)
  await tick()
  assert.equal(lastPost(worker), 0)
  const before = boardsPosted(worker).length
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  await tick()
  assert.equal(boardsPosted(worker).length, before)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a refresh superseded by boards.get still posts boards.changed, once', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const [first, second] = scriptedList(host, [[repo], [repo]])
  await worker.emit('workspace.created', { workspaceId: 'x', kind: 'worktree', path: repo, branch: 'main' })
  await tick() // refresh in flight (list 1)
  const get = worker.request('boards.get') // supersedes it (list 2)
  await tick()
  first()
  second()
  assert.equal(((await get) as { boards: unknown[] }).boards.length, 1)
  await tick()
  assert.equal(boardsPosted(worker).length, 1)
  assert.equal(lastPost(worker), 1)
  await worker.deactivate()
})

test('deactivate in the middle: boards.get answers empty, nothing is posted, and a re-mount is not disturbed', async () => {
  const repo = repoWithBoard(cards)
  const host = liveHost([repo])
  const worker = await mountWorker(main, { host })
  const [first] = scriptedList(host, [[repo]])
  const get = worker.request('boards.get')
  await tick()
  const stop = worker.deactivate()
  const again = await mountWorker(main, { host: liveHost([repo]) }) // a new activation shares the watchers map
  first() // the old list lands after the re-mount: it must neither watch nor post
  assert.equal(((await get) as { boards: unknown[] }).boards.length, 0)
  await tick()
  assert.equal(boardsPosted(worker).length, 0)
  fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [] }))
  await tick()
  assert.equal(boardsPosted(worker).length, 0)
  assert.equal(boardsPosted(again).length, 1) // only the new activation watches the repo
  assert.deepEqual(worker.refusals, [])
  await stop
  await again.deactivate()
})

test('readBoard reports serve only for a valid port whose process is alive', () => {
  const [entry] = discover([repoWithBoard(cards)])
  const info = path.join(path.dirname(entry.file), 'serve.json')
  const dead = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim() // exited: pid is gone
  assert.equal(readBoard(entry).serve, null)
  for (const body of [{ port: 5050, pid: Number(dead) }, { port: 0, pid: process.pid }, { port: 'abc', pid: process.pid }, { port: 70000, pid: process.pid }, { port: 5050, pid: 0 }]) {
    fs.writeFileSync(info, JSON.stringify(body))
    assert.equal(readBoard(entry).serve, null, JSON.stringify(body))
  }
  fs.writeFileSync(info, '{ not json')
  assert.equal(readBoard(entry).serve, null)
  fs.writeFileSync(info, JSON.stringify({ port: 5050, pid: process.pid }))
  assert.equal(readBoard(entry).serve, 5050)
})

test('creating and deleting serve.json posts boards.changed with the new serve', async () => {
  const repo = repoWithBoard(cards)
  const worker = await mountWorker(main, { host: liveHost([repo]) })
  const info = path.join(repo, '.git', 'factory', 'serve.json')
  fs.writeFileSync(info, JSON.stringify({ port: 5050, pid: process.pid }))
  await wait()
  assert.equal((boardsPosted(worker).at(-1)?.payload as { boards: { serve: number | null }[] }).boards[0].serve, 5050)
  fs.rmSync(info)
  await wait()
  assert.equal((boardsPosted(worker).at(-1)?.payload as { boards: { serve: number | null }[] }).boards[0].serve, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const risk = (level: string) => '## Risk' + String.fromCharCode(10) + level + ' · x'

// Same table as test/panel-total.test.mjs, where lensesFor gives these totals: the plugin cannot import src/.
test('panelTotal gives the totals lensesFor gives', () => {
  const nl = String.fromCharCode(10)
  const r = (...levels: string[]) => levels.map((l) => '## Risk' + nl + l + ' · y').join(nl)
  const full = { review: { lenses: ['qa', 'security', 'code', 'ops'], light: ['qa', 'code'] }, merge: { humanLabels: ['auth', 'needs-human'] } }
  const noLight = { ...full, review: { ...full.review, light: [] } }
  const cases: [string, string, string[], typeof full, number][] = [
    ['Low then High', r('Low', 'High'), [], full, 4],
    ['High then Low', r('High', 'Low'), [], full, 2],
    ['trailing spaces and CRLF', '## Risk   \r\nLow · x\r\n', [], full, 2],
    ['emoji', r('🟢 Low'), [], full, 2],
    ['bold', r('**Low**'), [], full, 2],
    ['Medium', r('Medium'), [], full, 4],
    ['no Risk section', '## Fix\nx', [], full, 4],
    ['Low with auth', r('Low'), ['auth'], full, 4],
    ['Low with needs-human', r('Low'), ['needs-human'], full, 4],
    ['Low with empty light', r('Low'), [], noLight, 4],
  ]
  for (const [name, body, labels, config, total] of cases) {
    assert.equal(panelTotal({ id: 1, body, labels }, config), total, name)
  }
})

test('readBoard gives the review progress by the lenses of factory.config.json, and falls back without it', () => {
  const lenses = { qa: { worker: 'review-qa-7', verdict: 'pass' }, code: { verdict: 'pass' }, security: { worker: 'review-security-7' } }
  const card = (body: string) => ({ id: 7, title: 'R', column: 'review', labels: [], body, panel: { lenses }, run: { reviewedSha: 'abc1234def' }, comments: [{ text: 'hola' }, { text: '¿Qué moneda?' }] })
  const repo = repoWithBoard([card(risk('High')), { ...card(risk('Low')), id: 8 }])
  const [entry] = discover([repo])
  const none = readBoard(entry).cards[0]
  assert.deepEqual(none.panel, { passed: ['qa', 'code'], total: 3 })
  assert.equal(none.sha, 'abc1234def')
  assert.equal(none.lastComment, '¿Qué moneda?')
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify({ review: { lenses: ['qa', 'security', 'code', 'ops'], light: ['qa', 'code'] }, merge: { humanLabels: ['auth'] } }))
  const [high, low] = readBoard(entry).cards
  assert.equal(high.panel?.total, 4)
  assert.equal(low.panel?.total, 2)
  // Keys the file leaves out take the defaults of loadConfig: Low light panel of 2; a business label means the full 4.
  fs.writeFileSync(path.join(repo, 'factory.config.json'), '{}')
  assert.deepEqual(readBoard(entry).cards.map((c) => c.panel?.total), [4, 2])
  fs.writeFileSync(path.join(repo, 'factory.config.json'), JSON.stringify({ review: { light: ['qa', 'code'] } }))
  assert.equal(readBoard(entry).cards[1].panel?.total, 2)
  fs.writeFileSync(path.join(repo, 'factory.config.json'), '{ broken')
  assert.equal(readBoard(entry).cards[0].panel?.total, 3)
})

// A fake CLI: dumps argv, cwd and FACTORY_BOARD to a log, then answers like the real one (JSON on stdout).
const FAKE = `
import fs from 'node:fs'
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, cwd: process.cwd(), board: process.env.FACTORY_BOARD }) + '\\n')
if (a.includes('--fail')) { console.log(JSON.stringify({ error: 'nope: "quoted"' })); process.exit(1) }
if (a[0] === 'show') console.log(JSON.stringify(JSON.parse(process.env.FAKE_CARD || '{"id":7,"labels":[],"run":{}}')))
else console.log(JSON.stringify({ ok: a[0] }))
`

async function actionWorker(layout: 'prz' | 'bin' | 'both' | 'none', card?: unknown) {
  const repo = repoWithBoard(cards)
  const log = path.join(repo, 'fake.log')
  process.env.FAKE_LOG = log
  process.env.FAKE_CARD = card ? JSON.stringify(card) : ''
  for (const dir of layout === 'both' ? ['.prz-factory', '.'] : layout === 'prz' ? ['.prz-factory'] : layout === 'bin' ? ['.'] : []) {
    fs.mkdirSync(path.join(repo, dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(repo, dir, 'bin', 'factory.mjs'), dir === '.' ? FAKE.replace("{ ok: a[0] }", "{ ok: a[0], from: 'bin' }") : FAKE)
  }
  const worker = await mountWorker(main, { host: hostFor(repo) })
  const key = (await worker.request('boards.get')).boards[0].key
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { worker, key, repo, calls, boardFile: path.join(repo, '.git', 'factory', 'board.json') }
}

test('card.get/add/edit/move/comment run the CLI with the exact arguments, in the repo, on its board', async () => {
  const t = await actionWorker('prz')
  const before = fs.readFileSync(t.boardFile, 'utf8')
  const b = t.key
  assert.deepEqual(await t.worker.request('card.get', { board: b, id: 7 }), { id: 7, labels: [], run: {} })
  assert.deepEqual(await t.worker.request('card.add', { board: b, title: 'T', body: 'B', labels: ['x', 'y'], blockedBy: [1, 2], column: 'spec' }), { ok: 'add' })
  assert.deepEqual(await t.worker.request('card.edit', { board: b, id: 7, title: 'T2', body: 'B2', labels: ['z'], blockedBy: [3] }), { ok: 'edit' })
  assert.deepEqual(await t.worker.request('card.move', { board: b, id: 7, column: 'ready', before: 4 }), { ok: 'move' })
  assert.deepEqual(await t.worker.request('card.comment', { board: b, id: 7, text: 'hola' }), { ok: 'comment' })
  const got = t.calls()
  assert.deepEqual(got.map((c) => c.argv), [
    ['show', '--json', '--', '7'],
    ['add', '--body=B', '--label=x', '--label=y', '--blocked-by=1,2', '--column=spec', '--json', '--', 'T'],
    ['edit', '--title=T2', '--body=B2', '--label=z', '--blocked-by=3', '--json', '--', '7'],
    ['move', '--before=4', '--by=user', '--json', '--', '7', 'ready'],
    ['comment', '--role=user', '--json', '--', '7', 'hola']
  ])
  for (const c of got) {
    assert.equal(fs.realpathSync(c.cwd), t.repo)
    assert.equal(c.board, t.boardFile)
  }
  assert.equal(fs.readFileSync(t.boardFile, 'utf8'), before)
  await t.worker.deactivate()
})

test('card.move passes --force only when asked, and a CLI error comes back unchanged', async () => {
  const t = await actionWorker('prz')
  await t.worker.request('card.move', { board: t.key, id: 7, column: 'ready', force: false })
  await t.worker.request('card.move', { board: t.key, id: 7, column: 'ready', force: true })
  assert.ok(!t.calls()[0].argv.includes('--force'))
  assert.ok(t.calls()[1].argv.includes('--force'))
  // a malformed request is not a force
  for (const force of ['false', 1, 'true']) {
    await t.worker.request('card.move', { board: t.key, id: 7, column: 'ready', force } as never)
    assert.ok(!t.calls().at(-1)!.argv.includes('--force'))
  }
  // the fake fails on "--fail": the CLI fails on this text
  assert.deepEqual(await t.worker.request('card.comment', { board: t.key, id: 7, text: '--fail' }), { error: 'nope: "quoted"' })
  await t.worker.deactivate()
})

test('the CLI is .prz-factory/bin first, then bin, and no CLI is an error that says so', async () => {
  const both = await actionWorker('both')
  await both.worker.request('card.comment', { board: both.key, id: 1, text: 'a' })
  assert.deepEqual((await both.worker.request('card.add', { board: both.key, title: 't' })), { ok: 'add' }) // .prz-factory's answer has no `from`
  await both.worker.deactivate()
  const bin = await actionWorker('bin')
  assert.deepEqual(await bin.worker.request('card.add', { board: bin.key, title: 't' }), { ok: 'add', from: 'bin' })
  await bin.worker.deactivate()
  const none = await actionWorker('none')
  const reply = await none.worker.request('card.get', { board: none.key, id: 1 })
  assert.match(String(reply.error), /bin\/factory\.mjs/)
  assert.deepEqual(await none.worker.request('card.get', { board: '/nowhere/.git', id: 1 }), { error: 'unknown board /nowhere/.git' })
  await none.worker.deactivate()
})

test('card.approve needs merge-approval, a branch and a sha before the CLI sees a merge', async () => {
  const held = { id: 7, labels: ['merge-approval'], run: { branch: 'factory/7-x', reviewedSha: 'abc' } }
  for (const [card, sha] of [[{ id: 7, labels: [], run: { branch: 'b' } }, 'abc'], [{ id: 7, labels: ['merge-approval'], run: {} }, 'abc'], [held, undefined]] as const) {
    const t = await actionWorker('prz', card)
    assert.ok((await t.worker.request('card.approve', { board: t.key, id: 7, sha })).error)
    assert.ok(t.calls().every((c) => c.argv[0] !== 'merge'))
    await t.worker.deactivate()
  }
  const t = await actionWorker('prz', held)
  assert.deepEqual(await t.worker.request('card.approve', { board: t.key, id: 7, sha: 'abc' }), { ok: 'merge' })
  assert.deepEqual(t.calls().at(-1)?.argv, ['merge', '--human', '--as=user', '--sha=abc', '--json', '--', '7'])
  await t.worker.deactivate()
})

test('a text with spaces, quotes, $() and ; reaches the CLI as one argument', async () => {
  const t = await actionWorker('prz')
  const text = `a b "c" 'd' $(touch pwned); echo \`x\` & y`
  await t.worker.request('card.comment', { board: t.key, id: 7, text })
  assert.equal(t.calls()[0].argv.at(-1), text)
  assert.ok(!fs.existsSync(path.join(t.repo, 'pwned')))
  await t.worker.deactivate()
})

test('free text that looks like an option stays text, after `--` or inside a --flag=value', async () => {
  const t = await actionWorker('prz')
  for (const text of ['- item', '--text-file=x', '--force']) {
    await t.worker.request('card.comment', { board: t.key, id: 7, text })
    await t.worker.request('card.add', { board: t.key, title: text, body: text })
    await t.worker.request('card.edit', { board: t.key, id: 7, title: text, body: text })
  }
  const calls = t.calls()
  assert.equal(calls.length, 9)
  for (const { argv } of calls) {
    const stop = argv.indexOf('--')
    assert.ok(stop > argv.indexOf('--json'), '--json comes before --')
    // before `--` only the command and --flag=value: a text there is always glued to its flag
    for (const a of argv.slice(1, stop)) assert.match(a, /^--(json|role=user|body=.*|title=.*)$/)
  }
  assert.deepEqual(calls.filter((c) => c.argv[0] === 'comment').map((c) => c.argv.at(-1)), ['- item', '--text-file=x', '--force'])
  assert.deepEqual(calls.filter((c) => c.argv[0] === 'add').map((c) => c.argv.at(-1)), ['- item', '--text-file=x', '--force'])
  await t.worker.deactivate()
})

test('card.edit with labels [] is an error, never an OK that cleared nothing', async () => {
  const t = await actionWorker('prz')
  assert.match(String((await t.worker.request('card.edit', { board: t.key, id: 7, labels: [] })).error), /labels/)
  assert.deepEqual(t.calls(), [])
  await t.worker.request('card.edit', { board: t.key, id: 7, blockedBy: [] })
  assert.ok(t.calls()[0].argv.includes('--blocked-by='))
  await t.worker.deactivate()
})

test('card.template runs `template --json` in the repo, and an unknown board or a CLI failure comes back as an error', async () => {
  const t = await actionWorker('prz')
  assert.deepEqual(await t.worker.request('card.template', { board: t.key }), { ok: 'template' })
  const [call] = t.calls()
  assert.deepEqual(call.argv, ['template', '--json', '--'])
  assert.equal(fs.realpathSync(call.cwd), t.repo)
  assert.deepEqual(await t.worker.request('card.template', { board: '/nowhere/.git' }), { error: 'unknown board /nowhere/.git' })
  await t.worker.deactivate()
  const none = await actionWorker('none')
  assert.match(String((await none.worker.request('card.template', { board: none.key })).error), /bin\/factory\.mjs/)
  await none.worker.deactivate()
})
