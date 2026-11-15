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
  cards: [
    { id: 3, title: 'Mail sender', column: 'building', labels: [], assignee: 'build-3', waitingOn: [] },
    { id: 4, title: 'Pay', column: 'blocked', labels: ['needs-you'], assignee: null, waitingOn: [] }
  ],
  ...extra
})

test('shows the board, what needs a person, and switches repos', async () => {
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop'), board('blog', { cards: [] })] }) } })
  const view = await mount(panel, { host })
  const summary = view.summary()
  assert.match(summary.join(' '), /1 need you/)
  assert.ok(view.find({ label: '#3 Mail sender' }))

  await view.post('boards.changed', { boards: [board('shop', { cards: [] })] })
  assert.equal(view.find({ label: '#3 Mail sender' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows a broken board by name, and still shows the healthy one', async () => {
  const bad = board('shop', { cards: [], counts: {}, error: 'Unexpected token' })
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [bad, board('blog')] }) } })
  const view = await mount(panel, { host })
  const text = view.summary().join(' ')
  assert.match(text, /no se pudo leer el tablero de shop: Unexpected token/)
  assert.doesNotMatch(text, /No factory board/)
  await view.unmount()
  const other = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [board('blog'), bad] }) } }) })
  assert.ok(other.find({ label: '#3 Mail sender' }))
  assert.match(other.summary().join(' '), /no se pudo leer el tablero de shop/)
  await other.unmount()
})

test('lists cards in an unknown column apart, with their column', async () => {
  const odd = { id: 9, title: 'Old card', column: 'archived', labels: [], assignee: null, waitingOn: [] }
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop', { unknown: [odd] })] }) } })
  const view = await mount(panel, { host })
  assert.match(view.summary().join(' '), /unknown column/)
  assert.ok(view.find({ label: '#9 Old card · archived' }))
  await view.unmount()
})

test('explains an empty setup and a read error', async () => {
  const empty = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [] }) } }) })
  assert.match(empty.summary().join(' '), /No factory board/)
  await empty.unmount()
  const broken = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [], error: 'boom' }) } }) })
  assert.match(broken.summary().join(' '), /Could not read the boards/)
  await broken.unmount()
})
