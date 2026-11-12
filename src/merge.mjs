// The merge gate: the only way a card reaches Done. It lands exactly the commit that was
// reviewed and verified, as a fast-forward of the base branch, under a repo-wide mutex.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from './store.mjs';
import { riskLevel } from './ticket.mjs';
import { runVerify, verifySummary } from './verify.mjs';
import { git, tryGit, revParse, isAncestor, isClean, worktrees, commonDir, diffLines, diffFiles, globToRegExp } from './git.mjs';
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

// The change a commit range makes, as git's stable patch-id: two ranges with the same id make the
// exact same edits, whatever base they sit on.
function patchId(from, to, cwd) {
  const diff = git(['diff', '--no-color', '--no-ext-diff', `${from}...${to}`], cwd);
  if (!diff) return null;
  const out = execFileSync('git', ['patch-id', '--stable'], { cwd, input: diff + '\n', encoding: 'utf8' }).trim();
  return out.split(/\s+/)[0] || null;
}

// When the base moved after the review, rebase `head` onto it in a throwaway worktree. Returns the
// rebased commit when the rebase had no conflicts and makes exactly the change the panel reviewed
// (same patch-id); otherwise null, and the card goes back to its builder.
function cleanRebase(head, baseSha, cwd) {
  const reviewed = patchId(baseSha, head, cwd);
  if (!reviewed) return null;
  const tmp = path.join(commonDir(cwd), 'factory', `rebase-${short(head)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  git(['worktree', 'prune'], cwd);
  git(['worktree', 'add', '--detach', tmp, head], cwd);
  try {
    if (tryGit(['rebase', '--quiet', baseSha], tmp) === null) {
      tryGit(['rebase', '--abort'], tmp);
      return null;
    }
    const rebased = git(['rev-parse', 'HEAD'], tmp);
    return patchId(baseSha, rebased, cwd) === reviewed ? rebased : null;
  } finally {
    try {
      git(['worktree', 'remove', '--force', tmp], cwd);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// Points the card's branch at the commit that landed, so the branch reads as merged. Where the branch
// is checked out (the builder's worktree), move it there with `reset --keep`, which never drops local
// changes; if that refuses, the branch stays where it was and only cleanup is affected.
function followBranch(branch, from, to, cwd) {
  const tree = worktrees(cwd).find((w) => w.branch === branch);
  if (tree) return tryGit(['reset', '--quiet', '--keep', to], tree.path) !== null;
  return tryGit(['update-ref', `refs/heads/${branch}`, to, from], cwd) !== null;
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
    if (card.column !== 'merge' && !awaitingHuman && !qaClose) {
      return result('error', `card #${id} is in ${card.column}; only cards in merge (the whole review panel passed them) can be merged`);
    }
    // A card in the merge column that cannot land as reviewed goes back to a new review round.
    const reReview = (status, msg, extra) => {
      if (card.column === 'merge') sendBack(file, id, who, 'review', `[merge] ↩️ vuelve a revisión
${msg}`);
      return result(status, msg, extra);
    };
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
      return reReview('head-moved', `${branch} is at ${short(head)} but the review approved ${short(expected)}: review the new commits first`, { head });
    }

    const base = config.baseBranch;
    const baseSha = revParse(`refs/heads/${base}`, cwd);
    if (!baseSha) return result('error', `base branch ${base} does not exist`);

    // Agents merge only what the whole review panel passed, on this very head.
    if (!human) {
      const pending = pendingLenses(card, config);
      if (pending.length) return reReview('panel-incomplete', `the review panel has not passed ${short(head)} yet: waiting on ${pending.join(', ')}`, { head, pending });
      if (!card.panel.head || card.panel.head !== head) return reReview('head-moved', `the panel reviewed ${card.panel.head ? short(card.panel.head) : 'nothing'}, the branch is at ${short(head)}`, { head });
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

    // The base moved since the review (another card landed): rebase here when that is clean and
    // leaves the reviewed change untouched, so the card does not go round build and the panel again.
    let land = head;
    if (!isAncestor(baseSha, head, cwd)) {
      const rebased = cleanRebase(head, baseSha, cwd);
      if (!rebased) {
        const msg = `${branch} no contiene ${base} (${short(baseSha)}) y no se puede rebasar sin conflictos dejando el mismo cambio. Rebase sobre ${base}, vuelve a verificar y pasa otra vez por review.`;
        sendBack(file, id, who, 'building', `[merge] ↩️ rebase necesario\n${msg}`);
        return result('behind', msg, { head, base: baseSha });
      }
      land = rebased;
    }

    const verify = verifyAt(land, cwd, config);
    if (!verify.ok) {
      const failed = verify.results.find((r) => !r.ok);
      const where = land === head ? short(head) : `${short(land)} (${short(head)} rebasado sobre ${base})`;
      const msg = `verify falló en ${where} (${verify.where}):\n${verifySummary(verify)}\n${failed.output.slice(-1500)}`;
      sendBack(file, id, who, 'building', `[merge] ✖ verify falló\n${msg}`);
      return result('verify-failed', msg, { head, land, verify });
    }

    // Fast-forward the base. Where it is checked out, merge there so that checkout follows;
    // otherwise move the ref with a compare-and-swap against the base we verified on.
    const baseTree = worktrees(cwd).find((w) => w.branch === base);
    if (baseTree) {
      // Uncommitted changes in that checkout are fine unless the merge touches those very files:
      // then git refuses without changing anything, and only the person can sort it out.
      const ff = tryGit(['merge', '--ff-only', land], baseTree.path);
      if (ff === null) {
        const msg = `${base} is checked out in ${baseTree.path} and its uncommitted changes touch files this merge changes; commit or stash them and run the merge again`;
        // From merge, the card waits for the person in blocked; moving it back to merge lands the
        // same reviewed commit with no new review.
        if (card.column === 'merge') sendBack(file, id, who, 'blocked', `[merge] ⏸ ${msg}\nCuando esté limpio, mueve la tarjeta otra vez a merge.`, ['needs-you']);
        else release(file, id, `[merge] ⏸ ${msg}`);
        return result('base-dirty', msg, { head });
      }
    } else {
      git(['update-ref', `refs/heads/${base}`, land, baseSha], cwd);
    }
    if (!isAncestor(land, `refs/heads/${base}`, cwd)) return result('error', `merge did not land: ${short(land)} is not on ${base}`);
    const followed = land === head || followBranch(branch, head, land, cwd);
    const pushed = config.github.pushBase ? pushBase({ cwd, config }) : null;

    store.update(file, (b) => {
      const c = store.getCard(b, id);
      store.editCard(b, id, { labels: c.labels.filter((l) => l !== 'needs-you' && l !== APPROVAL), run: { reviewedSha: head, mergedSha: land } });
      const push = !pushed ? '' : pushed.pushed ? `\n↑ ${base} subida a ${config.github.remote}` : `\n⚠️ no se pudo subir ${base}: ${pushed.error}`;
      const rebase = land === head ? '' : `\n↪️ rebasado sobre ${base}: ${short(head)} → ${short(land)}, el mismo cambio que revisó el panel (patch-id)${followed ? '' : `; ${branch} se queda en ${short(head)}`}`;
      store.commentCard(b, id, { role: 'merge', text: `[merge] ✅ ${branch} → ${base} en ${short(land)}${human ? ' (aprobado por una persona)' : ''}${rebase}\n${verifySummary(verify)}${push}` });
      store.moveCard(b, id, 'done', who);
      store.releaseCard(b, id);
    });
    const how = land === head ? '' : ` (rebased from ${short(head)})`;
    return result('merged', `${branch} merged into ${base} at ${short(land)}${how}`, { head, land, lines, verify, pushed });
  }
}
