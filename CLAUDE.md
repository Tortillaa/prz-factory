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
factory eval [caso] [--agent cmd]          # evals de skills con un agente real (ver Fase 6)
cd orca-plugin && orca plugin test .       # tests del plugin de Orca
```

El plan de trabajo está en `ROADMAP.md`, ordenado por fases. Marca allí cada punto al completarlo.

`FACTORY_BOARD=<ruta>` apunta el CLI y el servidor a otro archivo de tablero; úsalo en pruebas manuales para no tocar el tablero real. `test/fixtures.mjs` tiene `GOOD_BODY`, un cuerpo que pasa el lint, para tests que necesitan mover tarjetas a Ready. Para comprobar la web visualmente, ábrela en el navegador de Orca (`orca tab create --url …`, `orca screenshot --page <id>`; guía en `orca skills get orca-cli --reference references/browser.md`).

## Arquitectura del tablero

- **Un único archivo compartido por todos los worktrees**: `src/store.mjs` lo ubica en `<git-common-dir>/factory/board.json` (`.git/factory/board.json` en el checkout principal). Orca da a cada agente su propio worktree, así que el tablero no puede vivir dentro del árbol de trabajo ni commitearse. Fuera de un repo git cae en `.factory/board.json`.
- **Toda escritura pasa por `store.update(file, mutate)`**: lock exclusivo (un directorio `board.json.lock`, se considera obsoleto a los 10 s) más escritura atómica (tmp + rename). Si `mutate` lanza un error, el archivo no cambia. Ni los agentes ni el código nuevo deben escribir el JSON directamente.
- **Reglas del tablero en `store.mjs`, no en los clientes**: entrar en Ready exige pasar `lintCard` sin errores, y salir de Ready hacia building/qa/review/done exige que todo `blockedBy` esté en Done. `force` salta ambas comprobaciones y solo lo usa el usuario. El orden dentro de una columna es el orden de `board.cards` (`moveCard(..., { before })` reordena). `route(card)` decide el siguiente lane: `qa` si la tarjeta lleva ese label y `building` en otro caso. `readyQueue` es la cola de trabajo. `load()` rellena los campos nuevos (`blockedBy`, `run`, `panel`) en tableros antiguos; al añadir un campo, añade también aquí su valor por defecto.
- **`src/ticket.mjs`**: plantilla del cuerpo, `parseSections` y `lintCard`. El lint es solo determinista: cada problema es `error` (bloquea Ready) o `warn` (solo avisa). Ignora el texto dentro de código y los tags HTML sin espacios.
- **`src/server.mjs`** sirve `public/index.html`, una API JSON (`GET /api/board` con `lint` y `unmet` calculados por tarjeta, `GET /api/template`; `POST /api/cards`, `/api/cards/:id` (editar), `/api/cards/:id/move` (`column`, `before`, `force`), `/api/cards/:id/comments`) y un stream SSE `/api/events` que emite `change` cuando cambia el archivo (vigila el directorio porque el rename reemplaza el archivo). Escucha solo en 127.0.0.1, rechaza cabeceras `Host` que no sean localhost y exige `application/json` en los POST.
- **`public/index.html`** es una página autocontenida (sin framework ni build): arrastrar y soltar (sobre una tarjeta = ponerla delante), crear y editar tarjetas, avisos de lint y de bloqueo, y recarga en vivo vía SSE que no pisa el formulario mientras editas. Si el servidor rechaza un movimiento, la web ofrece forzarlo.
- **Columnas** (`store.COLUMNS`): backlog · spec · ready · building · qa · review · merge · blocked · done. Cambiarlas implica tocar `store.mjs`, los colores de `index.html`, `skills/factory-board/SKILL.md` y `orca-plugin/src/` (`boards.ts`, `panel.tsx`). Una tarjeta nueva solo puede nacer en backlog, spec (una idea en texto libre, sin plantilla ni lint) o ready (si pasa el lint). Al salir de blocked, la tarjeta pierde `needs-you` y `merge-approval` (`REQUEST_LABELS`).
- **`claim`** falla si otra persona o agente ya tiene la tarjeta; es lo que impide que dos workers tomen la misma. En review los claims son por lente (`claimLens`, `card.panel.lenses[lens].worker`), no de la tarjeta: `claimsOf(card)` los lista todos y `holding(card, worker)` dice qué tiene un worker.
- **Panel de revisión** (`card.panel = { head, lenses }`): cada lente guarda `worker`, `worktree`, `verdict`, `sha` y `dispatch`. Entrar en review vacía el panel (ronda nueva; cada lente conserva su worktree) y salir de review libera todos los claims: ambas cosas las hace `moveCard`.

## Lanes y merge gate

El flujo es **spec → ready → building → review (panel en paralelo) → merge → done**. La columna `qa` solo la usan las tarjetas con el label `qa`, que prueban la rama base sin construir nada.


- **`src/lanes.mjs`** — `startLane` comprueba en qué columna está la tarjeta y si este lane es su ruta. Después hace claim y la saca de Ready en una sola escritura, y luego hace el checkout: spec se pone en *detached* sobre la base (solo lee); build se pone en la rama `factory/<id>-<slug>`; qa y review se ponen en *detached* sobre el head de la rama, porque la rama puede estar en el worktree del builder y git no deja tener una rama en dos worktrees. Review exige `lens`, reclama solo esa lente y fija `panel.head`. Si el checkout falla, libera el claim. Se niega a trabajar en el checkout principal (el de la persona) salvo con `allowMain`. `handoff` (spec, build, qa) hace comentario, move y release en una sola escritura, y solo hacia las columnas que `LANES[lane].to` permite: spec → ready o blocked, build → review o blocked. Ningún lane puede mover a Done, y un handoff a blocked añade `needs-you`.
- **`verdict`** (también en `lanes.mjs`) es como termina un reviewer: `pass` cierra su lente (con `escalate` añade `needs-human`); `fail` devuelve la tarjeta a building, o a blocked, y acaba la ronda para todas las lentes. Cuando todas las lentes de `config.review.lenses` han aprobado el mismo `panel.head`, fija `run.reviewedSha` y pasa la tarjeta a `merge`; un veredicto nunca mergea por sí mismo.
- **Lane `merge`** (skill `factory-merge`): el agente de merge reclama la tarjeta, mira si el diff toca el negocio aunque la tarjeta no lo diga (puede añadir una etiqueta de negocio, nunca quitarla), escribe para la persona qué cambia y cómo deshacerlo, y ejecuta `factory merge`. Solo puede hacer handoff a `blocked`. Los agentes pueden subir una tarjeta a revisión humana, nunca bajarla.
- **`src/merge.mjs`** — el único camino a Done, y solo acepta tarjetas en `merge` (o en blocked con `merge-approval` para `--human`, o tarjetas `qa` sin rama). Todo ocurre bajo el mutex `<common>/factory/merge.lock`, en este orden: head == commit revisado (6) → la rama contiene la base (8, vuelve a building) → el panel entero aprobó ese head (11 si falta alguna lente; `--human` lo salta). Si el head se movió (6) o falta alguna lente (11), la tarjeta vuelve a `review` para una ronda nueva; si el checkout de la base está sucio (10), pasa a blocked con `needs-you`, y al volver a `merge` aterriza el mismo commit sin revisar de nuevo → política humana `config.merge` (7, pasa a blocked con `needs-you` y `merge-approval`; `--human` lo salta y deja mergear desde blocked). La política manda el merge a una persona por riesgo (`humanRisk`), labels de negocio (`humanLabels`), rutas sensibles del diff (`humanPaths`, globs que resuelve `globToRegExp` de `git.mjs`) o tamaño (`maxLines`) → `verify` en un worktree limpio que ya esté en ese commit, o si no en un worktree temporal que se borra al terminar (9, vuelve a building) → fast-forward de la base. Si la base está checkouteada en algún worktree, hace `merge --ff-only` ahí (y exige que esté limpio, si no sale con 10); si no, hace `update-ref` con compare-and-swap. Sin merge commits: lo que aterriza es exactamente lo verificado.
- **Tests** en `test/lanes.test.mjs`: montan repos git reales con un worktree para el builder y uno por reviewer (panel de dos lentes, qa y code), y su `verify` falla si existe un archivo `FAIL`. `test/pipeline.test.mjs` cubre el store, la config, las rutas sensibles, el cleanup y el CLI del flujo nuevo.

## Coordinador (Fase 3)

- **`src/run.mjs`**: `plan` (cola de despachos limitada por `maxWorkers` menos los claims en vuelo; primero las lentes de review sin reviewer ni veredicto, una acción por lente, luego qa, building, ready y por último las ideas de spec), `placement` (spec, build y qa comparten el worktree de la tarjeta, `factory-<id>`; cada reviewer tiene el suyo, `factory-<id>-<lens>`, porque trabajan a la vez; nunca el checkout principal), `spec` (el texto de tarea para el worker de Orca; Orca le añade su propio preámbulo con `worker_done`), `status` (con `approvals`: los merges retenidos que esperan a la persona, y `panels`: el estado de cada lente), `recordDispatch`, `reclaim` y `stop`, que entienden tanto el claim de la tarjeta como el de una lente. Todo es determinista; el skill `factory-run` hace las llamadas a Orca.
- **El claim es la reserva**: el coordinador hace `claim` con el nombre del worker (`<lane>-<id>`, o `review-<lens>-<id>` con `--lens`) antes de `worker-start`, y `factory start` acepta ese mismo nombre. Una tarjeta reservada no vuelve a salir en `plan`. `releaseCard` borra `run.dispatch`.
- **Orca**: `worker-start --spec-file -` lee el spec por stdin. Al crear un worktree `new-top-level`, Orca crea además una rama `<usuario-git>/<name>`. Los workers en worktrees nuevos se quedan abiertos hasta `worker-release`.

## Guard hooks (Fase 4)

- **También para Grok.** Grok lee el mismo `.claude/settings.json` (compatibilidad con Claude) y pone `CLAUDE_PROJECT_DIR`, pero entrega el evento en otra forma (`toolName`/`toolInput`, herramientas `run_terminal_command`, `read_file`, `search_replace`…, ficheros en `target_file` o `path`). `normalize()` lo traduce a la forma de Claude al empezar cada guard; los tests de `test/guard.test.mjs` cubren los dos formatos.

- `hooks/factory-guard.mjs <guard>` es un hook PreToolUse autocontenido: se copia tal cual a cada proyecto, así que **no puede importar nada de `src/`**. Exporta cada guard como función pura (`guardSecrets`, `guardKeyLiterals`, `guardProtectedPush`, `guardDeleteOutside`), que es lo que prueban los tests; `protectedPush` y `deleteOutside` aceptan un `ctx` para no depender de git en los tests. Un guard desconocido o un JSON roto nunca bloquean (exit 0).
- Los guards están activos en esta sesión. Si uno bloquea algo legítimo, arregla el guard y su test; no lo esquives.
- `src/cleanup.mjs` solo toca lo que creó la fábrica (`factory-<id>`, `factory/*`, `*/factory-<id>`) de tarjetas que no están activas, y vuelve a comprobar cada rama justo antes de borrarla.

## Agentes por lane (Grok y otros)

- `config.agents` (`{ <lane>: { agent, model?, effort? } }`, validado en `src/config.mjs`; `effort` exige `model`, como Orca) decide qué agente de Orca ejecuta cada lane. `launchFor(lane, config)` lo resuelve (Claude si la lane no tiene entrada) y `plan` lo devuelve en `launch`; el skill `factory-run` lo pasa a `worker-start`. Este repo: builder en Claude Sonnet 5.5, reviewers en Grok 4.7 con esfuerzo alto, agente de merge en Claude Haiku 5.5.
- **Subagente Opus del builder:** el skill `factory-build` dice cuándo el builder (Sonnet) lanza un subagente de Claude Opus 5.5 con su herramienta de subagentes (en Claude Code, la herramienta Agent con `model: "opus"`): razonamiento difícil (concurrencia, seguridad, dinero o fechas, parsers), un bug sin explicar tras dos intentos, un cambio entre varios módulos o una tarjeta devuelta con un Blocker. El subagente no usa el CLI `factory`; el builder revisa su trabajo, lo commitea y lo cita en el handoff (`Opus:`).
- **Grok** encuentra las skills de `.claude/skills/`, lee `CLAUDE.md` y ejecuta los hooks de `.claude/settings.json`, pero **solo en carpetas de confianza** (`~/.grok/trusted_folders.toml`). Confiar en el checkout principal (`grok --trust inspect` una vez) cubre todos los worktrees del repo. `factory doctor` lo comprueba cuando Grok está instalado o alguna lane lo usa. Sin confianza, el spec de `run.spec` basta: dice que lea `CLAUDE.md` y da la ruta absoluta de cada skill, aunque entonces faltarían los guards.
- Orca lanza Grok como `grok agent --always-approve … stdio` (modo ACP), sin `--trust`.

## Entrada de trabajo (Fase 5)

- `store.collectCard` deduplica por `card.source.key` (la huella que da `factory-collect`). El lint (`src/ticket.mjs`) ignora la sección `## Evidence`, que cita salida real.
- `src/agentsmd.mjs` escribe el bloque gestionado. Este mismo `CLAUDE.md` lo lleva al final: no edites dentro de los marcadores; cambia `block()` y ejecuta `factory agents-md`.

## Calidad y extras (Fase 6)

- **Evals** (`src/evals.mjs`, `evals/`): un caso es JSON con `setup` (tarjetas, worktree, `sh`, `write`, `run`, `comment`, `claim`), `prompt` (`spec:<id>` genera el spec real del lane) y `graders` (`card`, `released`, `comment`, `spec`, `labels`, `risk`, `branchChanges`, `verifyAt`, `behaviour`, `onBase`, `noCommits`). Un caso de review lleva `lens`, y con `lenses` reduce el panel de ese repo (una sola lente deja que un agente complete el panel y llegue al gate). `test/evals.test.mjs` comprueba que ningún caso pasa sin agente y que un agente falso bueno (`test/fake-agent.mjs`) pasa `build-empty-cart`. Un caso nuevo debe fallar sin agente.
- **Aprobación humana**: solo la etiqueta `merge-approval` (que pone el gate al retener un merge) permite `--human` desde blocked o el botón de la web. `needs-you` por sí sola nunca autoriza un merge.
- **GitHub** (`src/github.mjs`) es un espejo: los merges siguen siendo locales. `FACTORY_GH` sustituye a `gh` en los tests.
- **`orca-plugin/`** es un plugin aparte (TypeScript sin build, `orca/testing`); `src/boards.ts` replica `resolveBoardPath`, así que si cambia la ubicación del tablero, cambia ambos.

## Skills

`skills/<nombre>/SKILL.md` es la fuente de los skills que distribuye la fábrica: `factory-board` (el CLI, más `references/writing-standard.md`, que comparten todos), un skill por lane (`factory-spec`, `factory-build`, `factory-review` con `references/lenses.md`, que tiene una sección por lente, y `factory-qa` para las tarjetas `qa`) y el del coordinador (`factory-run`). Además lleva dos skills de terceros, copiadas tal cual de [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT, v5.3.3; cada carpeta conserva su `LICENSE`): `ponytail` (la escalera del "desarrollador senior perezoso": ¿tiene que existir? → ¿ya está en el código? → librería estándar → dependencia instalada → una línea → el mínimo código) y `ponytail-review`. **Cada paso de la cadena carga la suya**: lo dice el spec que genera `run.spec` (`CRAFT` en `src/run.mjs`) y lo repite el skill del lane, que además resuelve los choques (mandan los Acceptance Criteria y el formato de comentarios de la fábrica). El Spec Writer aplica la escalera al alcance de la tarjeta, el Builder a cada línea, y los reviewers usan `ponytail-review`, repartida por lente en `lenses.md`. Para actualizarlas, vuelve a copiar `skills/ponytail*/SKILL.md` del repo original sin editarlas: lo propio de la fábrica va en los skills de los lanes. Los lanes enlazan al estándar con la ruta relativa `../factory-board/references/`, así que se instalan juntos. Claude Code solo los carga desde `.claude/skills/`, así que `factory install` los copia ahí y deja un marcador `.factory-managed` en cada carpeta. Solo reemplaza las carpetas que tienen el marcador y nunca toca un skill del usuario con el mismo nombre. En este repo las copias instaladas (`.claude/skills/`, `.claude/hooks/factory-guard.mjs`, `.claude/settings.json`) se commitean, porque los workers en worktrees nuevos las necesitan: edita siempre la fuente (`skills/`, `hooks/`) y ejecuta `factory install .`; `test/cleanup.test.mjs` falla si las copias se desvían.

`factory.config.json` (en la raíz del proyecto, commiteado; esquema y validación en `src/config.mjs`) define `baseBranch`, `protectedBranches`, `verify` (comandos que deben salir con 0 para mergear; se ejecutan con shell y paran en el primer fallo), `verifyTimeoutMinutes`, `maxWorkers`, `review.lenses` (los expertos del panel: qa, security, code, ops) y `merge` (`humanRisk`, `humanLabels`, `humanPaths`, `maxLines`: cuándo el gate deja el merge a una persona). Conviene que `maxWorkers` sea al menos el número de lentes, para que un panel corra entero en paralelo.

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

<!-- prz-factory:begin (managed by `factory agents-md`; edits inside are overwritten) -->
## prz-factory

This project is worked by prz-factory: cards on a local board, one Orca worker per card and lane.
Pipeline: spec (an idea) → ready → building → review (a panel, one reviewer per lens) → merge → done.
Also backlog (parked), qa (`qa` cards) and blocked (waiting for a person). `factory serve` shows it.

| When | Use | Never |
|---|---|---|
| Ask for a change | an idea in the `spec` column (`factory add "<idea>" --column spec`) | Move a card to ready with lint errors |
| Write a card yourself | `factory-lint` skill · `factory lint` | Invent a product decision |
| Drain the board | `factory-run` skill | Write specs, build, review or merge from the coordinator |
| Spec / build / review / merge one card | `factory-spec` · `factory-build` · `factory-review` (one lens) · `factory-merge` | Work outside your own worktree |
| Land a card | `factory verdict` (the panel) → `factory-merge` (the merge agent) → `factory merge` (the gate) | `git merge` or push to main by hand |
| Turn problems into cards | `factory-collect` skill | File a card without verifying the problem |

| Rule | Value |
|---|---|
| Base branch | `main` (protected: main) |
| Proof of build | `npm test` |
| Review panel | qa · security · code · ops: every lens must pass the same commit |
| Merge by a person | risk high · labels auth, payments, pricing, schema, ops, money, needs-human · paths `src/merge.mjs`, `src/store.mjs`, `src/lanes.mjs`, `hooks/**`, `.claude/hooks/**`, `.claude/settings.json`, `factory.config.json` · diff > 400 lines |
| Business labels | agents may add one (or `needs-human`), never remove one |
| Craft | every step loads `ponytail` (spec, build) or `ponytail-review` (reviewers): the smallest change that fully works, and no code that should not exist |
| Writing | commits and comments: `.claude/skills/factory-board/references/writing-standard.md` |
| Agents | build on claude claude-sonnet-5-5 · merge on claude claude-haiku-5-5 · review on grok grok-4.7 (high) · other lanes on claude; Claude Code and Grok read the same `.claude/` skills, this file and the guard hooks |
| Secrets | never read `.env` or key files; never write a key literal (guard hooks block both) |
<!-- prz-factory:end -->
