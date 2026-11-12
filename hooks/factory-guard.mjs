#!/usr/bin/env node
// prz-factory guard hooks (PreToolUse) for Claude Code and Grok. Self-contained on purpose:
// `factory install` copies this file into <project>/.claude/hooks/ and settings.json runs it as
//   node "$CLAUDE_PROJECT_DIR/.claude/hooks/factory-guard.mjs" <guard>
// Grok reads the same .claude/settings.json (Claude compatibility) and sets CLAUDE_PROJECT_DIR too.
// It reads the hook event as JSON on stdin. Exit 0 allows the tool call; exit 2 blocks it and the
// reason on stderr goes back to the agent (both agents treat exit 2 as a deny).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- shared helpers ----------

// Splits a shell command into words, honouring quotes. Good enough to find paths and verbs;
// not a full shell parser.
export function words(command) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Pipeline / list segments: "a | b && c; d" → [["a"], ["b"], ["c"], ["d"]] (as word arrays).
export function segments(command) {
  return command
    .split(/\|\||&&|[|;\n]/)
    .map((s) => words(s.trim()))
    .filter((w) => w.length);
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const norm = (p) => {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '/');
};

// ---------- guard: secrets ----------

const SAFE_ENV = /\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_FILE = [
  /(^|\/)\.env(\.[\w.-]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)(credentials|service-account)[\w.-]*\.json$/i,
  /(^|\/)\.netrc$/i,
];
export function isSecretPath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  if (SAFE_ENV.test(s)) return false;
  return SECRET_FILE.some((re) => re.test(s));
}

// ---------- event shape ----------

// Grok sends { toolName, toolInput } with its own tool names and input keys; Claude Code sends
// { tool_name, tool_input }. Every guard works on the Claude shape, so translate Grok's first.
const TOOL_ALIASES = {
  run_terminal_command: 'Bash', Shell: 'Bash',
  read_file: 'Read',
  search_replace: 'Edit', hashline_edit: 'Edit', StrReplace: 'Edit',
  write: 'Write', EditNotebook: 'NotebookEdit',
  grep: 'Grep', list_dir: 'LS',
};
export function normalize(input = {}) {
  const name = input.tool_name ?? input.toolName;
  const raw = input.tool_input ?? input.toolInput ?? {};
  const t = { ...raw };
  // Grok names the file target_file (read_file), path (StrReplace, Write) or target_notebook.
  if (name !== 'grep' && name !== 'Grep') t.file_path ??= raw.target_file ?? raw.path ?? raw.target_notebook;
  // ...and the text it writes contents (Write) or code_edit.
  t.content ??= raw.contents ?? raw.code_edit;
  return { ...input, tool_name: TOOL_ALIASES[name] ?? name, tool_input: t };
}

// Commands that print or ship a file's content.
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'type', 'bat', 'grep', 'rg', 'egrep', 'sed', 'awk', 'source', '.', 'cp', 'scp', 'base64', 'xxd', 'od', 'strings', 'get-content', 'gc', 'select-string', 'curl', 'nl', 'sort', 'uniq', 'jq']);

export function guardSecrets(input) {
  input = normalize(input);
  const t = input.tool_input || {};
  const tool = input.tool_name;
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && isSecretPath(t.file_path || t.notebook_path)) {
    return `"${t.file_path || t.notebook_path}" looks like a secrets file. Do not read or write it; ask the user for the value you need or use an environment variable.`;
  }
  if (tool === 'Grep' && (isSecretPath(t.path) || isSecretPath(t.glob))) return 'Grep on a secrets file is blocked.';
  if (tool === 'Bash' || tool === 'PowerShell') {
    for (const seg of segments(t.command || '')) {
      const verb = path.basename(seg[0]).toLowerCase();
      const hit = seg.slice(1).find((w) => isSecretPath(w.replace(/^@/, '')));
      if (hit && READERS.has(verb)) return `"${seg.join(' ')}" reads a secrets file (${hit}). Ask the user for the value instead.`;
    }
  }
  return null;
}

// ---------- guard: key literals ----------

const KEY_PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe secret key', /\b(sk|rk)_live_[0-9A-Za-z]{20,}/],
  ['private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
];
export function findKey(text) {
  for (const [name, re] of KEY_PATTERNS) if (re.test(text || '')) return name;
  return null;
}

export function guardKeyLiterals(input) {
  input = normalize(input);
  const t = input.tool_input || {};
  const texts = [t.content, t.new_string, t.new_source, ...(t.edits || []).map((e) => e.new_string ?? e.new_text ?? e.text)];
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') texts.push(t.command);
  for (const text of texts) {
    const kind = findKey(text);
    if (kind) return `This writes a literal ${kind}. Never put secrets in code, commands or commits: read it from an environment variable and tell the user which one to set.`;
  }
  return null;
}

// ---------- guard: protected branches ----------

function protectedBranches(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'factory.config.json'), 'utf8'));
    if (Array.isArray(cfg.protectedBranches) && cfg.protectedBranches.length) return cfg.protectedBranches;
    if (cfg.baseBranch) return [cfg.baseBranch];
  } catch {}
  return ['main', 'master'];
}

// Every git call in a command, wherever it starts: after env vars or wrappers (FOO=1 git, & git,
// $(git, `git), or inside a quoted script (bash -c "git ...", powershell -Command '...').
function gitCalls(command) {
  return segments(command).flatMap((s) => s.flatMap((w, k) => {
    if (/^(\$\(|`)?git(\.exe)?$/i.test(w.split(/[\\/]/).pop())) return [['git', ...s.slice(k + 1)]];
    return /\s/.test(w) && /^-(c|command)$/i.test(s[k - 1] ?? '') ? gitCalls(w) : [];
  }));
}

// Config that can rewrite what a push does: push.*, remote.*.push|mirror, alias.*, include*.
const pushConfig = /^(push\.|remote\..*\.(push|mirror)(=|$)|alias\.|include)/i;

// The [NAME, value] pairs a segment sets before its command: \`X=v git\`, \`export X=v\`, \`set X=v\`,
// \`env X=v git\`, \`$env:X = v\` and \`Set-Item env:X v\`.
function envSets(seg) {
  const out = [];
  const val = (v) => (v ?? '').replace(/['"]/g, '');
  for (let k = 0; k < seg.length; k++) {
    const w = seg[k];
    let m;
    if (/^(export|set|env)$/i.test(w)) continue;
    if (/^(set-item|si)$/i.test(w)) {
      const args = seg.slice(k + 1);
      const n = args.findIndex((a) => /^env:\w+$/i.test(a));
      const v = args.findIndex((a) => /^-value$/i.test(a));
      if (n >= 0) out.push([args[n].slice(4), val(args[v >= 0 ? v + 1 : n + 1])]);
      break;
    }
    if ((m = /^(?:\$env:)?(\w+)=(.*)$/i.exec(w))) out.push([m[1], val(m[2] || seg[++k])]);
    else if (/^\$env:\w+$/i.test(w) && seg[k + 1] === '=') { out.push([w.slice(5), val(seg[k + 2])]); k += 2; }
    else break;
  }
  return out;
}

// Does an instruction of the command set git config that can turn a plain push into a forced one:
// a push, alias or include key, another config file, or another repo (GIT_DIR)?
function forcingEnv(command) {
  const segs = segments(command);
  return segs.some((s) => envSets(s).some(([n, v]) => /^GIT_(CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|DIR|WORK_TREE)$/i.test(n)
      || (/^GIT_CONFIG_(PARAMETERS|KEY_\d+)$/i.test(n) && pushConfig.test(v))))
    || segs.some((s) => s.some((w, k) => /\s/.test(w) && /^-(c|command)$/i.test(s[k - 1] ?? '') && forcingEnv(w)));
}

// ctx: { cwd, protectedBranches, linkedWorktree, currentBranch } (computed from git when not given).
function isLinked(dir) {
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], dir);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  return !!(gitDir && common && norm(gitDir) !== norm(common));
}

function sameRepo(a, b) {
  const ca = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], a);
  const cb = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], b);
  return !!(ca && cb && norm(ca) === norm(cb));
}

// A Git Bash path (/c/Users/…) or ~ as a path Node can resolve.
function hostPath(p) {
  const home = os.homedir();
  let s = p.replace(/^~(?=$|[\\/])/, home);
  if (process.platform === 'win32') s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return s;
}

// The folder the git commands of `command` run in: `base`, moved by each `cd`/`Set-Location`/
// `pushd` before the first git command, or that command's own `-C dir`. A folder that does not
// exist leaves `base`, so a typo never makes the guard look at another repo.
export function commandDir(command, base) {
  let dir = base;
  for (const seg of segments(command)) {
    const verb = path.basename(seg[0]).toLowerCase();
    if (['cd', 'set-location', 'sl', 'chdir', 'pushd'].includes(verb) && seg[1]) {
      const next = path.resolve(dir, hostPath(seg.slice(1).find((w) => !w.startsWith('-')) ?? seg[1]));
      if (fs.existsSync(next)) dir = next;
      continue;
    }
    if (verb === 'git') {
      const c = seg.indexOf('-C');
      if (c > 0 && seg[c + 1]) {
        const next = path.resolve(dir, hostPath(seg[c + 1]));
        if (fs.existsSync(next)) return next;
      }
      return dir;
    }
  }
  return dir;
}

export function guardProtectedPush(input, ctx = {}) {
  input = normalize(input);
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  const session = input.cwd ?? process.cwd();
  // The repo the git commands act on: the session's, or the one a leading `cd X` / `git -C X` names.
  const cwd = ctx.cwd ?? commandDir(input.tool_input?.command || '', session);
  const command = input.tool_input?.command || '';
  const segs = gitCalls(command);
  if (!segs.length) return null;
  const root = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const prot = ctx.protectedBranches ?? protectedBranches(root);
  // A worker stays a worker when it moves to another checkout of the same repo (the person's, say);
  // only a different repository is judged on its own.
  const linked = ctx.linkedWorktree ?? (isLinked(cwd) || (sameRepo(cwd, session) && isLinked(session)));
  const current = ctx.currentBranch ?? git(['branch', '--show-current'], cwd);
  const isProt = (ref) => {
    const r = String(ref).replace(/^\+/, '').replace(/^(refs\/)?heads\//, '');
    return prot.includes(r) || prot.some((b) => r.endsWith(`:${b}`) || r.endsWith(`:refs/heads/${b}`) || r.endsWith(`:heads/${b}`));
  };
  // Rather than spot every way to force a protected branch (+HEAD, globs, "+:", aliases...), a push
  // that CAN force is allowed only when every destination is a plain, unprotected branch name.
  const forceMsg = `Force-pushing is blocked unless every destination is a named branch other than ${prot.join(', ')} (no HEAD, @, globs or empty refspec).`;
  const namedUnprotected = (spec) => {
    const dst = /^\+?(?:[^:]*:)?([\w./-]+)$/.exec(spec)?.[1]; // the part after ":", or the whole refspec
    const name = dst?.toLowerCase().replace(/^(refs\/)?heads\//, '');
    return !!name && name !== 'head' && !prot.some((b) => b.toLowerCase() === name);
  };
  const envForces = forcingEnv(command);

  for (const seg of segs) {
    // Skip global options (-C dir, -c k=v...) to find the subcommand; remember the -c config.
    let i = 1;
    const config = [];
    let gitDirOpt = false; // --git-dir / --work-tree point git at another repo, like GIT_DIR
    while (i < seg.length && seg[i].startsWith('-')) {
      if (/^(-c|--config-env)$/.test(seg[i])) config.push(seg[i + 1] ?? '');
      else if (seg[i].startsWith('--config-env=')) config.push(seg[i].slice(13));
      else if (/^--(git-dir|work-tree)(=|$)/.test(seg[i])) gitDirOpt = true;
      i += /^(-C|-c|--config-env|--git-dir|--work-tree|--namespace)$/.test(seg[i]) ? 2 : 1;
    }
    const sub = seg[i];
    const rest = seg.slice(i + 1);
    // An alias or include can make any subcommand a push we cannot see.
    if (sub !== 'push' && sub !== 'send-pack' && (envForces || gitDirOpt || config.some((c) => /^(alias|include)/i.test(c)))) return forceMsg;
    if (sub === 'push' || sub === 'send-pack') {
      const flags = [];
      const pos = [];
      for (let j = 0; j < rest.length; j++) {
        const w = rest[j].replace(/\\(.)|["']/g, '$1'); // +"main", +\main and +'ma'in all mean +main
        if (w === '--') { pos.push(...rest.slice(j + 1).map((x) => x.replace(/\\(.)|["']/g, '$1'))); break; }
        if (!w.startsWith('-')) pos.push(w);
        else if (flags.push(w) && /^(-o|--push-option|--receive-pack|--exec)$/.test(w)) j++;
      }
      const refspecs = pos.slice(1); // pos[0] is the remote
      const canForce = envForces || gitDirOpt || config.some((c) => pushConfig.test(c)) || pos.some((w) => w.startsWith('+'))
        || flags.some((f) => /^(-[a-zA-Z]*f[a-zA-Z]*|--force.*|--all|--branches|--mirror)$/.test(f));
      if (canForce && !(refspecs.length && refspecs.every(namedUnprotected))) return forceMsg;
      const onCurrent = (w) => /^\+?(HEAD|@)$/i.test(w) && prot.includes(current); // HEAD and @ name the checked-out branch
      const touchesProt = refspecs.some((w) => isProt(w) || onCurrent(w)) ||(!refspecs.length && prot.includes(current));
      if (linked && touchesProt) return `Workers never push ${prot.join(', ')}: only \`factory merge\` lands code on the base branch.`;
    }
    if (!linked) continue;
    // Below: rules for linked worktrees (workers). The person's own checkout is left alone.
    if (['commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'pull'].includes(sub) && prot.includes(current)) {
      return `This worktree is on protected branch ${current}. Work on the card's branch (factory start) instead.`;
    }
    if ((sub === 'switch' || sub === 'checkout') && rest.some(isProt) && !rest.includes('--detach') && !rest.includes('-d')) {
      return `Workers do not check out ${prot.join(', ')}; use \`git switch --detach ${rest.find(isProt)}\` to look at it.`;
    }
    if (sub === 'branch' && rest.some((w) => /^(-f|--force|-D|-d|--delete|-m|-M)$/.test(w)) && rest.some(isProt)) {
      return `Moving, renaming or deleting ${prot.join(', ')} is blocked.`;
    }
    if (sub === 'update-ref' && rest.some((w) => isProt(w))) return `Moving ${prot.join(', ')} by hand is blocked: only \`factory merge\` does that.`;
  }
  return null;
}

// ---------- guard: recursive deletes outside the project ----------

export function guardDeleteOutside(input, ctx = {}) {
  input = normalize(input);
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  const cwd = ctx.cwd ?? input.cwd ?? process.cwd();
  const root = ctx.root ?? git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const allowed = [root, ...(ctx.extraAllowed ?? [os.tmpdir()])];
  const home = os.homedir();

  for (const seg of segments(input.tool_input?.command || '')) {
    const verb = path.basename(seg[0]).toLowerCase();
    const args = seg.slice(1);
    let recursive = false;
    let targets = [];
    if (verb === 'rm') {
      recursive = args.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
      targets = args.filter((w) => !w.startsWith('-'));
    } else if (verb === 'remove-item' || verb === 'ri' || verb === 'del' || verb === 'rmdir' || verb === 'rd') {
      recursive = args.some((w) => /^-recurse$/i.test(w) || /^\/s$/i.test(w));
      // Drop PowerShell parameters (-Force, -Path) and cmd switches (/s, /q); keep the paths.
      targets = args.filter((w) => !w.startsWith('-') && !/^\/[a-z]$/i.test(w));
    }
    if (!recursive) continue;
    for (const raw of targets) {
      if (/^\$|%\w+%|\$\{/.test(raw) && !/^\$(CLAUDE_PROJECT_DIR|PWD)/.test(raw)) {
        if (/^\$(HOME|USERPROFILE)\b|^%USERPROFILE%/i.test(raw)) return `Recursive delete of the home folder (${raw}) is blocked.`;
        continue; // other variables: cannot resolve them here
      }
      const p = raw.replace(/^~(?=$|[\\/])/, home).replace(/^\$(CLAUDE_PROJECT_DIR|PWD)/, root);
      const abs = path.resolve(cwd, p);
      if (norm(abs) === norm(root)) return `Recursive delete of the whole project (${raw}) is blocked.`;
      if (!allowed.some((a) => inside(abs, a))) return `Recursive delete outside the project (${abs}) is blocked. Delete only inside ${root} or the temp folder.`;
    }
  }
  return null;
}

// ---------- entry point ----------

export const GUARDS = {
  secrets: guardSecrets,
  'key-literals': guardKeyLiterals,
  'protected-push': guardProtectedPush,
  'delete-outside': guardDeleteOutside,
};

async function main() {
  const name = process.argv[2];
  const guard = GUARDS[name];
  if (!guard) {
    console.error(`factory-guard: unknown guard "${name}" (use: ${Object.keys(GUARDS).join(', ')})`);
    process.exit(0); // a misconfigured hook must not block every tool call
  }
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  let input;
  try {
    input = JSON.parse(data || '{}');
  } catch {
    process.exit(0);
  }
  const reason = guard(input);
  if (reason) {
    console.error(`🛡️ factory guard (${name}): ${reason}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
