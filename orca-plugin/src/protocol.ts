// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** Every repo open in Orca that has a prz-factory board, with its cards. */
    'boards.get': { output: BoardsSnapshot }
    /** One card action: the worker runs the repo's factory CLI and returns its JSON (or { error }). */
    'card.get': { input: CardInputs['get']; output: CardReply }
    'card.edit': { input: CardInputs['edit']; output: CardReply }
    'card.move': { input: CardInputs['move']; output: CardReply }
    'card.comment': { input: CardInputs['comment']; output: CardReply }
    'card.approve': { input: CardInputs['approve']; output: CardReply }
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
  /** run.reviewedSha: the commit a held merge would land. */
  sha: string | null
  lastComment: string | null
  /** Text of the last comment by the merge agent: why a merge is held. */
  lastMerge: string | null
  /** The column the card was in before its last move to blocked. */
  from: string | null
  /** ISO time its worker (or its first reviewer) took it. */
  since: string | null
  /** Only in review: lenses that passed, out of the lenses this panel has. */
  panel?: { passed: string[]; total: number }
}

export type BoardView = {
  /** The repo's git common dir: one board per repo, whatever worktree is open. */
  key: string
  name: string
  file: string
  /** Port of this repo's running `factory serve`, or null when none is alive. */
  serve: number | null
  counts: Record<string, number>
  cards: CardView[]
  /** Cards whose column the plugin does not know. */
  unknown: CardView[]
  /** Set when the board file could not be read; then there are no cards. */
  error?: string
}

export type BoardsSnapshot = { boards: BoardView[]; error?: string }

/** What the CLI printed: a card, a merge result, or { error }. */
export type CardReply = { error?: string; labels?: string[]; run?: { branch?: string }; [key: string]: unknown }

/** A card request, as the worker's handlers pass it to src/actions.ts. */
export type CardAction =
  | ({ action: 'get' } & CardInputs['get'])
  | ({ action: 'edit' } & CardInputs['edit'])
  | ({ action: 'move' } & CardInputs['move'])
  | ({ action: 'comment' } & CardInputs['comment'])
  | ({ action: 'approve' } & CardInputs['approve'])

export type CardInputs = {
  get: { board: string; id: number }
  edit: { board: string; id: number; title?: string; body?: string; labels?: string[]; blockedBy?: number[] }
  move: { board: string; id: number; column: string; before?: number; force?: boolean }
  comment: { board: string; id: number; text: string }
  approve: { board: string; id: number; sha?: string }
}
