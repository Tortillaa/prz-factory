---
name: prz-factory-init
description: >-
  Bring prz-factory into the project open in this session, or update it to the latest version:
  fetch it from GitHub, copy its CLI, board, skills and guard hooks into the repo, and hand over to
  the onboarding. Installed once per machine, so it works in any repo with no command to remember.
  Use whenever the user wants prz-factory (the software factory) in this project, or wants the
  copy it has refreshed. Triggers: "inicializa prz-factory", "instala prz-factory en este
  proyecto", "actualiza prz-factory", "init prz-factory", "add prz-factory to this repo".
---

# prz-factory-init

prz-factory lives at `https://github.com/Tortillaa/prz-factory` (public, MIT). Its `install`
command copies everything a project needs into the project itself, so after this the repo needs
nothing installed: `node .prz-factory/bin/factory.mjs` is its CLI. You only fetch it, run it and
clean up. Report one line per step: `✔ step · what happened`.

## 1 · Check

- The session's folder is a git repository (`git rev-parse --show-toplevel`). Work at its root.
  Not a repo: stop and ask whether to run `git init` first.
- `node --version` is 22 or newer, and `git` is on PATH. If not, say what is missing and stop.
- This is not the prz-factory repo itself (its root has `bin/factory.mjs` and `skills/factory-run/`).
  There, the factory installs with `node bin/factory.mjs install .` and nothing is fetched.
- A `.prz-factory/` folder with no `.factory-managed` file inside belongs to someone else: stop and
  ask. `install` would not touch it anyway.

## 2 · Fetch, install, clean up

Clone into a scratch folder inside the repo, so deleting it stays inside the repo (the factory's
`delete-outside` guard refuses deletes outside it). Remove a scratch folder left by an earlier
attempt first.

```text
git clone --depth 1 https://github.com/Tortillaa/prz-factory.git .prz-factory-src
node .prz-factory-src/bin/factory.mjs install . --json
rm -rf .prz-factory-src          (PowerShell: Remove-Item -Recurse -Force .prz-factory-src)
```

Delete `.prz-factory-src` even when `install` fails, then report the error. Never use `npx`, and
never commit `.prz-factory-src`.

From the `--json` report, say what changed: `runtime` (installed or updated, with its version),
the skills installed or skipped, `config` (created or kept) and `prePush`. A `skipped` entry is a
file the user owns: name it, do not overwrite it.

## 3 · Hand over

- **First install** (`config.status` is `created`): the project now has the `factory-onboard`
  skill. Read `.claude/skills/factory-onboard/SKILL.md` and follow it from step 2 (the install is
  done): it proves the verify commands, sets the merge policy and writes the rules into CLAUDE.md.
- **Update** (the config was kept): run `node .prz-factory/bin/factory.mjs doctor`, report it, and
  list the files to commit. Nothing else changes: the project's configuration is the user's.

Either way, end by telling the user to commit `.prz-factory/`, `.claude/` and
`factory.config.json` (every worker runs in a fresh worktree and needs them). Commit only if they
ask.
