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
    { id: 3, title: 'Mail sender', column: 'building', labels: [], assignee: 'build-3', waitingOn: [], sha: null, lastComment: null, lastMerge: null, from: null, since: new Date(Date.now() - 5 * 60000).toISOString() },
    { id: 4, title: 'Pay', column: 'blocked', labels: ['needs-you', 'merge-approval'], assignee: null, waitingOn: [], sha: 'abc1234def', lastComment: 'listo', lastMerge: 'retenido: toca pagos', from: 'merge', since: null },
    { id: 5, title: 'Money', column: 'blocked', labels: ['needs-you'], assignee: null, waitingOn: [], sha: null, lastComment: '¿Qué moneda usamos?', lastMerge: null, from: 'building', since: null },
    { id: 6, title: 'Login', column: 'review', labels: [], assignee: 'review-qa-6', waitingOn: [], sha: null, lastComment: null, panel: { passed: ['qa', 'code'], total: 4 } }
  ],
  ...extra
})

test('shows the board, what needs a person, and switches repos', async () => {
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop'), board('blog', { cards: [] })] }) } })
  const view = await mount(panel, { host })
  const summary = view.summary()
  const text = summary.join(' ')
  assert.ok(view.find({ text: 'Te esperan' }))
  assert.ok(view.find({ text: 'retenido: toca pagos' }))
  assert.ok(view.find({ text: 'abc1234' }))
  assert.ok(view.find({ text: /¿Qué moneda usamos[?]/ }))
  assert.ok(view.find({ text: /review 2[/]4: qa ✓ code ✓/ }))
  assert.ok(view.find({ text: /review-qa-6 · review/ }))
  assert.ok(view.find({ label: '#3 Mail sender' }))

  await view.post('boards.changed', { boards: [board('shop', { cards: [] })] })
  assert.equal(view.find({ label: '#3 Mail sender' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.equal(view.find({ text: 'Te esperan' }), null)
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

test('Te esperan: approve with the full sha, answer with a comment then a move to where it came from', async () => {
  const sent: [string, any][] = []
  const host = mockHost({ requests: {
    'boards.get': () => ({ boards: [board('shop')] }),
    'card.approve': (i: any) => (sent.push(['approve', i]), {}),
    'card.comment': (i: any) => (sent.push(['comment', i]), {}),
    'card.move': (i: any) => (sent.push(['move', i]), {})
  } })
  const view = await mount(panel, { host })
  await view.press({ text: 'Aprobar y mergear' })
  await view.press({ text: 'Confirmar merge' })
  assert.deepEqual(sent.pop(), ['approve', { board: '/r/shop/.git', id: 4, sha: 'abc1234def' }])
  await assert.rejects(view.press({ text: 'Contestar' }), /disabled/)
  assert.deepEqual(sent, [])
  await view.type({ label: 'Respuesta' }, 'usa X')
  await view.press({ text: 'Contestar' })
  assert.deepEqual(sent.map(([k, i]) => [k, i.text ?? i.column]), [['comment', 'usa X'], ['move', 'building']])
  await view.unmount()
})

test('En curso shows who, lane, since when and panel progress; the search narrows the columns', async () => {
  const host = mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop')] }) } })
  const view = await mount(panel, { host })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.indexOf('Te esperan') < tree.indexOf('"En curso"') && tree.indexOf('"En curso"') < tree.indexOf('"building"'))
  assert.match(tree, /RelativeTime/)
  assert.ok(view.find({ text: /build-3 · building/ }))
  assert.ok(view.find({ text: /review-qa-6 · review · review 2[/]4/ }))
  const lists = () => view.summary().filter((l) => /^List "(building|review|blocked)"/.test(l)).join(' ')
  assert.match(lists(), /building.*review.*blocked/) // empty search: every column
  await view.type({ label: 'Buscar' }, 'LOGIN')
  assert.equal(lists(), 'List "review": 1 item(s)')
  await view.unmount()
  // A card number matches too.
  const byNumber = await mount(panel, { host })
  await byNumber.type({ label: 'Buscar' }, '3')
  assert.deepEqual(byNumber.summary().filter((l) => /^List "building"/.test(l)), ['List "building": 1 item(s)'])
  await byNumber.unmount()
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

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const sheet = (extra: object = {}) => ({
  id: 3, title: 'Mail sender', column: 'building', labels: ['feature'], body: '## Problem\nNo manda correos\n\n## Risk\nLow · solo cliente', lint: [], unmet: [], comments: [], history: [], ...extra
})
const sheetHost = (get: () => object, comment: (i: unknown) => object = () => ({})) =>
  mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop')] }), 'card.get': get, 'card.comment': comment } })

test('a card opens its sheet instead of the list, and Volver returns to it', async () => {
  const host = sheetHost(() => sheet())
  const view = await mount(panel, { host })
  await view.press({ label: '#3 Mail sender' })
  const text = view.summary().join(' ') + JSON.stringify(view.tree())
  assert.match(text, /#3 Mail sender/)
  assert.match(text, /building/)
  assert.match(text, /feature/)
  assert.match(text, /riesgo Low/)
  assert.match(text, /No manda correos/)
  assert.equal(view.find({ label: '#4 Pay' }), null)
  await view.press({ text: 'Volver' })
  assert.ok(view.find({ label: '#4 Pay' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the sheet shows lint, blockers, comments with their age, history and the review panel', async () => {
  const host = sheetHost(() =>
    sheet({
      column: 'review',
      lint: [{ severity: 'error', message: 'falta Risk' }],
      unmet: [2],
      panel: { lenses: { qa: { verdict: 'pass' }, code: { worker: 'review-code-3' } } },
      comments: [{ at: ago(5), role: 'user', text: 'ojo con esto' }],
      history: [{ at: ago(9), from: 'ready', to: 'building', by: 'build-3' }]
    })
  )
  const view = await mount(panel, { host })
  await view.press({ label: '#3 Mail sender' })
  const text = view.summary().join(' ') + JSON.stringify(view.tree())
  assert.match(text, /falta Risk/)
  assert.match(text, /bloqueada por #2/)
  assert.match(text, /ojo con esto/)
  assert.match(text, /ready → building \(build-3\)/)
  assert.match(text, /qa ✓ · code …/)
  assert.match(text, /"RelativeTime","props":{"at":\d+}/)
  await view.unmount()
})

test('Comentar sends one request, keeps the text when it fails, and reloads the sheet when it works', async () => {
  let reply: object = { error: 'card #3 not found' }
  const sent: unknown[] = []
  const host = sheetHost(() => sheet(), (input) => (sent.push(input), reply))
  const view = await mount(panel, { host })
  await view.press({ label: '#3 Mail sender' })
  await view.type({ label: 'Comentario' }, 'hola')
  await view.press({ text: 'Comentar' })
  assert.deepEqual(sent, [{ board: '/r/shop/.git', id: 3, text: 'hola' }])
  assert.match(view.summary().join(' '), /card #3 not found/)
  assert.equal(view.valueOf({ label: 'Comentario' }), 'hola')
  reply = {}
  await view.press({ text: 'Comentar' })
  assert.equal(sent.length, 2)
  assert.equal(view.valueOf({ label: 'Comentario' }), '')
  await view.unmount()
})

test('a failing card.get shows its error and Volver still works', async () => {
  const host = sheetHost(() => ({ error: 'boom' }))
  const view = await mount(panel, { host })
  await view.press({ label: '#3 Mail sender' })
  assert.match(view.summary().join(' '), /boom/)
  await view.press({ text: 'Volver' })
  assert.ok(view.find({ label: '#3 Mail sender' }))
  await view.unmount()
})

const held = (sha = 'abc1234def') => sheet({ column: 'blocked', labels: ['needs-you', 'merge-approval'], run: { branch: 'factory/3-x', reviewedSha: sha } })
const actHost = (extra: Record<string, (i: any) => unknown>, get: () => object = () => sheet()) =>
  mockHost({ requests: { 'boards.get': () => ({ boards: [board('shop')] }), 'card.get': get, ...extra } })
const openSheet = async (host: ReturnType<typeof mockHost>) => {
  const view = await mount(panel, { host })
  await view.press({ label: '#3 Mail sender' })
  return view
}

test('Mover a sends card.move once without force; a refusal shows its message and Forzar is the only way to force', async () => {
  const sent: any[] = []
  let reply: object = { error: 'blocked by #2' }
  const view = await openSheet(actHost({ 'card.move': (i) => (sent.push(i), reply) }))
  await view.select({ label: 'Mover a' }, 'done')
  assert.deepEqual(sent, [{ board: '/r/shop/.git', id: 3, column: 'done' }])
  assert.match(view.summary().join(' '), /blocked by #2/)
  reply = {}
  await view.press({ text: 'Forzar' })
  assert.deepEqual(sent[1], { board: '/r/shop/.git', id: 3, column: 'done', force: true })
  assert.equal(sent.length, 2)
  assert.equal(view.find({ text: 'Forzar' }), null)
  await view.unmount()
})

test('Editar sends title and body and shows them; Cancelar sends nothing', async () => {
  const sent: any[] = []
  let now = sheet()
  const view = await openSheet(actHost({ 'card.edit': (i) => (sent.push(i), (now = sheet({ title: i.title, body: i.body })), {}) }, () => now))
  await view.press({ text: 'Editar' })
  await view.type({ label: 'Título' }, 'Otro')
  await view.press({ text: 'Cancelar' })
  assert.equal(sent.length, 0)
  await view.press({ text: 'Editar' })
  await view.type({ label: 'Título' }, 'Nuevo')
  await view.type({ label: 'Cuerpo' }, 'Cuerpo nuevo')
  await view.press({ text: 'Guardar' })
  assert.deepEqual(sent, [{ board: '/r/shop/.git', id: 3, title: 'Mail senderNuevo', body: sheet().body + 'Cuerpo nuevo' }])
  assert.match(view.summary().join(' ') + JSON.stringify(view.tree()), /#3 Mail senderNuevo[\s\S]*Cuerpo nuevo/)
  await view.unmount()
})

test('Aprobar y mergear needs merge-approval, a branch and a sha, asks first, and reports a status that is not merged', async () => {
  for (const card of [sheet(), held(''), sheet({ labels: ['merge-approval'] })]) {
    const view = await openSheet(actHost({}, () => card))
    assert.equal(view.find({ text: 'Aprobar y mergear' }), null)
    await view.unmount()
  }
  const sent: any[] = []
  const view = await openSheet(actHost({ 'card.approve': (i) => (sent.push(i), { status: 'verify-failed', message: 'npm test falló' }) }, () => held()))
  await view.press({ text: 'Aprobar y mergear' })
  assert.equal(sent.length, 0)
  assert.match(view.summary().join(' '), /factory\/3-x en abc1234d/)
  await view.press({ text: 'Confirmar merge' })
  assert.deepEqual(sent, [{ board: '/r/shop/.git', id: 3, sha: 'abc1234def' }])
  assert.match(view.summary().join(' '), /verify-failed: npm test falló/)
  await view.unmount()
})

test('a CLI error in edit or approve is shown as it came and the sheet stays usable', async () => {
  const view = await openSheet(actHost({ 'card.edit': () => ({ error: 'lint: falta Risk' }), 'card.approve': () => ({ error: 'sha moved' }) }, () => held()))
  await view.press({ text: 'Editar' })
  await view.press({ text: 'Guardar' })
  assert.match(view.summary().join(' '), /lint: falta Risk/)
  assert.ok(view.find({ text: 'Guardar' }))
  await view.press({ text: 'Cancelar' })
  await view.press({ text: 'Aprobar y mergear' })
  await view.press({ text: 'Confirmar merge' })
  assert.match(view.summary().join(' '), /sha moved/)
  assert.ok(view.find({ text: 'Aprobar y mergear' }))
  await view.unmount()
})

const tick = () => new Promise((r) => setTimeout(r, 5))

test('a card.get that arrives late for another card is dropped, and actions use the card shown', { timeout: 5000 }, async () => {
  const sent: any[] = []
  const get = async (i: { id: number }) => {
    if (i.id === 3) await tick(), await tick() // card 3's answer lands after card 4's
    return sheet({ id: i.id, title: i.id === 3 ? 'Mail sender' : 'Pay' })
  }
  const view = await mount(panel, { host: actHost({ 'card.comment': (i) => (sent.push(i), {}) }, get as never) })
  await Promise.all([
    view.press({ label: '#3 Mail sender' }),
    (async () => (await tick(), await view.press({ text: 'Volver' }), await view.press({ label: '#4 Pay' })))()
  ])
  await tick()
  await tick()
  const shown = view.summary().join(' ') + JSON.stringify(view.tree())
  assert.match(shown, /#4 Pay/)
  assert.doesNotMatch(shown, /#3 Mail sender"/)
  await view.type({ label: 'Comentario' }, 'hola')
  await view.press({ text: 'Comentar' })
  assert.equal(sent[0].id, 4)
  await view.unmount()
})

test('an answer for another card than the one open is never shown', { timeout: 5000 }, async () => {
  const view = await mount(panel, { host: actHost({}, () => sheet({ id: 4, title: 'Pay' })) })
  await view.press({ label: '#3 Mail sender' })
  assert.ok(view.find({ text: /Cargando #3/ }))
  assert.equal(view.find({ text: 'Comentar' }), null)
  await view.unmount()
})

test('a button stays off while its request runs, so a double press sends once', { timeout: 5000 }, async () => {
  const sent: any[] = []
  const view = await openSheet(actHost({ 'card.comment': async (i) => (sent.push(i), await tick(), {}) }))
  await view.type({ label: 'Comentario' }, 'hola')
  await Promise.all([view.press({ text: 'Comentar' }), view.press({ text: 'Comentar' })])
  assert.equal(sent.length, 1)
  await view.unmount()
})

const calls: { add: unknown[]; template: number } = { add: [], template: 0 }
const addHost = (add: (i: unknown) => object) => {
  calls.add = []
  calls.template = 0
  return mockHost({
    requests: {
      'boards.get': () => ({ boards: [board('shop')] }),
      'card.add': (i: unknown) => (calls.add.push(i), add(i)),
      'card.template': () => (calls.template++, { template: '## Problem\n<x>' })
    }
  })
}

test('the form is above the columns, and absent without a board', async () => {
  const view = await mount(panel, { host: addHost(() => ({})) })
  assert.ok(view.find({ label: '+ Nueva idea' }))
  assert.ok(view.find({ text: 'Tarjeta completa' }))
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.indexOf('+ Nueva idea') < tree.indexOf('backlog ('), 'the form comes before the first column')
  await view.unmount()
  const none = await mount(panel, { host: mockHost({ requests: { 'boards.get': () => ({ boards: [] }) } }) })
  assert.equal(none.find({ label: '+ Nueva idea' }), null)
  await none.unmount()
})

test('an idea goes to spec as typed, then the field is empty; blank text is not sent', async () => {
  const blank = await mount(panel, { host: addHost(() => ({ id: 9 })) })
  await blank.type({ label: '+ Nueva idea' }, '  \n ')
  await assert.rejects(blank.press({ text: 'Añadir idea' }), /disabled/)
  assert.deepEqual(calls.add, [])
  await blank.unmount()
  const view = await mount(panel, { host: addHost(() => ({ id: 9 })) })
  await view.type({ label: '+ Nueva idea' }, 'Quiero un botón\ncon dos líneas')
  await view.press({ text: 'Añadir idea' })
  assert.deepEqual(calls.add, [{ board: '/r/shop/.git', title: 'Quiero un botón\ncon dos líneas', column: 'spec' }])
  await assert.rejects(view.press({ text: 'Añadir idea' }), /disabled/) // the field is empty again
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a failed idea shows its error and keeps the text', async () => {
  const view = await mount(panel, { host: addHost(() => ({ error: 'sin CLI' })) })
  await view.type({ label: '+ Nueva idea' }, 'x')
  await view.press({ text: 'Añadir idea' })
  assert.ok(JSON.stringify(view.tree()).includes('sin CLI'))
  assert.ok(view.find({ label: '+ Nueva idea' }))
  await view.press({ text: 'Añadir idea' }) // still enabled: the text was kept
  assert.equal(calls.add.length, 2)
  await view.unmount()
})

test('a full card starts from the CLI template, defaults to backlog, and keeps what was typed on error', async () => {
  const lint = 'a new card in ready must pass lint:\n- falta la sección "## Risk"'
  const view = await mount(panel, { host: addHost(() => (calls.add.length === 2 ? { error: lint } : { id: 9 })) })
  await view.press({ text: 'Tarjeta completa' })
  assert.equal(calls.template, 1)
  await view.type({ label: 'Título' }, 'T')
  await view.press({ text: 'Guardar' })
  assert.deepEqual(calls.add[0], { board: '/r/shop/.git', title: 'T', body: '## Problem\n<x>', column: 'backlog' })
  assert.equal(view.find({ label: 'Título' }), null) // closed on success
  await view.press({ text: 'Tarjeta completa' })
  await view.type({ label: 'Título' }, 'T')
  await view.select({ label: 'Guardar en' }, 'ready')
  await view.press({ text: 'Guardar' })
  assert.deepEqual(calls.add[1], { board: '/r/shop/.git', title: 'T', body: '## Problem\n<x>', column: 'ready' })
  assert.ok(JSON.stringify(view.tree()).includes(JSON.stringify(lint).slice(1, -1))) // the whole message, not a cut title
  assert.ok(view.find({ label: 'Título' }))
  await view.press({ text: 'Guardar' }) // corrected: succeeds and closes
  assert.deepEqual(calls.add[2], calls.add[1]) // the title, body and column survived the error
  assert.equal(view.find({ label: 'Título' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
