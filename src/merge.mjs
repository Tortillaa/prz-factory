// The merge gate: the only way a card reaches Done. It lands exactly the commit that was
// reviewed and verified, as a fast-forward of the base branch, under a repo-wide mutex.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { riskLevel } from './ticket.mjs';
import { runVerify, verifySummary } from './verify.mjs';
import { git, revParse, isAncestor, isClean, worktrees, commonDir, diffLines, diffFiles, globToRegExp } from './git.mjs';
import { pendingLenses } from './lanes.mjs';
import { pushBase } from './github.mjs';

// Exit codes, also used by the CLI.
export const CODES = { merged: 0, error: 1, 'head-moved': 6, 'needs-human': 7, behind: 8, 'verify-failed': 9, 'base-dirty': 10, 'panel-incomplete': 11 };

const short = (sha) => sha.slice(0, 8);
// Set only when the gate holds a merge for a person; the only label that allows approving one.
export const APPROVAL = 'merge-approval';

function result(status, message, extra = {}) {
  return { status, code: CODES[status], message, ...extra };
}

const ESCALATED = 'needs-human';

// Why a person should merge this card instead of the gate. Empty when the gate may merge.
export function humanReasons(card, lines, policy, files = []) {
  const reasons = [];
  const risk = riskLevel(card.body);
  if (risk && policy.humanRisk.includes(risk)) reasons.push(`riesgo ${risk}`);
  // needs-human is how a reviewer (or the user) escalates one card: it holds whatever the config lists.
  const labels = card.labels.filter((l) => l === ESCALATED || policy.humanLabels.includes(l));
  if (labels.length) reasons.push(`label ${labels.join(', ')}`);
  const globs = (policy.humanPaths || []).map(globToRegExp);
  const touched = files.filter((f) => globs.some((g) => g.test(f)));
  if (touched.length) reasons.push(`rutas sensibles: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ` y ${touched.length - 5} más` : ''}`);
  if (lines > policy.maxLines) reasons.push(`diff grande: ${lines} líneas (máximo ${policy.maxLines})`);
  return reasons;
}

// Runs verify at `sha`: in a clean worktree already sitting on it (it has the dependencies
// installed), otherwise in a temporary detached worktree that is removed afterwards.
function verifyAt(sha, cwd, config) {
  const ready = worktrees(cwd).find((w) => w.head === sha && fs.existsSync(w.path) && isClean(w.path));
  if (ready) return { where: ready.path, ...runVerify(config.verify, ready.path, config) };
  const tmp = path.join(commonDir(cwd), 'factory', `verify-${short(sha)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  git(['worktree', 'prune'], cwd);
  git(['worktree', 'add', '--detach', tmp, sha], cwd);
  try {
    return { where: `${tmp} (temporal)`, ...runVerify(config.verify, tmp, config) };
  } finally {
    try {
      git(['worktree', 'remove', '--force', tmp], cwd);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// Card side effects of a refusal that needs a lane to act: comment, move, release.
function sendBack(file, id, who, to, text, labels) {
  store.update(file, (b) => {
    if (to === 'building') return store.sendBack(b, id, { who, role: 'merge', text });
    const card = store.getCard(b, id);
    store.commentCard(b, id, { role: 'merge', text });
    const add = [labels].flat().filter((l) => l && !card.labels.includes(l));
    if (add.length) store.editCard(b, id, { labels: [...card.labels, ...add] });
    store.moveCard(b, id, to, who);
    store.releaseCard(b, id);
  });
}

// Leaves the card where it is but gives it back, with a comment, so the run can pick it up again.
function release(file, id, text) {
  store.update(file, (b) => {
    store.commentCard(b, id, { role: 'merge', text });
    store.releaseCard(b, id);
  });
}

/**
 * Merges card `id` if every check passes.
 * sha: the commit the reviewer approved (defaults to run.reviewedSha). human: a person is
 * merging, so the human-merge policy is skipped (agents never pass it).
 */
export function mergeCard({ file, id, who = 'merge-gate', sha, human = false, cwd, config }) {
  if (!config.verify.length) throw new Error('"verify" is empty in factory.config.json: the gate cannot prove the build');
  const lock = path.join(commonDir(cwd), 'factory', 'merge.lock');
  // Other merges may be running verify; wait for them rather than fail.
  return store.withLock(lock, () => gate(), { staleMs: 2 * 60 * 60_000, timeoutMs: (config.verifyTimeoutMinutes + 5) * 60_000 * config.verify.length, what: 'merge gate' });

  function gate() {
    const card = store.getCard(store.load(file), id);
    // A card the gate sent to a person waits in blocked with needs-you; that person merges it from there.
    // Only a merge the gate itself held for a person (label merge-approval) can be approved from
    // blocked. needs-you alone also marks cards that bounced or whose workers failed: never merge those.
    const awaitingHuman = human && card.column === 'blocked' && card.labels.includes(APPROVAL);
    const branch = card.run.branch;
    // A qa card tests the base branch: its QA worker closes it from qa (or review, on older boards).
    const qaClose = !branch && card.labels.includes('qa') && ['qa', 'review'].includes(card.column);
    if (card.column !== 'review' && !awaitingHuman && !qaClose) {
      return result('error', `card #${id} is in ${card.column}; only cards in review can be merged`);
    }
    if (qaClose) {
      // A qa card tests what is already on the base branch: nothing to merge, QA's pass closes it.
      store.update(file, (b) => {
        store.commentCard(b, id, { role: 'merge', text: '[merge] ✅ tarjeta de QA sin código propio: cerrada sin merge' });
        store.moveCard(b, id, 'done', who);
        store.releaseCard(b, id);
      });
      return result('merged', `qa card #${id} closed (no code to merge)`);
    }
    if (!branch) return result('error', `card #${id} has no branch recorded (run.branch)`);
    const head = revParse(`refs/heads/${branch}`, cwd);
    if (!head) return result('error', `branch ${branch} does not exist`);

    const expected = sha || card.run.reviewedSha;
    if (!expected) return result('error', 'pass --sha <reviewed commit> (or record it with factory edit --reviewed-sha)');
    if (!head.startsWith(expected)) {
      return result('head-moved', `${branch} is at ${short(head)} but the review approved ${short(expected)}: review the new commits first`, { head });
    }

    const base = config.baseBranch;
    const baseSha = revParse(`refs/heads/${base}`, cwd);
    if (!baseSha) return result('error', `base branch ${base} does not exist`);
    if (!isAncestor(baseSha, head, cwd)) {
      const msg = `${branch} no contiene ${base} (${short(baseSha)}). Rebase sobre ${base}, vuelve a verificar y pasa otra vez por QA y review.`;
      sendBack(file, id, who, 'building', `[merge] ↩️ rebase necesario\n${msg}`);
      return result('behind', msg, { head, base: baseSha });
    }

    // Agents merge only what the whole review panel passed, on this very head.
    if (!human) {
      const pending = pendingLenses(card, config);
      if (pending.length) return result('panel-incomplete', `the review panel has not passed ${short(head)} yet: waiting on ${pending.join(', ')}`, { head, pending });
      if (!card.panel.head || card.panel.head !== head) return result('head-moved', `the panel reviewed ${card.panel.head ? short(card.panel.head) : 'nothing'}, the branch is at ${short(head)}`, { head });
    }

    const lines = diffLines(baseSha, head, cwd);
    const reasons = human ? [] : humanReasons(card, lines, config.merge, diffFiles(baseSha, head, cwd));
    if (reasons.length) {
      const msg = `Merge para una persona: ${reasons.join('; ')}.\nPara aprobarlo: revisa ${branch} (${short(head)}) y ejecuta \`factory merge ${id} --sha ${short(head)} --human\`.`;
      // Pin the commit the person is asked to approve: approving later must not land newer commits.
      store.update(file, (b) => store.editCard(b, id, { run: { reviewedSha: head } }));
      sendBack(file, id, who, 'blocked', `[merge] 🙋 necesita a una persona\n${msg}`, ['needs-you', APPROVAL]);
      return result('needs-human', msg, { head, lines, reasons });
    }

    const verify = verifyAt(head, cwd, config);
    if (!verify.ok) {
      const failed = verify.results.find((r) => !r.ok);
      const msg = `verify falló en ${short(head)} (${verify.where}):\n${verifySummary(verify)}\n${failed.output.slice(-1500)}`;
      sendBack(file, id, who, 'building', `[merge] ✖ verify falló\n${msg}`);
      return result('verify-failed', msg, { head, verify });
    }

    // Fast-forward the base. Where it is checked out, merge there so that checkout follows;
    // otherwise move the ref with a compare-and-swap against the base we verified on.
    const baseTree = worktrees(cwd).find((w) => w.branch === base);
    if (baseTree) {
      if (!isClean(baseTree.path)) {
        const msg = `${base} is checked out in ${baseTree.path} with uncommitted changes; commit or stash them and run the merge again`;
        release(file, id, `[merge] ⏸ ${msg}`);
        return result('base-dirty', msg, { head });
      }
      git(['merge', '--ff-only', head], baseTree.path);
    } else {
      git(['update-ref', `refs/heads/${base}`, head, baseSha], cwd);
    }
    if (!isAncestor(head, `refs/heads/${base}`, cwd)) return result('error', `merge did not land: ${short(head)} is not on ${base}`);
    const pushed = config.github.pushBase ? pushBase({ cwd, config }) : null;

    store.update(file, (b) => {
      const c = store.getCard(b, id);
      store.editCard(b, id, { labels: c.labels.filter((l) => l !== 'needs-you' && l !== APPROVAL), run: { reviewedSha: head, mergedSha: head } });
      const push = !pushed ? '' : pushed.pushed ? `\n↑ ${base} subida a ${config.github.remote}` : `\n⚠️ no se pudo subir ${base}: ${pushed.error}`;
      store.commentCard(b, id, { role: 'merge', text: `[merge] ✅ ${branch} → ${base} en ${short(head)}${human ? ' (aprobado por una persona)' : ''}\n${verifySummary(verify)}${push}` });
      store.moveCard(b, id, 'done', who);
      store.releaseCard(b, id);
    });
    return result('merged', `${branch} merged into ${base} at ${short(head)}`, { head, lines, verify, pushed });
  }
}
