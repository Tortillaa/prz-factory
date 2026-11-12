# Roadmap de prz-factory

Objetivo final: mandas una idea al tablero y la fábrica la devuelve como un cambio redactado, construido, revisado por un panel de expertos y mergeado (o esperando tu aprobación si toca el negocio), ejecutando los agentes en Orca.

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
- [x] Los criterios de lint que requieren juicio (ambigüedad, tamaño, título y cuerpo que no cuadran, decisiones que faltan) están en el skill `factory-lint` (Fase 5), que pregunta al usuario como el `lint` interactivo de super-board.

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

## Fase 5 · Entrada de trabajo y onboarding ✅

- [x] Skill `factory-onboard`: doctor, install, demostrar `verify` ejecutándolo (y proponer los comandos del CI del proyecto si falla), política de merge, bloque para agentes, commit con permiso. *Origen: `onboard.md`.*
- [x] `factory agents-md`: bloque gestionado entre marcadores en `CLAUDE.md` (o `AGENTS.md`) con las reglas del proyecto; nunca toca el resto del archivo. *Origen: `agents-md-block.md`.*
- [x] Detección de `verify` para npm/pnpm/yarn/bun, Cargo, Go, Python y Makefile.
- [x] Skill `factory-collect` + `factory add --source <tipo>:<huella>`: verifica cada problema, lo archiva como tarjeta en backlog y deduplica por huella ("visto otra vez" si hay una abierta, `recurrence` si la anterior ya estaba hecha). *Origen: `super-collect`.*
- [x] Skill `factory-lint`: los criterios de lint que requieren juicio, preguntando al usuario.
- [x] Revisión: el lint ignora la sección `## Evidence` (los stack traces y los TODO citados bloqueaban Ready); la web muestra cuántas veces se ha visto un hallazgo.

## Fase 6 · Calidad y extras ✅

- [x] Evals por skill: `evals/cases/*.json` (setup del tablero y de git por lane, prompt = el mismo `factory spec` que recibe un worker, graders deterministas) sobre el fixture `evals/fixtures/shop`. `factory eval` las ejecuta con Claude Code headless; el harness se prueba en CI con un agente falso. *Origen: `evals/`.*
- [x] CI (`.github/workflows/test.yml`): tests en Linux, macOS y Windows con Node 22 y 24, más comprobación de que las copias instaladas coinciden.
- [x] Panel del tablero como plugin de Orca (`orca-plugin/`): un worker lee el tablero de cada repo abierto en Orca y el panel se actualiza en vivo. Solo lectura.
- [x] Integración opcional con GitHub: `factory pr` sube la rama y abre o actualiza el PR; con `github.pushBase` el merge gate sube la base tras el fast-forward (GitHub marca el PR como mergeado).
- [x] Aprobar desde la web los merges que esperan a una persona, fijados al commit revisado (pendiente de la Fase 2).
- [x] Revisión: la aprobación exige la etiqueta `merge-approval`, que solo pone el gate. `needs-you` también marca tarjetas que rebotaron, y esas nunca deben poder mergearse.

## Fase 7 · De la idea al merge: Spec Writer, panel de reviewers y solicitudes ✅

El proceso que pidió el usuario: manda una tarjeta con sus palabras, un Spec Writer la redacta, un Builder la construye, varios reviewers expertos la revisan en paralelo, y se mergea sola si es un cambio pequeño o le llega una solicitud si afecta al negocio. Sustituye a la cadena build → QA → review de la Fase 2.

- [x] Columna `spec` y lane `spec` (skill `factory-spec`): la idea entra en texto libre (`factory add --column spec`, botón "+ Nueva idea"), el Spec Writer lee el código, redacta la tarjeta, clasifica su impacto en el negocio y la pasa a Ready él solo. Si falta una decisión, la manda a blocked con las preguntas. Puede dividirla en tarjetas que nacen ya en Ready.
- [x] Panel de revisión en paralelo: un reviewer por lente (`review.lenses`: qa, security, code, ops), cada uno en su worktree y sobre el mismo commit. Claims por lente, `factory verdict` (pass, fail, escalar a una persona) y un checklist por lente en `skills/factory-review/references/lenses.md`. Un fallo devuelve la tarjeta a building y cierra la ronda; el veredicto que completa el panel ejecuta el merge gate.
- [x] Negocio: labels `auth`, `payments`, `pricing`, `schema`, `ops` (y `needs-human`), `merge.humanPaths` (rutas sensibles que el gate comprueba en el diff, diga lo que diga la tarjeta) y la lente `ops`, que escala lo que el Spec Writer no marcó. Los agentes pueden subir una tarjeta a revisión humana, nunca bajarla.
- [x] El merge gate exige el panel completo sobre el head (exit 11 si falta alguna lente).
- [x] Solicitudes: franja en la web con los merges que esperan aprobación y las tarjetas que esperan respuesta; `factory status` las separa (`approvals`, `needsYou`) y el coordinador avisa de cada una en cuanto aparece. Un handoff a blocked pone `needs-you`, y salir de blocked la quita.
- [x] El lane `qa` queda solo para las tarjetas `qa` (prueban la base y se cierran por el gate); en las tarjetas construidas, QA es una lente del panel.
- [x] Coordinador: `plan` despacha una acción por lente y las ideas de spec; `status`, `reclaim`, `stop` y `dispatched` entienden los claims por lente. `cleanup` reconoce los worktrees `factory-<id>-<lens>`.
- [x] Evals nuevas: `spec-empty-cart`, `spec-pricing-is-business`, `review-qa-missing-test`, `review-code-merge`, `review-ops-escalates-pricing`.
- [x] Probado de extremo a extremo con el CLI real en un repo temporal: una tarjeta pequeña se mergea sola al aprobar la cuarta lente, y una de precios queda en blocked esperando la aprobación. Web comprobada en el navegador de Orca.
- [x] Guía de uso paso a paso: `docs/GUIA.md`.
- [x] Cada paso consulta ponytail ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT), incluido en `skills/` para que todos los workers lo tengan: el Spec Writer recorta el alcance con su escalera ("¿tiene que existir?"), el Builder la aplica a cada línea y deja una línea `Skipped:`, y cada reviewer carga `ponytail-review`. En la lente `code`, el código que no debería existir es un Blocker.

## Fase 8 · Grok y otros agentes ✅

Para no gastar cuota de Claude en todo, cada lane puede correr en otro agente de Orca. El usuario pidió los reviewers en Grok 4.7 con esfuerzo alto.

- [x] `agents` en `factory.config.json`: agente, modelo y esfuerzo por lane; `plan` los devuelve en `launch` y `factory-run` los usa. Este repo: reviewers en Grok 4.7 alto.
- [x] Los guard hooks entienden los eventos de Grok (`toolName`/`toolInput` y sus nombres de herramienta), además de los de Claude Code.
- [x] El spec de cada worker no depende de que su agente cargue solo las reglas y las skills: dice que lea `CLAUDE.md` y da la ruta absoluta de cada skill.
- [x] `factory doctor` comprueba que Grok esté instalado y que el repo sea de confianza para Grok (la confianza del checkout principal cubre todos sus worktrees).
- [x] El coordinador sabe reintentar un worker que se quedó sin cuota (`usageLimitReached`) en vez de liberar la tarjeta.
- [x] Probado de verdad: la tarjeta #6 recorrió spec (Claude) → build (Claude) → panel de cuatro reviewers en Grok 4.7 en paralelo → merge gate, que la retuvo para una persona por tocar `src/store.mjs`.

## Fase 9 · Modelos por paso y agente de merge ✅

- [x] Builder en Claude Sonnet 5.5 (`agents.build`). Para lo que le supera, lanza un subagente de Claude Opus 5.5; el skill `factory-build` fija cuándo (razonamiento difícil, un bug sin explicar, un cambio entre módulos, una tarjeta devuelta con un Blocker) y cómo (encargo acotado, sin CLI `factory`; el builder revisa, commitea y lo cita).
- [x] Agente de merge: columna y lane `merge` entre review y done (skill `factory-merge`). El veredicto que completa el panel ya no mergea: pasa la tarjeta a `merge`. El agente mira el impacto en el negocio (solo puede subir el listón), escribe para la persona qué cambia, por qué se le pregunta y cómo deshacerlo, y ejecuta el merge gate, que mergea solo o deja la solicitud en el tablero.
- [x] El gate acepta solo tarjetas en `merge`. Un head movido o un panel incompleto vuelven a `review`; un checkout de la base sucio pasa a blocked con `needs-you`.
- [x] Modelo del agente de merge: Claude Haiku 5.5 (`agents.merge`). Lee, decide y ejecuta un comando, sin escribir código; la red de seguridad son las reglas fijas del gate y la lente `ops`.
- [x] Evals: `merge-lands`, `merge-escalates-pricing`; `review-code-merge` pasa a `review-code-pass` (termina en `merge`).

## Fase 10 · Skills automáticas y Spec Writer en Sonnet ✅

- [x] Las descripciones de todas las skills de la fábrica describen la tarea (con frases de ejemplo en español e inglés), no solo su nombre, para que el agente las coja solo. Ninguna es de uso manual. Un test lo vigila.
- [x] Probado con Claude Sonnet 5.5: con peticiones en lenguaje natural que no nombran la skill, eligió la correcta en 8 de 9. La novena (qué hay en el tablero) la resolvió directamente con `factory list`, sin skill.
- [x] Spec Writer en Claude Sonnet 5.5 (`agents.spec`), con un subagente Opus 5.5 para las tarjetas difíciles de redactar (`factory-spec` fija cuándo).

## Fase 11 · Instalar sin instalar nada ✅

- [x] `install` copia el runtime de la fábrica al proyecto (`.prz-factory/`): el proyecto ya no depende de un clon de este repo ni de `npm link`, y cada worktree tiene el CLI porque la carpeta se commitea.
- [x] Un solo comando desde cualquier repo: `npx -y github:Tortillaa/prz-factory install .`, o un prompt para el agente: «Instala prz-factory en este repositorio: ejecuta `npx -y github:Tortillaa/prz-factory install .` y después sigue la skill factory-onboard que se acaba de instalar.».
- [x] Skills, spec de los workers, hook de SessionStart y `doctor` usan `node .prz-factory/bin/factory.mjs` cuando `factory` no está en el PATH. `doctor` solo marca Grok como fallo si alguna lane corre en Grok.
- [x] Probado: un repo vacío queda listo con `npm exec` sobre este repo local, `doctor` en verde, y el tablero se usa desde un worktree.
- [x] Subir `main` a GitHub (PR #1).

## Fase 12 · El repo como fuente de reglas, roles y skills ✅

- [x] `README.md` reorganizado en tres apartados, con una tabla cada uno: reglas para los agentes (y qué código hace cumplir cada una), roles de agentes (columna, cómo termina, skill y modelo) y skills (quién la usa y para qué).
- [x] Instrucciones de despliegue en el README: requisitos, desplegar en un proyecto, arrancar, actualizar, quitar y publicar una versión.
- [x] Plugin de Orca: `install` lo copia a `.prz-factory/orca-plugin`, así se instala desde cualquier proyecto sin clonar este repo. Instrucciones en el README, en la guía y en `orca-plugin/README.md`.
- [x] `test/readme.test.mjs` falla si el README deja fuera una skill, un rol, una lente o un guard.

## Fase 13 · Validación: de prototipo a uso profesional

La mecánica está probada (tests, CI, una tarjeta real, evals del agente de merge y del Builder). Falta demostrar el flujo completo con agentes reales y medir su coste antes de usarla sin supervisión en otros repos. Cada paso deja sus números en `docs/VALIDACION.md`.

- [ ] **1 · Cerrar la #6.** Aprobarla en el tablero: primera prueba real del camino "te pide aprobación → apruebas → se mergea". Su rama salió de un `main` antiguo, así que el gate la devuelve al Builder para rebase y vuelve a recorrer el panel y el agente de merge antes de pedir la aprobación otra vez.
- [ ] **2 · Una ejecución completa en este repo.** Dos o tres ideas pequeñas y reales con `/factory-run`: una inocente, que debe mergearse sola, y otra que toque una ruta sensible, que debe llegar como solicitud. Medir tiempo por paso, cuota y errores.
- [ ] **2b · Las 5 evals pendientes con agentes reales:** `spec-empty-cart` y `spec-pricing-is-business` (Sonnet), `review-code-pass`, `review-ops-escalates-pricing` y `review-qa-missing-test` (Grok 4.7).
- [ ] **3 · Piloto en un repo no crítico, con buenos tests**, en modo piloto: `"humanRisk": ["low", "medium", "high"]` en su `factory.config.json`, de modo que todos los merges pasan por una persona.
- [ ] **4 · Decidir con datos.** Tras 10 o 20 tarjetas del piloto: cuántas se aprobarían tal cual, cuántas se rechazarían y cuánto cuesta cada una. Si salen las cuentas, quitar el modo piloto para que los cambios pequeños se mergeen solos.
- [ ] **5 · Ajustar con lo que salga.** Candidatos: el reparto de modelos (por la cuota), `maxWorkers`, y avisos fuera del tablero si se escapan las solicitudes. Puntos flacos vistos en la ejecución del paso 2:
  - [x] **Supervisión de workers.** Un reviewer seguía trabajando (y gastando cuota) cuando otra lente ya había cerrado la ronda. Ahora la reserva que otra mano cierra deja un huérfano en `status.toStop`, y el coordinador lo para (`worker-stop` + `worker-release` + `factory stopped`).
  - [x] **Nombres de worker repetidos entre rondas.** Un reviewer de la ronda 2 actuó con la reserva de la ronda 3 porque se llamaban igual. Ahora el nombre lleva la ronda (`review-qa-8-r3`) y el tablero rechaza al sobrante.
  - [x] **Terminales y worktrees acumulados en Orca.** Los intentos parados no se liberaban y los worktrees de tarjetas terminadas se quedaban. El coordinador ahora libera siempre, limpia al arrancar y ejecuta `factory cleanup --apply` tras cada merge.
  - [x] **El Builder no pedía ayuda a Opus** aunque la tarjeta volviera dos veces. El spec del Builder dice ahora cuántas veces ha vuelto y que empiece por un subagente Opus.
  - [x] **Cada merge obligaba a rebase y revisión completa** de las tarjetas en vuelo. Ahora el gate rebasa él mismo en un worktree temporal y mergea sin volver a build ni al panel cuando no hay conflictos y el cambio es el mismo que se revisó (mismo `patch-id`); `verify` corre sobre el commit rebasado. Una aprobación de la persona sigue valiendo.
  - [x] **El panel no cabía con `maxWorkers: 4`** y era lo que más workers consumía (28 de 41). Ahora una tarjeta de riesgo Low sin etiqueta de negocio pasa por un panel ligero (`review.light`: qa y code), y `maxWorkers` puede ser un límite por agente de Orca (este repo: claude 3, grok 4).
  - [x] **Un cambio sin commitear en el checkout de la persona bloqueaba los merges.** Ahora decide git: el merge se hace si no toca esos archivos, y la tarjeta solo pasa a blocked si los toca.
  - [x] **Arreglos de seguridad por lista negra no convergían** (la #8). La lente `security` informa ahora del tipo de fallo con su causa raíz y todas sus variantes, y el Spec Writer pide "denegar por defecto" en toda tarjeta que bloquea o valida algo.
  - [x] **Formato de commits sin comprobar.** El handoff del Builder a review rechaza commits nuevos sin `Card: #N` e imprime cómo arreglarlo.
  - [x] **El coordinador hacía cuatro pasos a mano por worker.** `factory dispatch` hace el paso entero: para los workers de rondas cerradas, libera los terminales de los que terminaron y lanza lo que diga `plan`.
  - [x] **No se podía medir el coste.** `factory dispatch` registra cada worker (inicio, fin, modelo, cómo acabó) y `factory report` da workers y minutos por rol, modelo y tarjeta. Los tokens siguen sin medirse: Orca no los da.
  - [x] **El guard se equivocaba con `cd`.** Ahora evalúa la carpeta de un `cd X &&` o `git -C X`; otro repo se juzga solo, y un worker que entra en otro checkout del mismo repo sigue siendo worker.

## Fase 14 · Modelo de amenaza y protección en el servidor ✅

La #8 (guard) y la #9 (hook `pre-push`) no convergían: cada ronda, el reviewer de seguridad encontraba otra forma de saltarse una barrera local (sintaxis de shell, alias, `--no-verify`, grafts, `send-pack`…). Todo lo que corre en la máquina se puede deshacer desde ella.

- [x] **Modelo de amenaza decidido:** las barreras locales protegen contra errores, no contra un agente que se las salta a propósito. Escrito en las tarjetas #8, #9 y #10, en la lente `security` (un bypass deliberado no es un Blocker; se apunta como fuera de alcance) y en el Spec Writer (toda barrera de seguridad lleva su modelo de amenaza en Context).
- [x] **Garantía en el servidor:** el repo pasa a público y `main` queda protegida en GitHub contra force-push y borrado, también para administradores.

## Pendiente fuera del código

- [x] Recorrer una tarjeta real con workers de Orca por el flujo nuevo (spec → build → panel → merge): tarjeta #6, ver Fase 8.
- [ ] Ejecutar todas las evals con un agente real: ver Fase 13, paso 2b.
- [ ] Instalar el plugin en Orca (ver "Plugin para Orca" en el README): es `trusted-worker` y requiere tu aprobación.
- [x] Subir el repo a GitHub (PR #1).
