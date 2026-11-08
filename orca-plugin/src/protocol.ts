// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** Every repo open in Orca that has a prz-factory board, with its cards. */
    'boards.get': { output: BoardsSnapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when a board file changes. */
    'boards.changed': BoardsSnapshot
  }
}

export type CardView = {
  id: number
  title: string
  column: string
  labels: string[]
  assignee: string | null
  waitingOn: number[]
}

export type BoardView = {
  /** The repo's git common dir: one board per repo, whatever worktree is open. */
  key: string
  name: string
  file: string
  counts: Record<string, number>
  cards: CardView[]
}

export type BoardsSnapshot = { boards: BoardView[]; error?: string }
