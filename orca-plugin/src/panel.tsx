// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  host,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { BoardsSnapshot, CardView } from './protocol'

const COLUMNS = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'merge', 'blocked', 'done']
/** Columns opened by default: where work is happening or waiting for a person. */
const OPEN = new Set(['spec', 'building', 'qa', 'review', 'merge', 'blocked'])

const snapshot = atom<BoardsSnapshot | null>(null)
const chosen = atom('board', '', { persist: 'plugin' })

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('boards.changed', (next) => set(snapshot, next)))
  void plugin.request('boards.get').then((next) => set(snapshot, next))
}

function describe(card: CardView): string {
  const parts = [...card.labels]
  if (card.assignee) parts.push(`@${card.assignee}`)
  if (card.waitingOn.length) parts.push(`waiting on ${card.waitingOn.map((d) => `#${d}`).join(' ')}`)
  return parts.join(' · ')
}

export default function Panel() {
  const snap = read(snapshot)
  const pick = read(chosen)
  if (!snap) return <Text muted>Loading boards…</Text>
  if (snap.error) return <Callout tone="danger" title="Could not read the boards">{snap.error}</Callout>
  if (!snap.boards.length) {
    return (
      <EmptyState title="No factory board" description="Open a repo set up with prz-factory (factory install), or add a card with factory add." icon="layers" />
    )
  }
  const board = snap.boards.find((b) => b.key === pick) ?? snap.boards[0]
  const needsYou = board.cards.filter((c) => c.labels.includes('needs-you'))
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
        <Button size="sm" variant="ghost" icon="open-external" onPress={() => host.call('shell.openExternal', { url: 'http://localhost:4747' })}>
          Web board
        </Button>
      </Row>
      {needsYou.length > 0 && (
        <Callout tone="warning" title={`${needsYou.length} need you`} icon="warning">
          {needsYou.map((c) => `#${c.id} ${c.title}`).join(' · ')}
        </Callout>
      )}
      {COLUMNS.map((column) => {
        const cards = board.cards.filter((c) => c.column === column)
        return (
          <Collapsible key={column} title={`${column} (${board.counts[column] ?? 0})`} defaultOpen={OPEN.has(column) && cards.length > 0}>
            {cards.length ? (
              <List label={column}>
                {cards.map((c) => (
                  <ListItem key={String(c.id)} title={`#${c.id} ${c.title}`} description={describe(c)} icon={c.assignee ? 'agent' : undefined} />
                ))}
              </List>
            ) : (
              <Text muted size="xs">Empty</Text>
            )}
          </Collapsible>
        )
      })}
      <Row gap="xs">
        <Badge tone="accent">{`${board.cards.filter((c) => c.assignee).length} in flight`}</Badge>
        <Badge tone="success">{`${board.counts.done ?? 0} done`}</Badge>
      </Row>
    </Stack>
  )
}
