// The plugin's worker: finds the boards of the repos open in Orca, answers the panel, and
// watches each board's folder so open panels update when a card moves (the CLI, an agent or
// the web board writes the file with an atomic rename, so the folder is what changes).
import fs from 'node:fs'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { discover, readBoard } from './boards'
import type { BoardsSnapshot } from './protocol'

const watchers = new Map<string, fs.FSWatcher>()
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

/** Orca awaits this before it stops the worker. */
export function deactivate(): void {
  stopped = true
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  stopped = false
  let seq = 0 // a newer snapshot supersedes one still waiting for workspace.list
  async function snapshot(): Promise<BoardsSnapshot> {
    const mine = ++seq
    try {
      const { workspaces } = await orca.host.call('workspace.list', {})
      if (stopped) return { boards: [] } // deactivated while the list was in flight: open no watcher
      const pending: string[] = []
      const found = discover(workspaces.filter((w) => !w.hostId || w.hostId === 'local').map((w) => w.path), undefined, pending)
      if (mine === seq) watch([...found.map((b) => path.dirname(b.file)), ...pending])
      const boards = found.flatMap((entry) => {
        try {
          return [readBoard(entry)]
        } catch (err) {
          // mid-write or broken: show the repo with the error instead of dropping it
          return [{ ...entry, counts: {}, cards: [], unknown: [], error: (err as Error).message }]
        }
      })
      if (mine === seq) await showWaiting(boards)
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
        text: n ? `${n} te esperan` : 'Sin esperas',
        tone: n ? 'warning' : 'neutral',
        tooltip: 'Tarjetas de la fábrica en blocked, esperando a una persona'
      })
    } catch {
      // a status bar failure must not break the snapshot
    }
  }

  // One debounced refresh for every trigger: a board change, a new folder, a workspace event.
  function refresh(): void {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const mine = seq + 1
      const snap = await snapshot()
      if (!stopped && mine === seq) orca.panels.post('boards.changed', snap)
    }, 150)
  }

  // Watches exactly `dirs`: opens the new ones, closes those no open workspace needs any more.
  // A repo's common dir is noisy, so only `board.json` and the `factory` folder count.
  function watch(dirs: string[]): void {
    for (const [dir, w] of watchers) {
      if (dirs.includes(dir)) continue
      w.close()
      watchers.delete(dir)
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        watchers.set(dir, fs.watch(dir, (_event, name) => (name === 'board.json' || name === 'factory') && refresh()))
      } catch {
        // folder vanished; the next snapshot drops it
      }
    }
  }

  orca.events.on('workspace.created', refresh)
  orca.events.on('workspace.removed', refresh)
  orca.panels.handle('boards.get', () => snapshot())
  await snapshot()
}
