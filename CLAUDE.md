# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

Node ≥ 22, sin dependencias ni paso de build (ESM puro, `.mjs`). No hay linter configurado todavía.

```bash
npm test                                   # node --test (test/*.test.mjs)
node --test --test-name-pattern "claim" "test/*.test.mjs"   # un solo test por nombre
npm run board                              # tablero en http://localhost:4747 (--port / FACTORY_PORT)
factory --help                             # CLI (enlazado con npm link; si no, node bin/factory.mjs)
node bin/factory.mjs install [destino]     # copia skills/ a <destino>/.claude/skills y crea factory.config.json
node bin/factory.mjs doctor                # comprobaciones de entorno (sale con 1 si alguna falla)
factory cleanup [--apply]                  # restos de tarjetas terminadas (por defecto solo lista)
```

El plan de trabajo está en `ROADMAP.md`, ordenado por fases. Marca allí cada punto al completarlo.

`FACTORY_BOARD=<ruta>` apunta el CLI y el servidor a otro archivo de tablero; úsalo en pruebas manuales para no tocar el tablero real. `test/fixtures.mjs` tiene `GOOD_BODY`, un cuerpo que pasa el lint, para tests que necesitan mover tarjetas a Ready. Para comprobar la web visualmente, ábrela en el navegador de Orca (`orca tab create --url …`, `orca screenshot --page <id>`; guía en `orca skills get orca-cli --reference references/browser.md`).

## Arquitectura del tablero

- **Un único archivo compartido por todos los worktrees**: `src/store.mjs` lo ubica en `<git-common-dir>/factory/board.json` (`.git/factory/board.json` en el checkout principal). Orca da a cada agente su propio worktree, así que el tablero no puede vivir dentro del árbol de trabajo ni commitearse. Fuera de un repo git cae en `.factory/board.json`.
- **Toda escritura pasa por `store.update(file, mutate)`**: lock exclusivo (un directorio `board.json.lock`, se considera obsoleto a los 10 s) más escritura atómica (tmp + rename). Si `mutate` lanza un error, el archivo no cambia. Ni los agentes ni el código nuevo deben escribir el JSON directamente.
- **Reglas del tablero en `store.mjs`, no en los clientes**: entrar en Ready exige pasar `lintCard` sin errores, y salir de Ready hacia building/qa/review/done exige que todo `blockedBy` esté en Done. `force` salta ambas comprobaciones y solo lo usa el usuario. El orden dentro de una columna es el orden de `board.cards` (`moveCard(..., { before })` reordena). `route(card)` decide el siguiente lane: `qa` si la tarjeta lleva ese label y `building` en otro caso. `readyQueue` es la cola de trabajo. `load()` rellena los campos nuevos (`blockedBy`, `run`) en tableros antiguos; al añadir un campo, añade también aquí su valor por defecto.
- **`src/ticket.mjs`**: plantilla del cuerpo, `parseSections` y `lintCard`. El lint es solo determinista: cada problema es `error` (bloquea Ready) o `warn` (solo avisa). Ignora el texto dentro de código y los tags HTML sin espacios.
- **`src/server.mjs`** sirve `public/index.html`, una API JSON (`GET /api/board` con `lint` y `unmet` calculados por tarjeta, `GET /api/template`; `POST /api/cards`, `/api/cards/:id` (editar), `/api/cards/:id/move` (`column`, `before`, `force`), `/api/cards/:id/comments`) y un stream SSE `/api/events` que emite `change` cuando cambia el archivo (vigila el directorio porque el rename reemplaza el archivo). Escucha solo en 127.0.0.1, rechaza cabeceras `Host` que no sean localhost y exige `application/json` en los POST.
- **`public/index.html`** es una página autocontenida (sin framework ni build): arrastrar y soltar (sobre una tarjeta = ponerla delante), crear y editar tarjetas, avisos de lint y de bloqueo, y recarga en vivo vía SSE que no pisa el formulario mientras editas. Si el servidor rechaza un movimiento, la web ofrece forzarlo.
- **Columnas** (`store.COLUMNS`): backlog · ready · building · qa · review · blocked · done. Cambiarlas implica tocar `store.mjs`, los colores de `index.html` y `skills/factory-board/SKILL.md`.
- **`claim`** falla si otra persona o agente ya tiene la tarjeta; es lo que impide que dos workers tomen la misma.

## Lanes y merge gate

- **`src/lanes.mjs`** — `startLane` comprueba en qué columna está la tarjeta y si este lane es su ruta. Después hace claim y la saca de Ready en una sola escritura, y luego hace el checkout: build se pone en la rama `factory/<id>-<slug>`; qa y review se ponen en *detached* sobre su head, porque la rama puede estar en el worktree del builder y git no deja tener una rama en dos worktrees. Si el checkout falla, libera el claim. Se niega a trabajar en el checkout principal (el de la persona) salvo con `allowMain`. `handoff` hace comentario, move y release en una sola escritura, y solo hacia las columnas que `LANES[lane].to` permite: ningún lane puede mover a Done.
- **`src/merge.mjs`** — el único camino a Done. Todo ocurre bajo el mutex `<common>/factory/merge.lock`, en este orden: head == commit revisado (6) → la rama contiene la base (8, vuelve a building) → política humana `config.merge` (7, pasa a blocked con `needs-you`; `--human` lo salta y deja mergear desde blocked) → `verify` en un worktree limpio que ya esté en ese commit, o si no en un worktree temporal que se borra al terminar (9, vuelve a building) → fast-forward de la base. Si la base está checkouteada en algún worktree, hace `merge --ff-only` ahí (y exige que esté limpio, si no sale con 10); si no, hace `update-ref` con compare-and-swap. Sin merge commits: lo que aterriza es exactamente lo verificado.
- **Tests** en `test/lanes.test.mjs`: montan repos git reales con un worktree por lane, y su `verify` falla si existe un archivo `FAIL`.

## Coordinador (Fase 3)

- **`src/run.mjs`**: `plan` (cola de despachos, de review hacia ready y limitada por `maxWorkers` menos las tarjetas reservadas), `placement` (worktree nuevo para la primera vez; después `path:` al worktree de la tarjeta, nunca el checkout principal), `spec` (el texto de tarea para el worker de Orca; Orca le añade su propio preámbulo con `worker_done`), `status`, `recordDispatch`, `reclaim` y `stop`. Todo es determinista; el skill `factory-run` hace las llamadas a Orca.
- **El claim es la reserva**: el coordinador hace `claim` con el nombre del worker (`<lane>-<id>`) antes de `worker-start`, y `factory start` acepta ese mismo nombre. Una tarjeta reservada no vuelve a salir en `plan`. `releaseCard` borra `run.dispatch`.
- **Orca**: `worker-start --spec-file -` lee el spec por stdin. Al crear un worktree `new-top-level`, Orca crea además una rama `<usuario-git>/<name>`. Los workers en worktrees nuevos se quedan abiertos hasta `worker-release`.

## Guard hooks (Fase 4)

- `hooks/factory-guard.mjs <guard>` es un hook PreToolUse autocontenido: se copia tal cual a cada proyecto, así que **no puede importar nada de `src/`**. Exporta cada guard como función pura (`guardSecrets`, `guardKeyLiterals`, `guardProtectedPush`, `guardDeleteOutside`), que es lo que prueban los tests; `protectedPush` y `deleteOutside` aceptan un `ctx` para no depender de git en los tests. Un guard desconocido o un JSON roto nunca bloquean (exit 0).
- Los guards están activos en esta sesión. Si uno bloquea algo legítimo, arregla el guard y su test; no lo esquives.
- `src/cleanup.mjs` solo toca lo que creó la fábrica (`factory-<id>`, `factory/*`, `*/factory-<id>`) de tarjetas que no están activas, y vuelve a comprobar cada rama justo antes de borrarla.

## Skills

`skills/<nombre>/SKILL.md` es la fuente de los skills que distribuye la fábrica: `factory-board` (el CLI, más `references/writing-standard.md`, que comparten todos), un skill por lane (`factory-build`, `factory-qa`, `factory-review`) y el del coordinador (`factory-run`). Los lanes enlazan al estándar con la ruta relativa `../factory-board/references/`, así que se instalan juntos. Claude Code solo los carga desde `.claude/skills/`, así que `factory install` los copia ahí y deja un marcador `.factory-managed` en cada carpeta. Solo reemplaza las carpetas que tienen el marcador y nunca toca un skill del usuario con el mismo nombre. En este repo las copias instaladas (`.claude/skills/`, `.claude/hooks/factory-guard.mjs`, `.claude/settings.json`) se commitean, porque los workers en worktrees nuevos las necesitan: edita siempre la fuente (`skills/`, `hooks/`) y ejecuta `factory install .`; `test/cleanup.test.mjs` falla si las copias se desvían.

`factory.config.json` (en la raíz del proyecto, commiteado; esquema y validación en `src/config.mjs`) define `baseBranch`, `protectedBranches`, `verify` (comandos que deben salir con 0 para mergear; se ejecutan con shell y paran en el primer fallo), `verifyTimeoutMinutes`, `maxWorkers` y `merge` (`humanRisk`, `humanLabels`, `maxLines`: cuándo el gate deja el merge a una persona).

## Objetivo

Construir una **fábrica de software propia**: un conjunto de skills, hooks y scripts para agentes de código que convierta tareas en PRs probados y revisados con poca supervisión, pensado para usarse desde el IDE **Orca**.

**Tablero:** casero, servido en `localhost` (decisión del usuario). Sustituye al GitHub Project de super-board: es la fuente de verdad del estado de las tarjetas y los agentes lo leen y actualizan.

## Orca (host)

Orca ([stablyai/orca](https://github.com/stablyai/orca), MIT) es un IDE de escritorio que ejecuta varios agentes CLI (Claude Code, Codex, OpenCode…) en paralelo, cada uno en su propio git worktree, con un navegador integrado. Esta sesión ya corre dentro de Orca (variables `ORCA_*` en el entorno; CLI `orca` en el PATH).

- **Claude Code funciona sin cambios dentro de Orca**: usa el mismo `~/.claude` (`ORCA_CLAUDE_CONFIG_DIR`), así que los skills (`.claude/skills/`), hooks y `settings.json` de Claude Code son el formato principal de la fábrica.
- **Las guías de Orca dependen de la versión**: carga siempre la guía de la versión instalada con `orca skills get <orca-cli|orchestration|orca-plugin-authoring>` (y `orca <cmd> --help`) en vez de suponer flags. En Linux, fuera de un terminal de Orca, el ejecutable es `orca-ide`, no `orca`.
- **Workers**: `orca orchestration worker-start --spec "<tarea>" --worktree current|new-top-level --agent claude|codex` lanza un agente en su propio worktree. El worker informa con `worker_done` y pregunta con `ask`; Orca despierta al coordinador cuando hay correo. Nunca hagas polling. Encaja con los lanes build/QA/review.
- **Plugins** (`orca plugin create`, manifiesto `orca-plugin.json`): paneles laterales HTML/TSX y workers Node que reaccionan a eventos de agentes y workspaces. Podrían usarse para mostrar el tablero dentro de Orca, aunque el tablero principal es la web en localhost (que también se puede abrir en el navegador integrado de Orca).

## Referencia: super-board (ingeniería inversa)

Partimos de estudiar https://github.com/EricTechPro/super-board (licencia MIT: si se copia o adapta código, conserva el aviso de copyright y la licencia). Ideas de arquitectura que merece la pena replicar o adaptar:

- **Empaquetado como pack de skills**: `skills/<nombre>/SKILL.md` (+ `README.md`, `references/`, `scripts/`), manifiesto de plugin en `.claude-plugin/plugin.json`, e instalador (`install.sh`) que copia el pack a `.agents/` del proyecto destino y enlaza cada carpeta de host (`.claude/`, `.codex/`, …) hacia ahí. Un script de detección de host (`super-board-host.sh`) decide qué CLI ejecuta la sesión según variables de entorno. Orca no es un CLI más sino la capa que los ejecuta; se detecta por las variables `ORCA_*`.
- **Tablero kanban como fuente de verdad** con las columnas Backlog · Ready · Building · QA · Review · Blocked · Done. El estado vive en el tablero, no en la sesión del agente. (super-board usa GitHub Projects; aquí lo sustituye el tablero en localhost).
- **Orquestador ≠ trabajador**: la sesión interactiva solo comprueba precondiciones, planifica "waves" y despacha; nunca construye, prueba ni arregla. El trabajo lo hacen *lanes* separados: build (worktree aislado, cambio mínimo, tests, PR en borrador) → QA (evidencias, revisión de seguridad del diff; si falla, vuelve a Build) → review (merge gate).
- **Guard hooks**: scripts Python solo con la stdlib, JSON de entrada y de salida, que bloquean secretos, push a ramas protegidas, borrados fuera del repo y rutas de worktree incorrectas.
- **Estándar de escritura único** para commits, cuerpos de PR, tickets y comentarios, aplicado tanto en el propio repo como en los proyectos donde se instala.
- **Evals por skill** (`evals/<caso>/case.yaml`, `prompt.md`, `graders/`) y una suite offline de seguridad (`tests/run-safety.sh`) que se ejecuta en CI antes de publicar una versión.
