// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// With no workspaces the worker finds no board: that is the empty state. `control` is a repo
// whose board has a held merge, a builder, a review with two lenses, a queue and a done card.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { defineCheck } from 'orca/testing'

const now = Date.now()
const at = (min: number) => new Date(now - min * 60_000).toISOString()
const gate = 'Merge para una persona: riesgo high; label auth; diff grande: 477 líneas (máximo 400).\nPara aprobarlo: ejecuta `factory merge 4 --human`.'
const card = (id: number, title: string, column: string, extra: object = {}) => ({ id, title, column, labels: [], comments: [], history: [], ...extra })

const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-check-')), 'shop')
fs.mkdirSync(repo)
execFileSync('git', ['init', '-q'], { cwd: repo })
fs.mkdirSync(path.join(repo, '.git', 'factory'))
fs.writeFileSync(path.join(repo, '.git', 'factory', 'board.json'), JSON.stringify({ version: 1, nextId: 9, cards: [
  card(4, 'Cobro con tarjeta', 'blocked', { labels: ['needs-you', 'merge-approval'], run: { reviewedSha: 'abc1234def' }, comments: [{ role: 'merge', text: gate }], history: [{ at: at(30), from: 'merge', to: 'blocked' }] }),
  card(34, 'Panel con estaciones', 'building', { assignee: 'build-34-r2', claimedAt: at(12) }),
  card(35, 'Alertas del tablero', 'review', { panel: { lenses: { qa: { worker: 'review-qa-35', verdict: 'pass', claimedAt: at(8) }, code: { worker: 'review-code-35', claimedAt: at(5) } } } }),
  card(36, 'Exportar informe', 'ready'),
  card(37, 'Filtros por etiqueta', 'ready', { blockedBy: [36] }),
  card(30, 'Orden de la cola', 'done', { history: [{ at: at(90), from: 'merge', to: 'done' }] })
] }))

export default defineCheck({
  empty: { results: { 'workspace.list': { workspaces: [], truncated: false } } },
  control: { results: { 'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'shop', path: repo, branch: 'main', hostId: null }], truncated: false } } }
})
