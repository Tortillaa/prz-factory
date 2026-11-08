# Roadmap de prz-factory

Objetivo final: añades tarjetas al tablero, las mueves a **Ready**, y la fábrica las devuelve como cambios probados, revisados y mergeados, ejecutando los agentes en Orca.

Cada fase indica de qué parte de [super-board](https://github.com/EricTechPro/super-board) (MIT) sale (la "ingeniería inversa") y qué cambia aquí. Las diferencias de fondo son tres:

| super-board | prz-factory |
|---|---|
| GitHub Project como tablero | Tablero propio en localhost (`.git/factory/board.json`) |
| Workers con el Workflow tool de Claude Code o `claude -p` | Workers de Orca (`orca orchestration worker-start`), cada uno en su worktree |
| PRs y merge en GitHub | Local primero: rama por tarjeta y merge a la rama base desde el gate de revisión; los PRs de GitHub son opcionales y llegan después |

Scripts en Node (sin Python, sin dependencias) para tener un solo runtime.

---

## Fase 0 · Fundaciones ✅ (en parte)

- [x] Tablero en localhost, CLI `factory`, skill `factory-board`, tests (`d806263`)
- [x] `.gitattributes` con finales de línea LF
- [x] `factory.config.json`: rama base, ramas protegidas y `verify` (comandos que prueban el build; los usa el merge gate)
- [x] `factory install [destino]`: copia los skills a `<destino>/.claude/skills/` (solo pisa los que gestiona la fábrica) y crea el config si falta. *Origen: `install.sh`.*
- [x] `factory doctor`: comprueba node, git, Orca, config, tablero y skills instalados. *Origen: `super-board-setup.py check`.*

## Fase 1 · Tablero v2: la tarjeta como contrato

- [ ] Formato de tarjeta: Problem · Context · Fix · Acceptance Criteria · Risk · Blocked by. `factory lint <id>` marca los criterios vagos. *Origen: `ticket-format.md`, `lint.md`.*
- [ ] Dependencias (`blockedBy: [ids]`): una tarjeta no sale de Ready hasta que sus dependencias están en Done.
- [ ] Labels que enrutan: `qa` se salta Building; `bug` y `feature` (o sin label) se construyen. *Origen: "Lanes and label routing".*
- [ ] Orden manual dentro de cada columna (arrastrar para reordenar = prioridad).
- [ ] Campos de ejecución en la tarjeta: rama, worktree, commit revisado, worker de Orca.
- [ ] Web: editar tarjeta (título, cuerpo, labels, dependencias) y crear tarjetas con el formato completo.

## Fase 2 · Lanes: build, QA y review

Un skill por lane. Cada uno empieza con `claim`, termina con un comentario de evidencia, `move` y `release`.

- [ ] `factory-build`: rama `factory/<id>-<slug>`, cambio mínimo seguro con tests primero, commit, pasa a QA. Nunca mergea. *Origen: `super-build`.*
- [ ] `factory-qa`: ejecuta `verify`, comprueba que los criterios de aceptación tienen test, pasada de seguridad sobre el diff. Si algo falla, vuelve a Building con el motivo. *Origen: `super-qa`, `pr-security-review`.*
- [ ] `factory-review`: revisión del diff contra la tarjeta, recuerda hallazgos de rondas anteriores y pasa por el merge gate. *Origen: `super-review`.*
- [ ] `factory merge <id>` (merge gate): exige estar en Review, rama al día con la base, `verify` en verde sobre el commit revisado y un mutex; después mergea y mueve a Done. *Origen: `super-board-merge-gate.sh`.*
- [ ] Formato de commits y comentarios (`<emoji> [type] scope: subject`; comentario `[rol] estado · Hecho · Pendiente · Siguiente`). *Origen: `writing-standard.md`.*

## Fase 3 · Orquestador sobre Orca

- [ ] Skill `factory-run`: lee Ready (respetando orden y dependencias), reclama tarjetas, lanza un worker de Orca por tarjeta y lane con un spec autocontenido y termina su turno. Cuando Orca le despierta con `worker_done`, reconcilia el tablero y lanza el siguiente lane. *Origen: `run-workflow.md`, `super-board-wave.js`.*
- [ ] Regla de oro: el orquestador nunca construye, prueba ni arregla; solo despacha y reporta.
- [ ] `factory status` (snapshot de solo lectura) y `factory stop` (para los workers y libera los claims). *Origen: `status.md`, `stop.md`.*
- [ ] Límite de workers simultáneos (`maxWorkers` en el config).
- [ ] Recuperación: claims huérfanos y worktrees abandonados.

## Fase 4 · Guard hooks

Hooks de Claude Code en Node (JSON por stdin, decisión por stdout) que `factory install` cablea en `.claude/settings.json`. *Origen: `hooks/`.*

- [ ] `guard-secrets`: bloquea leer `.env`, claves, etc.
- [ ] `guard-key-literals`: bloquea escribir claves API literales en el código.
- [ ] `guard-protected-push`: bloquea push o commit directo a ramas protegidas desde un worker.
- [ ] `guard-delete-outside`: bloquea `rm` fuera del repo o worktree.
- [ ] Limpieza de worktrees mergeados al iniciar sesión. *Origen: `cleanup-wt.py`.*

## Fase 5 · Entrada de trabajo y onboarding

- [ ] `factory onboard`: asistente que crea el config, detecta los comandos de `verify` del proyecto y escribe un bloque gestionado en `AGENTS.md`/`CLAUDE.md`. *Origen: `onboard.md`, `agents-md-block.md`.*
- [ ] `factory-collect`: busca problemas (tests rotos, TODOs, logs de errores), los verifica y los convierte en tarjetas Backlog sin duplicados. *Origen: `super-collect`.*

## Fase 6 · Calidad y extras

- [ ] Evals por skill (caso, prompt, graders). *Origen: `evals/`.*
- [ ] CI con los tests en Windows, macOS y Linux.
- [ ] Panel del tablero como plugin de Orca (`orca plugin create --template panel`).
- [ ] Integración opcional con GitHub: push de la rama y PR al pasar a Review.
