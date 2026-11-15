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
  List,
  Markdown,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { BoardsSnapshot, CardReply, CardView } from './protocol'

const COLUMNS = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'merge', 'blocked', 'done']
/** Columns opened by default: where work is happening or waiting for a person. */
const OPEN = new Set(['spec', 'building', 'qa', 'review', 'merge', 'blocked'])

const snapshot = atom<BoardsSnapshot | null>(null)
const chosen = atom('board', '', { persist: 'plugin' })
/** The open card sheet: which card, what `card.get` returned (or its error), and the comment being written. */
const opened = atom<{ board: string; id: number } | null>(null)
const detail = atom<CardReply | null>(null)
const draft = atom('')
const failure = atom('')

type Sheet = {
  id: number
  title: string
  column: string
  labels: string[]
  body: string
  lint: { severity: string; message: string }[]
  unmet: number[]
  panel?: { lenses?: Record<string, { verdict?: string; worker?: string }> }
  comments: { at: string; role: string; text: string }[]
  history: { at: string; from?: string; to: string; by?: string }[]
}

function open(next: { board: string; id: number } | null): void {
  set(opened, next)
  set(detail, null)
  set(draft, '')
  set(failure, '')
  if (next) void plugin.request('card.get', next).then((card) => set(detail, card))
}

async function comment(at: { board: string; id: number }, text: string): Promise<void> {
  const reply = await plugin.request('card.comment', { ...at, text })
  if (reply.error) return set(failure, reply.error)
  set(failure, '')
  set(draft, '')
  set(detail, await plugin.request('card.get', at))
}

const risk = (body: string) => body.match(/^## Risk\s*\n\s*(\w+)/m)?.[1] ?? 'sin riesgo'
const lensMark = (v?: { verdict?: string; worker?: string }) => (v?.verdict === 'pass' ? '✓' : v?.verdict === 'fail' ? '✖' : v?.worker ? '…' : '·')

function CardSheet({ at }: { at: { board: string; id: number } }) {
  const card = read(detail)
  const text = read(draft)
  const error = read(failure)
  const back = (
    <Button size="sm" variant="ghost" icon="previous" onPress={() => open(null)}>
      Volver
    </Button>
  )
  if (!card) return <Stack gap="md">{back}<Text muted>{`Cargando #${at.id}…`}</Text></Stack>
  if (card.error) return <Stack gap="md">{back}<Callout tone="danger" title={`No se pudo leer #${at.id}: ${card.error}`} /></Stack>
  const c = card as unknown as Sheet
  const lenses = Object.entries(c.panel?.lenses ?? {})
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
      {lenses.length > 0 && <Text>{`Panel de revisión: ${lenses.map(([l, v]) => `${l} ${lensMark(v)}`).join(' · ')}`}</Text>}
      <Markdown content={c.body || '(sin descripción)'} />
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
      {error && <Callout tone="danger" title={`No se pudo comentar: ${error}`} />}
      <Button disabled={!text.trim()} onPress={() => comment(at, text)}>Comentar</Button>
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('boards.changed', (next) => set(snapshot, next)))
  void plugin.request('boards.get').then((next) => set(snapshot, next))
}

function describe(card: CardView): string {
  const parts = [...card.labels]
  if (card.panel) parts.push(`review ${card.panel.passed.length}/${card.panel.total}${card.panel.passed.map((l) => ` ${l} ✓`).join('').replace(/^ /, ': ')}`)
  else if (card.assignee) parts.push(`@${card.assignee}`)
  if (card.waitingOn.length) parts.push(`esperando a ${card.waitingOn.map((d) => `#${d}`).join(' ')}`)
  return parts.join(' · ')
}

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
      {approve.length > 0 && (
        <Callout tone="warning" title="Aprobar merge" icon="warning">
          {approve.map((c) => `#${c.id} ${c.title}: factory merge ${c.id} --sha ${c.sha!.slice(0, 7)} --human`).join(' · ')}
        </Callout>
      )}
      {answer.length > 0 && (
        <Callout tone="warning" title="Contestar" icon="warning">
          {answer.map((c) => `#${c.id} ${c.title}${c.lastComment ? `: ${c.lastComment}` : ''}`).join(' · ')}
        </Callout>
      )}
      {COLUMNS.map((column) => {
        const cards = board.cards.filter((c) => c.column === column)
        return (
          <Collapsible key={column} title={`${column} (${board.counts[column] ?? 0})`} defaultOpen={OPEN.has(column) && cards.length > 0}>
            {cards.length ? (
              <List label={column}>
                {cards.map((c) => (
                  <ListItem key={String(c.id)} title={`#${c.id} ${c.title}`} description={describe(c)} icon={c.assignee ? 'agent' : undefined} onPress={() => open({ board: board.key, id: c.id })} />
                ))}
              </List>
            ) : (
              <Text muted size="xs">Vacía</Text>
            )}
          </Collapsible>
        )
      })}
      {board.unknown.length > 0 && (
        <Collapsible title={`columna desconocida (${board.unknown.length})`} defaultOpen>
          <List label="columna desconocida">
            {board.unknown.map((c) => (
              <ListItem key={String(c.id)} title={`#${c.id} ${c.title} · ${c.column}`} description={describe(c)} />
            ))}
          </List>
        </Collapsible>
      )}
      <Row gap="xs">
        <Badge tone="accent">{`${board.cards.filter((c) => c.assignee).length} en curso`}</Badge>
        <Badge tone="success">{`${board.counts.done ?? 0} hechas`}</Badge>
      </Row>
    </Stack>
  )
}
