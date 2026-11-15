// Finds and reads prz-factory boards. Plain Node, no Orca API, so it is tested on its own.
// The board lives at <git common dir>/factory/board.json (shared by all worktrees of a repo);
// this mirrors src/store.mjs#resolveBoardPath in the factory itself.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { BoardView, CardView } from './protocol'

export const COLUMNS = ['backlog', 'spec', 'ready', 'building', 'qa', 'review', 'merge', 'blocked', 'done']

export function commonDir(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/**
 * Unique boards behind a list of workspace paths: [{ key, name, file }]. A repo with no board yet
 * adds the folder to watch for it to `pending`: the common dir, or `factory/` once that exists.
 */
export function discover(paths: string[], resolve: (dir: string) => string | null = commonDir, pending: string[] = []) {
  const seen = new Map<string, { key: string; name: string; file: string }>()
  for (const dir of paths) {
    if (!dir || !fs.existsSync(dir)) continue
    const common = resolve(dir)
    if (!common || seen.has(common)) continue
    const file = path.join(common, 'factory', 'board.json')
    if (!fs.existsSync(file)) {
      const folder = path.dirname(file)
      pending.push(fs.existsSync(folder) ? folder : common)
      continue
    }
    // <repo>/.git → "repo"; a bare or unusual layout falls back to the workspace folder name.
    const name = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(dir)
    seen.set(common, { key: common, name, file })
  }
  return [...seen.values()]
}

type RawCard = {
  id: number
  title: string
  column: string
  labels?: string[]
  assignee?: string | null
  blockedBy?: number[]
  panel?: { lenses?: Record<string, { worker?: string | null }> }
}

export function readBoard(entry: { key: string; name: string; file: string }): BoardView {
  const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8')) as { cards?: RawCard[] }
  const cards = raw.cards ?? []
  const column = new Map(cards.map((c) => [c.id, c.column]))
  const views: CardView[] = cards.map((c) => ({
    id: c.id,
    title: c.title,
    column: c.column,
    labels: c.labels ?? [],
    // A card in review is held by its panel: one reviewer per lens, in parallel.
    assignee: c.assignee ?? reviewers(c),
    waitingOn: (c.blockedBy ?? []).filter((d) => column.get(d) !== 'done')
  }))
  const counts = Object.fromEntries(COLUMNS.map((col) => [col, views.filter((c) => c.column === col).length]))
  return { ...entry, serve: serving(entry.file), counts, cards: views, unknown: views.filter((c) => !COLUMNS.includes(c.column)) }
}

function reviewers(card: RawCard): string | null {
  const names = Object.values(card.panel?.lenses ?? {})
    .map((slot) => slot.worker)
    .filter(Boolean)
  return names.length ? names.join(', ') : null
}

/** Port in serve.json (next to the board) when its process is alive; a crash can leave the file behind. */
export function serving(file: string): number | null {
  try {
    const { port, pid } = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'serve.json'), 'utf8'))
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return null
    process.kill(pid, 0)
    return port
  } catch {
    return null
  }
}
