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

## Fase 3 · Orquestador sobre Orca ✅

- [x] Skill `factory-run`: lee la cola, reserva cada tarjeta con un claim antes de despachar, lanza un worker de Orca por tarjeta y lane con el spec que genera `factory spec` y termina su turno. Cuando Orca le despierta, reconcilia el tablero y despacha lo siguiente. *Origen: `run-workflow.md`, `super-board-wave.js`.*
- [x] Un worktree por tarjeta: build lo crea (`new-top-level`), y QA y review lo reutilizan (`path:`). Así el setup del repo corre una vez y el merge gate encuentra el commit exacto limpio para verificar.
- [x] Regla de oro: el orquestador nunca construye, prueba ni arregla; solo despacha y reporta.
- [x] `factory status` (snapshot de solo lectura, con claims colgados) y `factory stop` (libera los claims y lista los dispatches que hay que parar). *Origen: `status.md`, `stop.md`.*
- [x] Límite de workers simultáneos (`maxWorkers`): `factory plan` solo llena los huecos libres, terminando trabajo (review, qa) antes de empezar más.
- [x] Recuperación: `factory reclaim` libera una tarjeta cuyo worker terminó sin traspasarla; a la segunda, blocked con `needs-you`.
- [x] Probado de verdad: la tarjeta #1 (`factory --version`) recorrió build → qa → review → merge con workers de Orca y aterrizó en `main` (`58d0552`).
- [x] Revisión: `factory dispatched` evita la carrera al registrar el dispatch, y el skill libera las terminales de los workers ya reconciliados.

## Fase 4 · Guard hooks ✅

Un único script autocontenido (`hooks/factory-guard.mjs`, sin imports de `src/`) que `factory install` copia a `.claude/hooks/` y cablea en `.claude/settings.json` sin tocar los hooks del usuario. Recibe JSON por stdin; sale con 2 y un motivo para bloquear. *Origen: `hooks/`.*

- [x] `secrets`: bloquea leer o escribir `.env*` (menos `.env.example` y similares), claves, `id_rsa`, credenciales; en Bash/PowerShell solo con verbos que leen (`cat`, `Get-Content`, `curl -d @…`).
- [x] `key-literals`: bloquea escribir claves con pinta de reales (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe, claves privadas).
- [x] `protected-push`: force-push a ramas protegidas, bloqueado para todos; en worktrees de workers además commit, push, switch, `branch -f` o `update-ref` sobre la base. El checkout de la persona trabaja con normalidad.
- [x] `delete-outside`: borrados recursivos (`rm -r`, `Remove-Item -Recurse`, `rd /s`) solo dentro del proyecto o de la carpeta temporal; nunca el proyecto entero ni el home.
- [x] `factory cleanup [--apply]`: worktrees `factory-<id>`, ramas `factory/*` y `<usuario>/factory-<id>` de tarjetas ya terminadas, solo si están mergeadas y sin ningún cambio (ni archivos sin trackear), y las carpetas temporales de verify. Usa `orca worktree rm` si Orca está. Al iniciar sesión, un hook solo avisa (no borra). *Origen: `cleanup-wt.py`.*
- [x] Probado en vivo: el hook bloqueó una lectura de `.env` en esta misma sesión, y `cleanup --apply` limpió el worktree y las ramas de la tarjeta #1 también en Orca.
- [x] Revisión: `doctor` comprueba que los guards estén cableados; las copias instaladas se commitean en este repo (los workers en worktrees nuevos las necesitan) y un test vigila que coincidan con la fuente.

## Fase 5 · Entrada de trabajo y onboarding

- [ ] `factory onboard`: asistente que crea el config, detecta los comandos de `verify` del proyecto y escribe un bloque gestionado en `AGENTS.md`/`CLAUDE.md`. *Origen: `onboard.md`, `agents-md-block.md`.*
- [ ] `factory-collect`: busca problemas (tests rotos, TODOs, logs de errores), los verifica y los convierte en tarjetas Backlog sin duplicados. *Origen: `super-collect`.*

## Fase 6 · Calidad y extras

- [ ] Evals por skill (caso, prompt, graders). *Origen: `evals/`.*
- [ ] CI con los tests en Windows, macOS y Linux.
- [ ] Panel del tablero como plugin de Orca (`orca plugin create --template panel`).
- [ ] Integración opcional con GitHub: push de la rama y PR al pasar a Review.
