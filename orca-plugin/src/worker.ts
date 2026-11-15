// The plugin's worker: finds the boards of the repos open in Orca, answers the panel, and
// watches each board's folder so open panels update when a card moves (the CLI, an agent or
// the web board writes the file with an atomic rename, so the folder is what changes).
import fs from 'node:fs'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { discover, readBoard } from './boards'
import { runAction } from './actions'
import type { BoardsSnapshot, CardAction, CardInputs } from './protocol'

const watchers = new Map<string, fs.FSWatcher>()
let timer: ReturnType<typeof setTimeout> | undefined
let life = 0 // bumped by activate and deactivate: an activation is dead once it no longer matches

/** Orca awaits this before it stops the worker. */
export function deactivate(): void {
  life++
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const born = ++life
  const dead = () => born !== life
  // One state, "the newest snapshot": only it applies anything (watchers, status bar, boards.changed),
  // and a call that was superseded answers with that newest one, never with its own older read.
  let seq = 0
  let latest: Promise<BoardsSnapshot> = Promise.resolve({ boards: [] })
  let owed = false // a board or workspace change wants a boards.changed from the next snapshot that applies
  function snapshot(): Promise<BoardsSnapshot> {
    if (dead()) return Promise.resolve({ boards: [] })
    const mine = ++seq
    const run = read(mine).then((snap) => {
      if (dead()) return { boards: [] }
      if (mine !== seq) return latest // never itself: a superseded call is not the newest
      if (owed) {
        owed = false
        orca.panels.post('boards.changed', snap)
      }
      return snap
    })
    latest = run
    return run
  }
  async function read(mine: number): Promise<BoardsSnapshot> {
    try {
      const { workspaces } = await orca.host.call('workspace.list', {})
      const current = () => !dead() && mine === seq
      const pending: string[] = []
      const found = discover(workspaces.filter((w) => !w.hostId || w.hostId === 'local').map((w) => w.path), undefined, pending)
      if (current()) watch([...found.map((b) => path.dirname(b.file)), ...pending])
      const boards = found.flatMap((entry) => {
        try {
          return [readBoard(entry)]
        } catch (err) {
          // mid-write or broken: show the repo with the error instead of dropping it
          return [{ ...entry, serve: null, counts: {}, cards: [], unknown: [], error: (err as Error).message }]
        }
      })
      if (current()) await showWaiting(boards)
      return { boards }
    } catch (err) {
      return { boards: [], error: (err as Error).message }
    }
  }

  // The status bar item keeps this worker alive (Orca reaps an idle one, and the watchers with it).
  async function showWaiting(boards: BoardsSnapshot['boards']): Promise<void> {
    const n = boards.reduce((sum, b) => sum + (b.counts.blocked ?? 0), 0)
    try {
      await orca.host.call('statusBar.update', {
        id: 'waiting',
        text: n ? `${n} ${n === 1 ? 'te espera' : 'te esperan'}` : 'Sin esperas',
        tone: n ? 'warning' : 'neutral',
        tooltip: 'Tarjetas de la fábrica en blocked, esperando a una persona'
      })
    } catch {
      // a status bar failure must not break the snapshot
    }
  }

  // One debounced refresh for every trigger: a board change, a new folder, a workspace event.
  function refresh(): void {
    if (dead()) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      owed = true
      void snapshot()
    }, 150)
  }

  // Watches exactly `dirs`: opens the new ones, closes those no open workspace needs any more.
  // A repo's common dir is noisy, so only `board.json`, `serve.json` and the `factory` folder count.
  function watch(dirs: string[]): void {
    for (const [dir, w] of watchers) {
      if (dirs.includes(dir)) continue
      w.close()
      watchers.delete(dir)
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        watchers.set(dir, fs.watch(dir, (_event, name) => (name === 'board.json' || name === 'serve.json' || name === 'factory') && refresh()))
      } catch {
        // folder vanished; the next snapshot drops it
      }
    }
  }

  orca.events.on('workspace.created', refresh)
  orca.events.on('workspace.removed', refresh)
  orca.panels.handle('boards.get', () => snapshot())
  // Card actions: the board key must be one this worker lists; the repo's own CLI applies every rule.
  async function act(action: CardAction['action'], input: CardInputs[CardAction['action']]) {
    const board = (await snapshot()).boards.find((b) => b.key === input.board)
    return board ? runAction(board, { action, ...input } as CardAction) : { error: `unknown board ${input.board}` }
  }
  orca.panels.handle('card.get', (input) => act('get', input))
  orca.panels.handle('card.add', (input) => act('add', input))
  orca.panels.handle('card.edit', (input) => act('edit', input))
  orca.panels.handle('card.move', (input) => act('move', input))
  orca.panels.handle('card.comment', (input) => act('comment', input))
  orca.panels.handle('card.approve', (input) => act('approve', input))
  orca.panels.handle('card.template', (input) => act('template', input))
  await snapshot()
}
