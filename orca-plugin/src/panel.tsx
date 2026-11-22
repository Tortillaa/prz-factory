// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  host,
  Input,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Text,
  Textarea,
  type PanelContext,
  update
} from 'orca'
import type { BoardsSnapshot, CardReply, CardView } from './protocol'

const COLUMNS = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'merge', 'blocked', 'done']

const snapshot = atom<BoardsSnapshot | null>(null)
const chosen = atom('board', '', { persist: 'plugin' })
/** The open card sheet: which card, what `card.get` returned (or its error), and the comment being written. */
const opened = atom<{ board: string; id: number } | null>(null)
const detail = atom<CardReply | null>(null)
const draft = atom('')
const failure = atom('')
/** What the sheet is doing: a refused move (to offer Forzar), the edit in progress, an approval awaiting confirmation, its result. */
const refused = atom<{ column: string; message: string } | null>(null)
const editing = atom<{ title: string; body: string } | null>(null)
const confirming = atom(false)
const outcome = atom<{ merged: boolean; text: string } | null>(null)
/** Actions in flight on this sheet: each button is disabled while its own request runs. */
const busy = atom<string[]>([])
/** The cover: the card whose approval awaits confirmation, answers being typed, and the last worker error. */
const approving = atom<string | null>(null)
const replies = atom<Record<string, string>>({})
/** Cover state is per repo and card: two repos can both have a #5. */
const slot = (board: string, id: number) => `${board}#${id}`
const coverError = atom('')

/** Cover actions show the worker's error as it came. */
async function cover(run: () => Promise<CardReply[]>): Promise<boolean> {
  const failed = (await run()).find((r) => r.error)
  set(coverError, failed?.error ?? '')
  return !failed
}

const approveCard = (board: string, c: CardView) =>
  cover(async () => [await plugin.request('card.approve', { board, id: c.id, sha: c.sha! })]).then(() => set(approving, null))

async function answerCard(board: string, c: CardView, text: string): Promise<void> {
  const sent = await plugin.request('card.comment', { board, id: c.id, text: text.trim() })
  if (sent.error) return void set(coverError, sent.error)
  if (await cover(async () => [await plugin.request('card.move', { board, id: c.id, column: c.from ?? 'spec' })])) update(replies, (now) => ({ ...now, [slot(board, c.id)]: '' }))
}

const ago = (iso: string | null) => (iso ? <RelativeTime at={Date.parse(iso)} /> : null)

type Sheet = {
  id: number
  title: string
  column: string
  labels: string[]
  body: string
  run?: { branch?: string; reviewedSha?: string }
  lint: { severity: string; message: string }[]
  unmet: number[]
  panel?: { lenses?: Record<string, { verdict?: string; worker?: string }> }
  comments: { at: string; role: string; text: string }[]
  history: { at: string; from?: string; to: string; by?: string }[]
}

type At = { board: string; id: number }
// A late answer must not land on another card: `sheetGen` changes with the open card, `loadGen` with every card.get.
let sheetGen = 0
let loadGen = 0
let pending = new Set<string>()

function load(at: At): Promise<void> {
  const [sheet, mine] = [sheetGen, ++loadGen]
  return plugin.request('card.get', at).then((card) => {
    if (sheet !== sheetGen || mine !== loadGen || (!card.error && card.id !== at.id)) return
    set(detail, card)
  })
}

function open(next: At | null): void {
  sheetGen++
  pending = new Set()
  set(opened, next)
  set(detail, null)
  set(draft, '')
  set(failure, '')
  set(refused, null)
  set(editing, null)
  set(confirming, false)
  set(outcome, null)
  set(busy, [])
  if (next) void load(next)
}

/** Runs one request of the sheet at a time per button; `live()` is false once another card is open. */
async function act(name: string, run: (live: () => boolean) => Promise<void>): Promise<void> {
  const [mine, sheet] = [pending, sheetGen]
  if (mine.has(name)) return
  mine.add(name)
  set(busy, [...mine])
  try {
    await run(() => sheet === sheetGen)
  } finally {
    mine.delete(name)
    if (mine === pending) set(busy, [...mine])
  }
}

const comment = (at: At, text: string) =>
  act('comment', async (live) => {
    const reply = await plugin.request('card.comment', { ...at, text })
    if (!live()) return
    if (reply.error) return set(failure, `No se pudo comentar: ${reply.error}`)
    set(failure, '')
    set(draft, '')
    await load(at)
  })

const move = (at: At, column: string, force?: true) =>
  act('move', async (live) => {
    const reply = await plugin.request('card.move', force ? { ...at, column, force } : { ...at, column })
    if (!live()) return
    set(refused, reply.error ? { column, message: reply.error } : null)
    if (!reply.error) await load(at)
  })

const save = (at: At, edit: { title: string; body: string }) =>
  act('save', async (live) => {
    const reply = await plugin.request('card.edit', { ...at, ...edit })
    if (!live()) return
    if (reply.error) return set(failure, `No se pudo guardar: ${reply.error}`)
    set(failure, '')
    set(editing, null)
    await load(at)
  })

const approve = (at: At, sha: string) =>
  act('approve', async (live) => {
    const reply = await plugin.request('card.approve', { ...at, sha })
    if (!live()) return
    set(confirming, false)
    if (reply.error) return set(failure, `No se pudo mergear: ${reply.error}`)
    set(failure, '')
    set(outcome, { merged: reply.status === 'merged', text: `${reply.status}: ${reply.message}` })
    await load(at)
  })

const risk = (body: string) => body.match(/^## Risk\s*\n\s*(\w+)/m)?.[1] ?? 'sin riesgo'

function CardSheet({ at }: { at: { board: string; id: number } }) {
  const card = read(detail)
  const text = read(draft)
  const error = read(failure)
  const working = read(busy)
  const refusal = read(refused)
  const edit = read(editing)
  const confirm = read(confirming)
  const result = read(outcome)
  const back = (
    <Button size="sm" variant="ghost" icon="previous" onPress={() => open(null)}>
      Volver
    </Button>
  )
  if (!card) return <Stack gap="md">{back}<Text muted>{`Cargando #${at.id}…`}</Text></Stack>
  if (card.error) return <Stack gap="md">{back}<Callout tone="danger" title={`No se pudo leer #${at.id}: ${card.error}`} /></Stack>
  const c = card as unknown as Sheet
  const lenses = Object.entries(c.panel?.lenses ?? {})
  const sha = c.run?.reviewedSha
  const canApprove = c.labels.includes('merge-approval') && !!c.run?.branch && !!sha
  return (
    <Stack gap="md">
      {back}
      <Text weight="semibold">{`#${c.id} ${c.title}`}</Text>
      <Row gap="xs" wrap>
        <Badge>{c.column}</Badge>
        {c.labels.map((l) => <Badge key={l} tone="accent">{l}</Badge>)}
        <Badge>{`riesgo ${risk(c.body)}`}</Badge>
        {c.unmet.map((d) => <Badge key={String(d)} tone="warning">{`bloqueada por #${d}`}</Badge>)}
      </Row>
      {c.column !== 'spec' && c.lint.map((i, n) => <Callout key={String(n)} tone={i.severity === 'error' ? 'danger' : 'warning'} title={i.message} />)}
      <Rail column={c.column} from={c.history.findLast((h) => h.to === 'blocked')?.from ?? null} lenses={lenses.map(([lens, v]) => ({ lens, state: v.verdict === 'pass' ? 'pass' : v.verdict === 'fail' ? 'fail' : v.worker ? 'working' : 'pending' }))} />
      {edit ? (
        <Stack gap="sm">
          <Input label="Título" value={edit.title} onChange={(v) => set(editing, { ...edit, title: v })} />
          <Textarea label="Cuerpo" value={edit.body} rows={12} onChange={(v) => set(editing, { ...edit, body: v })} />
          <Row gap="xs">
            <Button disabled={working.includes('save')} onPress={() => save(at, edit)}>Guardar</Button>
            <Button variant="ghost" onPress={() => (set(editing, null), set(failure, ''))}>Cancelar</Button>
          </Row>
        </Stack>
      ) : (
        <>
          <Markdown content={c.body || '(sin descripción)'} />
          <Row gap="xs">
            <Button size="sm" variant="ghost" onPress={() => set(editing, { title: c.title, body: c.body })}>Editar</Button>
            <Select label="Mover a" value={c.column} options={COLUMNS.map((value) => ({ value, label: value }))} disabled={working.includes('move')} onChange={(column) => column !== c.column && move(at, column)} />
          </Row>
        </>
      )}
      {refusal && (
        <Callout tone="danger" title={`No se pudo mover a ${refusal.column}: ${refusal.message}`}>
          <Button size="sm" disabled={working.includes('move')} onPress={() => move(at, refusal.column, true)}>Forzar</Button>
        </Callout>
      )}
      {canApprove && !confirm && <Button variant="ghost" onPress={() => set(confirming, true)}>Aprobar y mergear</Button>}
      {canApprove && confirm && (
        <Callout tone="warning" title={`¿Has revisado ${c.run!.branch} en ${sha!.slice(0, 8)}? El merge gate ejecutará verify y, si pasa, la mergeará en la rama base.`}>
          <Row gap="xs">
            <Button disabled={working.includes('approve')} onPress={() => approve(at, sha!)}>Confirmar merge</Button>
            <Button variant="ghost" onPress={() => set(confirming, false)}>Cancelar</Button>
          </Row>
        </Callout>
      )}
      {result && <Callout tone={result.merged ? 'success' : 'warning'} title={result.text} />}
      <Collapsible title={`Comentarios (${c.comments.length})`} defaultOpen>
        {c.comments.map((m, n) => (
          <Card key={String(n)} title={`[${m.role}]`}>
            <RelativeTime at={Date.parse(m.at)} />
            <Text>{m.text}</Text>
          </Card>
        ))}
      </Collapsible>
      <Collapsible title={`Historial (${c.history.length})`}>
        {c.history.map((h, n) => <Text key={String(n)} size="xs">{`${h.from ? `${h.from} → ` : ''}${h.to}${h.by ? ` (${h.by})` : ''}`}</Text>)}
      </Collapsible>
      <Textarea label="Comentario" value={text} onChange={(v) => set(draft, v)} />
      {error && <Callout tone="danger" title={error} />}
      <Button disabled={!text.trim() || working.includes('comment')} onPress={() => comment(at, text)}>Comentar</Button>
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('boards.changed', (next) => set(snapshot, next)))
  void plugin.request('boards.get').then((next) => set(snapshot, next))
}


const STATIONS = ['spec', 'build', 'review', 'merge']
const STATION_OF: Record<string, string> = { spec: 'spec', ready: 'build', building: 'build', qa: 'review', review: 'review', merge: 'merge' }
const MARK = { pass: '✓', fail: '✖', working: 'en curso', pending: 'en espera' }

/** The rail of stations on one line: the card's station in strong text (a blocked card sits where it was blocked from) and, in review, each lens with its state. */
function Rail({ column, from, lenses = [] }: { column: string; from: string | null; lenses?: NonNullable<CardView['panel']>['lenses'] }) {
  const at = STATION_OF[column === 'blocked' ? from ?? '' : column]
  return (
    <Row gap="xs" wrap>
      {STATIONS.map((s, i) => <Text key={s} size="xs" muted={s !== at} weight={s === at ? 'semibold' : 'regular'}>{i < STATIONS.length - 1 ? `${s} ·` : s}</Text>)}
      {at === 'review' && lenses.length > 0 && <Text size="xs" muted>{`${lenses.map((l) => `${l.lens} ${MARK[l.state]}`).join(' · ')}`}</Text>}
    </Row>
  )
}

// Array.from counts code points, so an emoji is never cut in half.
const clip = (s: string, max = 60) => {
  const cs = Array.from(s)
  return cs.length > max ? `${cs.slice(0, max - 1).join('')}…` : s
}

/** A worker name (build-34-r2, review-qa-7) in words; mirrors roleOf in public/board-view.mjs. */
function role(worker: string): string {
  const m = /^(spec|build|merge|review)-(?:([^-\d][^-]*)-)?\d+(?:-r(\d+))?$/.exec(worker)
  if (!m) return worker
  const name = { spec: 'Spec Writer', build: 'Builder', merge: 'Agente de merge', review: `Reviewer${m[2] ? ` ${m[2]}` : ''}` }[m[1]]
  return m[3] ? `${name} · ronda ${m[3]}` : name!
}

/** Why the gate held a merge, as short phrases; without the gate's line, the comment as it came. */
function reasons(c: CardView): string[] {
  const prefix = 'Merge para una persona:'
  const line = c.lastMerge?.split('\n').find((l) => l.startsWith(prefix))
  return line ? line.slice(prefix.length).trim().replace(/\.$/, '').split('; ') : [c.lastMerge ?? c.lastComment ?? ''].filter(Boolean)
}

const dependsOn = (c: CardView) => (c.waitingOn.length ? `espera a ${c.waitingOn.map((d) => `#${d}`).join(' ')}` : c.column)

export default function Panel() {
  const snap = read(snapshot)
  const pick = read(chosen)
  if (!snap) return <Text muted>Cargando tableros…</Text>
  if (snap.error) return <Callout tone="danger" title="No se pudieron leer los tableros">{snap.error}</Callout>
  if (!snap.boards.length) {
    return (
      <EmptyState title="Sin tablero de la fábrica" description="Abre un repo con prz-factory (factory install) o añade una tarjeta con factory add." icon="layers" />
    )
  }
  const board = snap.boards.find((b) => b.key === pick) ?? snap.boards[0]
  const at = read(opened)
  if (at) return <CardSheet at={at} />
  const approve = board.cards.filter((c) => c.labels.includes('merge-approval') && c.sha)
  const answer = board.cards.filter((c) => c.labels.includes('needs-you') && !c.labels.includes('merge-approval'))
  const asking = new Set([...approve, ...answer])
  const running = board.cards.filter((c) => !asking.has(c) && c.column !== 'done' && c.workers.length)
  const rank = (c: CardView) => ({ ready: 0, spec: 1 })[c.column] ?? 2
  const queue = board.cards
    .filter((c) => !asking.has(c) && !running.includes(c) && c.column !== 'done' && c.column !== 'backlog' && !board.unknown.includes(c))
    .map((c, i) => [c, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([c]) => c)
  const done = board.cards.filter((c) => c.column === 'done').sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')).slice(0, 5)
  const [confirmId, typed, coverErr] = [read(approving), read(replies), read(coverError)]
  // The whole row opens the sheet; its title is one clipped line.
  const item = (c: CardView, title: string, children: unknown) => (
    <ListItem key={String(c.id)} title={clip(title)} onPress={() => open({ board: board.key, id: c.id })}>{children as never}</ListItem>
  )
  return (
    <Stack gap="md">
      {snap.boards.length > 1 && (
        <Select
          label="Repo"
          value={board.key}
          options={snap.boards.map((b) => ({ value: b.key, label: b.name }))}
          onChange={(value) => set(chosen, value)}
        />
      )}
      <Row justify="between">
        <Text weight="semibold">{board.name}</Text>
        {board.serve ? (
          <Button size="sm" variant="ghost" icon="open-external" onPress={() => host.call('shell.openExternal', { url: `http://localhost:${board.serve}` })}>
            Tablero web
          </Button>
        ) : (
          <Text muted>factory serve</Text>
        )}
      </Row>
      {snap.boards.filter((b) => b.error).map((b) => (
        <Callout key={b.key} tone="danger" title={`no se pudo leer el tablero de ${b.name}: ${b.error}`} />
      ))}
      {coverErr && <Callout tone="danger" title={coverErr} />}
      {asking.size > 0 && (
        <Stack gap="sm">
          <Text weight="semibold">Te esperan</Text>
          {approve.map((c) => (
            <Callout key={String(c.id)} tone="warning" title={`Aprobar #${c.id} ${c.title}`}>
              {reasons(c).map((r) => <Text key={r}>{r}</Text>)}
              <Text muted size="xs">{c.sha!.slice(0, 7)}</Text>
              {confirmId === slot(board.key, c.id) ? (
                <Row gap="xs">
                  <Button onPress={() => approveCard(board.key, c)}>Confirmar merge</Button>
                  <Button variant="ghost" onPress={() => set(approving, null)}>Cancelar</Button>
                </Row>
              ) : (
                <Button variant="ghost" onPress={() => set(approving, slot(board.key, c.id))}>Aprobar y mergear</Button>
              )}
            </Callout>
          ))}
          {answer.map((c) => (
            <Callout key={String(c.id)} tone="warning" title={`Contestar #${c.id} ${c.title}`}>
              <Text>{c.lastComment ?? ''}</Text>
              <Textarea label="Respuesta" value={typed[slot(board.key, c.id)] ?? ''} onChange={(v) => update(replies, (all) => ({ ...all, [slot(board.key, c.id)]: v }))} />
              <Button disabled={!(typed[slot(board.key, c.id)] ?? '').trim()} onPress={() => answerCard(board.key, c, typed[slot(board.key, c.id)])}>Contestar</Button>
            </Callout>
          ))}
        </Stack>
      )}
      {running.length > 0 && (
        <Stack gap="sm">
          <Text weight="semibold">En marcha</Text>
          <List label="En marcha">{running.map((c) => item(c, `#${c.id} ${c.title}`, <><Rail column={c.column} from={c.from} lenses={c.panel?.lenses} /><Row gap="xs"><Text size="xs" muted>{c.workers.map(role).join(' · ')}</Text>{ago(c.since)}</Row></>))}</List>
        </Stack>
      )}
      {queue.length > 0 && (
        <Stack gap="sm">
          <Text weight="semibold">Cola</Text>
          <List label="Cola">{queue.map((c, n) => item(c, `${n + 1} · #${c.id} ${c.title}`, <Text size="xs" muted>{dependsOn(c)}</Text>))}</List>
        </Stack>
      )}
      {done.length > 0 && (
        <Stack gap="sm">
          <Text weight="semibold">Hecho</Text>
          <List label="Hecho">{done.map((c) => item(c, `#${c.id} ${c.title}`, ago(c.doneAt)))}</List>
        </Stack>
      )}
      {board.unknown.length > 0 && (
        <Stack gap="sm">
          <Text weight="semibold">Columna desconocida</Text>
          {board.unknown.map((c) => <Text key={String(c.id)}>{`#${c.id} ${c.title} · ${c.column}`}</Text>)}
        </Stack>
      )}
      <Text muted>Pide cambios al agente de Orca</Text>
    </Stack>
  )
}
