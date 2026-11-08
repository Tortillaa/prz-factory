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

## Fase 0 · Fundaciones ✅

- [x] Tablero en localhost, CLI `factory`, skill `factory-board`, tests (`d806263`)
- [x] `.gitattributes` con finales de línea LF
- [x] `factory.config.json`: rama base, ramas protegidas y `verify` (comandos que prueban el build; los usa el merge gate)
- [x] `factory install [destino]`: copia los skills a `<destino>/.claude/skills/` (solo pisa los que gestiona la fábrica) y crea el config si falta. *Origen: `install.sh`.*
- [x] `factory doctor`: comprueba node, git, Orca, config, tablero y skills instalados. *Origen: `super-board-setup.py check`.*

## Fase 1 · Tablero v2: la tarjeta como contrato ✅

- [x] Formato de tarjeta: Problem · Context · Fix · Acceptance Criteria · Risk (las dependencias van en el campo `blockedBy`, no en el cuerpo). `factory lint` aplica los criterios deterministas de `lint.md`: secciones, checklist, palabras vagas, huecos de plantilla, TODO/etc. y nivel de riesgo. Una tarjeta con errores no entra en Ready. *Origen: `ticket-format.md`, `lint.md`.*
- [x] Dependencias (`blockedBy: [ids]`, sin ciclos): una tarjeta no sale de Ready hacia trabajo hasta que sus dependencias están en Done. `factory next` da la cola.
- [x] Labels que enrutan: `qa` se salta Building; `bug` y `feature` (o sin label) se construyen. *Origen: "Lanes and label routing".*
- [x] Orden manual dentro de cada columna (arrastrar para reordenar = prioridad; `move --before`).
- [x] Campos de ejecución en la tarjeta (`run`): rama, worktree, commit revisado, worker de Orca.
- [x] Web: editar tarjeta (título, cuerpo, labels, dependencias), crear tarjetas desde la plantilla, avisos de lint y de bloqueo.
- [ ] Pendiente para un skill: los criterios de lint que requieren juicio (ambigüedad, tarjeta demasiado grande, título y cuerpo que no cuadran), con preguntas al usuario como el `lint` interactivo de super-board.

## Fase 2 · Lanes: build, QA y review ✅

Un skill por lane, sobre tres comandos comunes: `factory start` (claim y checkout en el worktree del worker), `factory verify` y `factory handoff` (comentario, move y release en una sola escritura; cada lane solo puede pasar la tarjeta a columnas concretas).

- [x] `factory-build`: rama `factory/<id>-<slug>`, cambio mínimo seguro con tests primero, commit, pasa a QA. Nunca mergea. *Origen: `super-build`.*
- [x] `factory-qa`: ejecuta `verify`, registro de qué test cubre cada criterio de aceptación, casos límite, "test the tests" y pasada de seguridad sobre el diff. Si algo falla, vuelve a Building con el motivo. Trabaja en detached y nunca commitea. *Origen: `super-qa`, `pr-security-review`.*
- [x] `factory-review`: primero su propia pasada (hipótesis antes de leer al builder), recuerda los hallazgos R1… de rondas anteriores y pasa por el merge gate. *Origen: `super-review`.*
- [x] `factory merge <id> --sha <revisado>` (merge gate): mutex, tarjeta en Review, head = commit revisado, rama que contiene la base, política de merge humano (riesgo High, labels sensibles, diff > `merge.maxLines`), `verify` sobre ese commit exacto y fast-forward de la base (sigue el checkout donde esté la base). Mueve la tarjeta según el resultado; exit codes 0/6/7/8/9/10. *Origen: `super-board-merge-gate.sh`.*
- [x] Formato de commits, comentarios de lane y tabla de hallazgos en `skills/factory-board/references/writing-standard.md`. *Origen: `writing-standard.md`.*
- [x] Revisión: contador de rebotes en el store (la cuarta vuelta a building pasa a blocked con `needs-you`), las tarjetas `qa` se cierran por el gate sin merge, y el exit 10 libera la tarjeta.
- [ ] Pendiente: aprobar merges humanos desde la web (Fase 6).

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
