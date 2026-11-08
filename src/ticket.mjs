// The card body is the contract a worker builds against. This module holds its template,
// parses its sections, and lints it. Deterministic checks only: judgment calls (ambiguity,
// size, title/body mismatch) belong to an agent-run lint, not here.

export const TEMPLATE = `## Problem
<qué falla o falta, desde el lado del usuario, en 1-3 frases>

## Context
- **Where:** <página, ruta o archivo>
- **Who:** <quién lo ve>

## Fix
<el cambio previsto en 1-3 líneas>

## Acceptance Criteria
- [ ] <resultado comprobable que un test pueda verificar>

## Risk
Low · <una línea>
`;

const REQUIRED = ['Problem', 'Fix', 'Acceptance Criteria', 'Risk'];
const MAX_AC = 6;

// Words that make an acceptance criterion unmeasurable (English and Spanish).
const VAGUE = [
  'quickly', 'fast', 'faster', 'snappy', 'snappier', 'smooth', 'polished', 'modern', 'better', 'improve', 'improved',
  'properly', 'correctly', 'nice', 'clean', 'intuitive', 'user-friendly', 'many', 'several', 'some', 'appropriate',
  'rápido', 'rápida', 'rápidamente', 'mejor', 'mejorar', 'mejorado', 'bonito', 'moderno', 'intuitivo', 'fluido',
  'correctamente', 'adecuado', 'adecuada', 'adecuadamente', 'muchos', 'muchas', 'varios', 'varias', 'algunos', 'algunas',
];
const VAGUE_RE = new RegExp(`(?<![\\p{L}-])(${VAGUE.join('|')})(?![\\p{L}-])`, 'giu');
const SCOPE_RE = /(?<![\p{L}])(TODO|TBD|FIXME|etc\.?)(?![\p{L}])|\.\.\.|…/giu;
// A template placeholder: <...> containing a space. Plain tags like <button> do not match.
const PLACEHOLDER_RE = /<[^<>\n]*\s[^<>\n]*>/;
const RISK_RE = /^(🟢|🟡|🔴|\*\*)?\s*\**\s*(low|medium|high|bajo|medio|alto)\b/i;
const CHECK_RE = /^\s*[-*]\s+\[( |x|X)\]\s+\S/;

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

// "## Heading" → { Heading: "content" }, matching headings case-insensitively.
export function parseSections(body = '') {
  const sections = {};
  let current = null;
  for (const line of String(body).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = REQUIRED.concat('Context').find((h) => h.toLowerCase() === m[1].toLowerCase()) || m[1];
      sections[current] = '';
    } else if (current) {
      sections[current] += line + '\n';
    }
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

export function acceptanceCriteria(body) {
  const ac = parseSections(body)['Acceptance Criteria'] || '';
  return ac.split(/\r?\n/).filter((l) => CHECK_RE.test(l)).map((l) => l.replace(CHECK_RE, (m) => m.slice(-1)).trim());
}

// Returns [{ rule, severity: 'error' | 'warn', message }]. Errors keep a card out of Ready.
export function lintCard(card, board) {
  const issues = [];
  const error = (rule, message) => issues.push({ rule, severity: 'error', message });
  const warn = (rule, message) => issues.push({ rule, severity: 'warn', message });
  const body = String(card.body || '');
  const sections = parseSections(body);

  if (!card.title || !card.title.trim()) error('title', 'la tarjeta no tiene título');
  for (const h of REQUIRED) {
    if (!(h in sections)) error('section', `falta la sección "## ${h}"`);
    else if (!sections[h]) error('section', `la sección "## ${h}" está vacía`);
  }
  if (!('Context' in sections)) warn('section', 'falta "## Context" (dónde y quién)');

  const ac = sections['Acceptance Criteria'];
  if (ac) {
    const lines = ac.split(/\r?\n/).filter((l) => l.trim());
    const checks = lines.filter((l) => CHECK_RE.test(l));
    if (!checks.length) error('ac-checklist', 'los criterios de aceptación deben ser una checklist "- [ ] ..."');
    else if (checks.length < lines.length) error('ac-checklist', 'hay líneas en Acceptance Criteria que no son "- [ ] ..."');
    if (checks.length > MAX_AC) warn('ac-size', `${checks.length} criterios: probablemente son varias tarjetas`);
    const vague = [...new Set([...stripCode(ac).matchAll(VAGUE_RE)].map((m) => m[1].toLowerCase()))];
    if (vague.length) warn('ac-vague', `criterios no medibles: ${vague.join(', ')} (pon un umbral o un comportamiento observable)`);
  }

  const text = stripCode(body);
  const holes = text.match(new RegExp(PLACEHOLDER_RE.source, 'g')) || [];
  if (holes.length === 1) error('placeholder', `queda un hueco de la plantilla: ${holes[0]}`);
  else if (holes.length > 1) error('placeholder', `quedan ${holes.length} huecos de la plantilla, empezando por ${holes[0]}`);
  const scope = [...new Set([...text.matchAll(SCOPE_RE)].map((m) => m[0]))];
  if (scope.length) error('scope', `alcance abierto: ${scope.join(', ')} (enumera o divide la tarjeta)`);

  if (sections.Risk && !RISK_RE.test(sections.Risk)) error('risk', 'Risk debe empezar por Low, Medium o High');

  if (board) for (const msg of dependencyProblems(board, card.id, card.blockedBy || [])) error('blocked-by', msg);
  return issues;
}

export const hasErrors = (issues) => issues.some((i) => i.severity === 'error');

// 'low' | 'medium' | 'high' from the Risk section, or null when it does not say.
export function riskLevel(body) {
  const m = (parseSections(body).Risk || '').match(RISK_RE);
  if (!m) return null;
  return { low: 'low', bajo: 'low', medium: 'medium', medio: 'medium', high: 'high', alto: 'high' }[m[2].toLowerCase()];
}

// Problems with a card's blockedBy list: unknown ids, itself, or a cycle.
export function dependencyProblems(board, id, deps) {
  const problems = [];
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  for (const dep of deps) {
    if (dep === id) problems.push('una tarjeta no puede bloquearse a sí misma');
    else if (!byId.has(dep)) problems.push(`#${dep} no existe`);
  }
  // Walk the dependency graph from each dep; reaching id again means a cycle.
  const seen = new Set();
  const stack = deps.filter((d) => d !== id);
  while (stack.length) {
    const cur = stack.pop();
    if (cur === id) {
      problems.push('las dependencias forman un ciclo');
      break;
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur)?.blockedBy || []));
  }
  return problems;
}
