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

// The state of each review lens: pass, fail, working (someone is reviewing) or pending.
export function lensStates(card, lenses = []) {
  return (card.lenses || lenses).map((lens) => {
    const s = card.panel?.lenses?.[lens] || {};
    return { lens, state: s.verdict === 'pass' ? 'pass' : s.verdict === 'fail' ? 'fail' : s.worker ? 'working' : 'pending', worker: s.worker ?? null };
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

export const shorten = (text, max = 48) => text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…';

// The four stations with their cards in flight (the same ones En marcha lists) and, in review, each lens.
export function lineOf(state) {
  const flying = groupBoard(state).inFlight.map((card) => ({ card, at: stationOf(card, state.lenses) })).filter((x) => x.at);
  return STATIONS.map((station) => {
    const cards = flying.filter((x) => x.at.station === station).map((x) => ({ card: x.card, lenses: x.at.lenses }));
    return { station, count: cards.length, cards };
  });
}

const dayKey = (t) => new Date(t).toDateString();
const doneAt = (c) => c.history?.findLast((h) => h.to === 'done')?.at ?? lastAt(c);

// The day cards landed, by calendar day ("Hoy", "Ayer", then the date), in the order given.
export function dayGroups(done, now = Date.now()) {
  const label = (t) => dayKey(t) === dayKey(now) ? 'Hoy' : dayKey(t) === dayKey(now - 86400000) ? 'Ayer'
    : new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'long' });
  const groups = [];
  for (const card of done) {
    const day = label(doneAt(card));
    if (groups.at(-1)?.day === day) groups.at(-1).cards.push(card); else groups.push({ day, cards: [card] });
  }
  return groups;
}

// The figures of the day; minutes is the mean from a card's first history entry to done, over the last ten (null when none).
export function statsOf(state, now = Date.now()) {
  const { waiting, inFlight } = groupBoard(state);
  const done = state.cards.filter((c) => c.column === 'done').sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
  const spans = done.slice(0, 10).filter((c) => c.history?.length).map((c) => Date.parse(doneAt(c)) - Date.parse(c.history[0].at));
  return {
    inFlight: inFlight.length, waiting: waiting.length,
    mergedToday: done.filter((c) => dayKey(doneAt(c)) === dayKey(now)).length,
    minutes: spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length / 60000) : null,
  };
}

// Why the gate held a merge for a person, as short phrases (no emoji, no CLI instruction).
export function reasonsOf(card) {
  const prefix = 'Merge para una persona:';
  const line = card.comments.findLast((m) => m.text.includes(prefix))?.text.split('\n').find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/\.$/, '').split('; ') : [];
}

// A worker name (spec-3, build-34-r2, review-qa-7, merge-9) in words.
export function roleOf(worker) {
  const m = /^(spec|build|merge|review)-(?:([^-\d][^-]*)-)?\d+(?:-r(\d+))?$/.exec(worker);
  if (!m) return worker;
  const name = { spec: 'Spec Writer', build: 'Builder', merge: 'Agente de merge', review: 'Reviewer' + (m[2] ? ' ' + m[2] : '') }[m[1]];
  return m[3] ? `${name} · ronda ${m[3]}` : name;
}

export const since =(card) => card.claimedAt ?? lastAt(card);
export const workersOf = (card) => [...new Set([card.assignee, ...lensWorkers(card)].filter(Boolean))];

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Inline: `code`, [text](http link). The text is escaped first, so nothing from the body ever becomes markup.
const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');

// The card body (a small Markdown subset) as HTML: headings, lists, checklists, code blocks, links, paragraphs.
export function renderMarkdown(text = '') {
  const out = [];
  let list = null, para = [], code = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    para = []; list = null;
  };
  for (const line of text.split('\n')) {
    if (code) { if (line.startsWith('```')) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(line); continue; }
    let m;
    if (line.startsWith('```')) { flush(); code = []; }
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); }
    else if ((m = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
      if (para.length) flush();
      const box = m[1] == null ? '' : `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
      (list ??= []).push(`<li>${box}${inline(m[2])}</li>`);
    } else if (!line.trim()) flush();
    else { if (list) flush(); para.push(line); }
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('');
}
