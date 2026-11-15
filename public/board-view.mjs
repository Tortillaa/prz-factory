// Pure view logic of the board page: which zone a card belongs to and where it sits on the rail.
// Loaded by index.html as a module and by the tests from Node, so it touches no DOM.

export const STATIONS = ['spec', 'build', 'review', 'merge'];
const STATION_OF = { spec: 'spec', ready: 'build', building: 'build', qa: 'review', review: 'review', merge: 'merge' };

const lensWorkers = (c) => Object.values(c.panel?.lenses || {}).map((l) => l.worker).filter(Boolean);
const hasClaim = (c) => Boolean(c.assignee) || lensWorkers(c).length > 0;
const lastAt = (c) => c.history?.at(-1)?.at ?? c.updatedAt ?? '';
const isRequest = (c) => c.column === 'blocked' && (c.labels.includes('needs-you') || c.labels.includes('merge-approval'));

export function groupBoard(state) {
  const cards = state.cards;
  const waiting = cards.filter(isRequest);
  const inFlight = cards.filter((c) => !isRequest(c) && c.column !== 'done' && hasClaim(c));
  const placed = new Set([...waiting, ...inFlight]);
  const rest = cards.filter((c) => !placed.has(c) && c.column !== 'done' && c.column !== 'backlog');
  const rank = (c) => ({ ready: 0, spec: 1 })[c.column] ?? 2; // then what waits on dependencies, or on a free worker
  const queue = rest.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
  const done = cards.filter((c) => c.column === 'done').sort((a, b) => lastAt(b).localeCompare(lastAt(a))).slice(0, 10);
  return { waiting, inFlight, queue, done, backlog: cards.filter((c) => c.column === 'backlog') };
}

// The state of each review lens: pass, fail, active (someone is reviewing) or waiting.
export function lensStates(card, lenses = []) {
  return (card.lenses || lenses).map((lens) => {
    const s = card.panel?.lenses?.[lens] || {};
    return { lens, state: s.verdict === 'pass' ? 'pass' : s.verdict === 'fail' ? 'fail' : s.worker ? 'active' : 'waiting', worker: s.worker ?? null };
  });
}

// The station of the rail a card is at, with its lenses in review; null when it is on no station (backlog, done).
// A blocked card sits where it was blocked from.
export function stationOf(card, lenses = []) {
  const column = card.column === 'blocked' ? card.history?.findLast((h) => h.to === 'blocked')?.from : card.column;
  const station = STATION_OF[column] ?? null;
  return station && { station, lenses: station === 'review' ? lensStates(card, lenses) : [] };
}

export function ago(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (Number.isNaN(m)) return '';
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  return m < 1440 ? `hace ${Math.floor(m / 60)} h` : `hace ${Math.floor(m / 1440)} d`;
}

export const since = (card) => card.claimedAt ?? lastAt(card);
export const workersOf = (card) => [...new Set([card.assignee, ...lensWorkers(card)].filter(Boolean))];
