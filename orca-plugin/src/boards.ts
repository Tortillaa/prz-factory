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
  body?: string
  run?: { reviewedSha?: string | null }
  claimedAt?: string | null
  history?: { at?: string; from?: string; to: string }[]
  comments?: { role?: string; text: string }[]
  panel?: { lenses?: Record<string, { worker?: string | null; verdict?: string | null; claimedAt?: string | null }> }
}

type Config = { review?: { lenses?: string[]; light?: string[] }; merge?: { humanLabels?: string[] } }

// Mirrors lensesFor/riskLevel (src/lanes.mjs, src/ticket.mjs): the plugin ships apart from the factory.
export function panelTotal(card: RawCard, config: Config | null): number {
  const slots = Object.keys(card.panel?.lenses ?? {})
  if (!config) return slots.length
  // Keys the file leaves out take loadConfig's defaults (src/config.mjs).
  const lenses = config.review?.lenses ?? ['qa', 'security', 'code', 'ops']
  const light = (config.review?.light ?? ['qa', 'code']).filter((l) => lenses.includes(l))
  const human = config.merge?.humanLabels ?? ['auth', 'payments', 'pricing', 'schema', 'ops', 'money', 'needs-human']
  // Like parseSections: the last "## Risk" wins; the section runs to the next "## " heading.
  let risk = ''
  let inRisk = false
  for (const line of (card.body ?? '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { inRisk = h[1].toLowerCase() === 'risk'; if (inRisk) risk = '' }
    else if (inRisk) risk += line + '\n'
  }
  const low = /^(🟢|🟡|🔴|\*\*)?\s*\**\s*(low|bajo)\b/i.test(risk.trim())
  const business = (card.labels ?? []).some((l) => human.includes(l))
  return light.length && low && !business ? light.length : lenses.length
}

export function readBoard(entry: { key: string; name: string; file: string }): BoardView {
  const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8')) as { cards?: RawCard[] }
  const cards = raw.cards ?? []
  // <repo>/.git/factory/board.json → <repo>/factory.config.json; a missing or broken file is no config.
  let config: Config | null = null
  try {
    config = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(entry.file))), 'factory.config.json'), 'utf8'))
  } catch {}
  const column = new Map(cards.map((c) => [c.id, c.column]))
  const views: CardView[] = cards.map((c) => ({
    id: c.id,
    title: c.title,
    column: c.column,
    labels: c.labels ?? [],
    // A card in review is held by its panel: one reviewer per lens, in parallel.
    assignee: c.assignee ?? reviewers(c),
    workers: [...new Set([c.assignee, ...Object.values(c.panel?.lenses ?? {}).map((s) => s.worker)].filter((w): w is string => !!w))],
    doneAt: c.history?.findLast((h) => h.to === 'done')?.at ?? null,
    waitingOn: (c.blockedBy ?? []).filter((d) => column.get(d) !== 'done'),
    sha: c.run?.reviewedSha ?? null,
    lastComment: c.comments?.at(-1)?.text.trim() ?? null,
    lastMerge: c.comments?.findLast((m) => m.role === 'merge')?.text.trim() ?? null,
    from: c.history?.findLast((h) => h.to === 'blocked')?.from ?? null,
    since: c.claimedAt ?? Object.values(c.panel?.lenses ?? {}).map((s) => s.claimedAt).filter(Boolean).sort()[0] ?? null,
    ...(c.column === 'review' && {
      panel: {
        passed: Object.entries(c.panel?.lenses ?? {}).filter(([, s]) => s.verdict === 'pass').map(([l]) => l),
        total: panelTotal(c, config),
        lenses: Object.entries(c.panel?.lenses ?? {}).map(([lens, s]) => ({ lens, state: s.verdict === 'pass' ? 'pass' : s.verdict === 'fail' ? 'fail' : s.worker ? 'working' : 'pending' }) as const)
      }
    })
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
