// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { BoardsSnapshot } from './protocol'

const board = (name: string, extra: Partial<BoardsSnapshot['boards'][number]> = {}) => ({
  key: `/r/${name}/.git`,
  name,
  file: `/r/${name}/.git/factory/board.json`,
  counts: { backlog: 0, spec: 0, ready: 0, building: 1, qa: 0, review: 0, merge: 0, blocked: 1, done: 0 },
  unknown: [],
  serve: null as number | null,
  cards: [
    { id: 3, title: 'Mail sender', column: 'building', labels: [], assignee: 'build-3', waitingOn: [], sha: null, lastComment: null },
    { id: 4, title: 'Pay', column: 'blocked', labels: ['needs-you', 'merge-approval'], assignee: null, waitingOn: [], sha: 'abc1234def', lastComment: 'listo' },
    { id: 5, title: 'Money', column: 'blocked', labels: ['needs-you'], assignee: null, waitingOn: [], sha: null, lastComment: '¿Qué moneda usamos?' },
    { id: 6, title: 'Login', column: 'review', labels: [], assignee: 'review-qa-6', waitingOn: [], sha: null, lastComment: null, panel: { passed: ['qa', 'code'], total: 4 } }
  ],
  ...extra
})

test('shows the board, what needs a person, and switches repos', async () => {
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop'), board('blog', { cards: [] })] }) } })
  const view = await mount(panel, { host })
  const summary = view.summary()
  const text = summary.join(' ')
  assert.match(text, /Aprobar merge/)
  assert.match(text, /Contestar/)
  assert.ok(view.find({ text: /#4 Pay: factory merge 4 --sha abc1234 --human/ }))
  assert.ok(view.find({ text: /#5 Money: ¿Qué moneda usamos[?]/ }))
  assert.ok(view.find({ text: /review 2[/]4: qa ✓ code ✓/ }))
  assert.equal(view.find({ text: /review-qa-6/ }), null)
  assert.ok(view.find({ label: '#3 Mail sender' }))

  await view.post('boards.changed', { boards: [board('shop', { cards: [] })] })
  assert.equal(view.find({ label: '#3 Mail sender' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.doesNotMatch(view.summary().join(' '), /Aprobar merge|Contestar/)
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  await view.unmount()
})

test('shows a broken board by name, and still shows the healthy one', async () => {
  const bad = board('shop', { cards: [], counts: {}, error: 'Unexpected token' })
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [bad, board('blog')] }) } })
  const view = await mount(panel, { host })
  const text = view.summary().join(' ')
  assert.match(text, /no se pudo leer el tablero de shop: Unexpected token/)
  assert.doesNotMatch(text, /Sin tablero de la fábrica/)
  await view.unmount()
  const other = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [board('blog'), bad] }) } }) })
  assert.ok(other.find({ label: '#3 Mail sender' }))
  assert.match(other.summary().join(' '), /no se pudo leer el tablero de shop/)
  await other.unmount()
})

test('lists cards in an unknown column apart, with their column', async () => {
  const odd = { id: 9, title: 'Old card', column: 'archived', labels: [], assignee: null, waitingOn: [], sha: null, lastComment: null }
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop', { unknown: [odd] })] }) } })
  const view = await mount(panel, { host })
  assert.match(view.summary().join(' '), /columna desconocida/)
  assert.ok(view.find({ label: '#9 Old card · archived' }))
  await view.unmount()
})

test('explains an empty setup and a read error', async () => {
  const empty = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [] }) } }) })
  assert.match(empty.summary().join(' '), /Sin tablero de la fábrica/)
  await empty.unmount()
  const broken = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [], error: 'boom' }) } }) })
  assert.match(broken.summary().join(' '), /No se pudieron leer los tableros/)
  await broken.unmount()
})

test('Tablero web opens the port each repo serves on, and is replaced by a hint when none runs', async () => {
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop', { serve: 4747 }), board('blog', { serve: 5050 }), board('docs', { serve: null })] }) } })
  const view = await mount(panel, { host })
  await view.press({ text: 'Tablero web' })
  await view.select({ label: 'Repo' }, '/r/blog/.git')
  await view.press({ text: 'Tablero web' })
  await view.select({ label: 'Repo' }, '/r/docs/.git')
  assert.equal(view.find({ text: 'Tablero web' }), null)
  assert.ok(view.find({ text: 'factory serve' }))
  const urls = host.calls.filter((c) => c.method === 'shell.openExternal').map((c) => (c.params as { url: string }).url)
  assert.deepEqual(urls, ['http://localhost:4747', 'http://localhost:5050'])
  await view.unmount()
})
