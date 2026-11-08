// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// With no workspaces the worker finds no board: that is the empty state.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: { results: { 'workspace.list': { workspaces: [], truncated: false } } }
})
