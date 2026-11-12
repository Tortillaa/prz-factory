// `factory report`: what the workers cost, from the records `factory dispatch` keeps (board.workers):
// how many, how long, on which agent and model, per card and per lane. Orca reports no token usage,
// so minutes of work are the measure; a worker still running counts up to now.
const minutes = (w, now) => Math.max(0, ((w.endedAt ? Date.parse(w.endedAt) : now) - Date.parse(w.startedAt)) / 60_000);
const round1 = (n) => Math.round(n * 10) / 10;

function sum(rows, key, now) {
  const out = {};
  for (const w of rows) {
    const k = key(w);
    out[k] ??= { workers: 0, minutes: 0, wasted: 0 };
    out[k].workers += 1;
    out[k].minutes += minutes(w, now);
    if (w.outcome === 'round-over') out[k].wasted += minutes(w, now);
  }
  for (const v of Object.values(out)) {
    v.minutes = round1(v.minutes);
    v.wasted = round1(v.wasted);
  }
  return out;
}

export function report(board, now = Date.now()) {
  const rows = board.workers || [];
  const cards = board.cards
    .filter((c) => rows.some((w) => w.id === c.id))
    .map((c) => {
      const mine = rows.filter((w) => w.id === c.id);
      return { id: c.id, title: c.title, column: c.column, workers: mine.length, minutes: round1(mine.reduce((n, w) => n + minutes(w, now), 0)), byLane: sum(mine, (w) => w.lane, now) };
    });
  return {
    workers: rows.length,
    minutes: round1(rows.reduce((n, w) => n + minutes(w, now), 0)),
    wastedMinutes: round1(rows.filter((w) => w.outcome === 'round-over').reduce((n, w) => n + minutes(w, now), 0)),
    byLane: sum(rows, (w) => w.lane, now),
    byModel: sum(rows, (w) => `${w.agent}${w.model ? ` ${w.model}` : ''}`, now),
    cards,
  };
}

export function describeReport(r) {
  const table = (o) => Object.entries(o).map(([k, v]) => `  ${k.padEnd(28)} ${String(v.workers).padStart(3)} workers ${String(v.minutes).padStart(7)} min${v.wasted ? ` (${v.wasted} min on rounds that were over)` : ''}`).join('\n');
  return [
    `${r.workers} workers · ${r.minutes} min${r.wastedMinutes ? ` · ${r.wastedMinutes} min on rounds that were over` : ''}`,
    'by lane', table(r.byLane),
    'by agent and model', table(r.byModel),
    'by card', ...r.cards.map((c) => `  #${c.id} ${c.title.slice(0, 40).padEnd(40)} ${c.column.padEnd(8)} ${String(c.workers).padStart(3)} workers ${String(c.minutes).padStart(7)} min`),
  ].join('\n');
}
