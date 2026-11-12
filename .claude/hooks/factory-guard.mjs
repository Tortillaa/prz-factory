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
  const segs = segments(input.tool_input?.command || '').filter((s) => path.basename(s[0]).toLowerCase() === 'git');
  if (!segs.length) return null;
  const root = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const prot = ctx.protectedBranches ?? protectedBranches(root);
  // A worker stays a worker when it moves to another checkout of the same repo (the person's, say);
  // only a different repository is judged on its own.
  const linked = ctx.linkedWorktree ?? (isLinked(cwd) || (sameRepo(cwd, session) && isLinked(session)));
  const current = ctx.currentBranch ?? git(['branch', '--show-current'], cwd);
  const isProt = (ref) => {
    const r = String(ref).replace(/^\+/, '').replace(/^refs\/heads\//, '');
    return prot.includes(r) || prot.some((b) => r.endsWith(`:${b}`) || r.endsWith(`:refs/heads/${b}`));
  };

  for (const seg of segs) {
    // Skip global options (-C dir, -c k=v) to find the subcommand.
    let i = 1;
    while (i < seg.length && seg[i].startsWith('-')) i += seg[i] === '-C' || seg[i] === '-c' ? 2 : 1;
    const sub = seg[i];
    const rest = seg.slice(i + 1);
    const force = rest.some((w) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/.test(w) || /^-\w*f/.test(w));
    if (sub === 'push') {
      const targets = rest.filter((w) => !w.startsWith('-'));
      const touchesProt = targets.slice(1).some(isProt) || (targets.length <= 1 && prot.includes(current));
      if (force && touchesProt) return `Force-pushing a protected branch (${prot.join(', ')}) is blocked.`;
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
