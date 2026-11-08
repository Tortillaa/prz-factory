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

/** Orca awaits this before it stops the worker. */
export function deactivate(): void {
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

export default function activate(orca: OrcaWorkerApi): void {
  async function snapshot(): Promise<BoardsSnapshot> {
    try {
      const { workspaces } = await orca.host.call('workspace.list', {})
      const found = discover(workspaces.filter((w) => !w.hostId).map((w) => w.path))
      watch(found.map((b) => path.dirname(b.file)))
      const boards = found.flatMap((entry) => {
        try {
          return [readBoard(entry)]
        } catch {
          return [] // mid-write or broken: skip it this round
        }
      })
      return { boards }
    } catch (err) {
      return { boards: [], error: (err as Error).message }
    }
  }

  function watch(dirs: string[]): void {
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        watchers.set(
          dir,
          fs.watch(dir, (_event, name) => {
            if (name && name !== 'board.json') return
            clearTimeout(timer)
            timer = setTimeout(async () => orca.panels.post('boards.changed', await snapshot()), 150)
          })
        )
      } catch {
        // folder vanished; the next snapshot drops it
      }
    }
  }

  orca.panels.handle('boards.get', () => snapshot())
}
