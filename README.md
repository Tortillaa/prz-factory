# prz-factory

Una fábrica de software para agentes de código que corre en [Orca](https://www.onorca.dev/). Mandas una idea con tus palabras y la fábrica la devuelve construida, revisada y mergeada. Los cambios pequeños se mergean solos; los que tocan el negocio esperan tu aprobación en el tablero.

Este repositorio es la fuente de tres cosas, y de las herramientas que las hacen cumplir:

| Apartado | Qué contiene | Dónde vive |
|---|---|---|
| [Reglas para los agentes](#reglas-para-los-agentes) | Lo que ningún agente puede hacer, y lo que comprueba cada regla | `hooks/`, `src/store.mjs`, `src/merge.mjs`, `src/agentsmd.mjs` |
| [Roles de agentes](#roles-de-agentes) | Quién hace cada paso, con qué modelo y cómo termina | `src/lanes.mjs`, `src/run.mjs`, `factory.config.json` |
| [Skills](#skills) | Las instrucciones que sigue cada rol | `skills/` |

Además: [Despliegue](#despliegue) · [Plugin para Orca](#plugin-para-orca) · [Uso diario](#uso-diario) · [Desarrollo](#desarrollo). La guía paso a paso para quien la usa está en [docs/GUIA.md](docs/GUIA.md).

```text
 idea → Spec Writer → Builder → panel de reviewers → agente de merge → main
 spec  →   ready    → building →       review       →      merge      → done
                                                            └→ blocked: te pide aprobación
```

## Despliegue

### Requisitos

- Node 22 o superior y git.
- [Orca](https://www.onorca.dev/), para lanzar los agentes. El tablero y el CLI funcionan sin él.
- Acceso a este repo en GitHub. Es privado: basta con `gh auth login` o tus credenciales de git.
- Opcional: el CLI de Grok (`irm https://x.ai/cli/install.ps1 | iex` en Windows), si algún rol corre en Grok.

No hace falta clonar este repo ni instalar nada de forma global.

### Desplegar la fábrica en un proyecto

Abre tu agente (Claude Code o Grok) en el repositorio del proyecto y pídele:

> Instala prz-factory en este repositorio: ejecuta `npx -y github:Tortillaa/prz-factory install .` y después sigue la skill factory-onboard que se acaba de instalar.

O hazlo tú, en la terminal del proyecto:

```sh
npx -y github:Tortillaa/prz-factory install .
```

Eso deja la fábrica entera dentro del proyecto:

| Carpeta o archivo | Qué es |
|---|---|
| `.prz-factory/` | El CLI, el tablero web, los guards, las skills y el plugin de Orca |
| `.claude/skills/` | Las skills que leen los agentes (Claude Code y Grok) |
| `.claude/hooks/` y `.claude/settings.json` | Los guards de seguridad |
| `factory.config.json` | La configuración del proyecto |

Después:

1. **Configura** `factory.config.json`: los comandos de `verify`, las rutas sensibles (`merge.humanPaths`) y el modelo de cada rol (`agents`). La skill `factory-onboard` te lo pregunta paso a paso.
2. **Escribe las reglas** en el `CLAUDE.md` del proyecto: `node .prz-factory/bin/factory.mjs agents-md`.
3. **Comprueba**: `node .prz-factory/bin/factory.mjs doctor`. Todo debe salir en verde.
4. **Commitea** `.prz-factory/`, `.claude/` y `factory.config.json`. Cada agente trabaja en un worktree nuevo y los necesita.
5. Si algún rol corre en Grok, ejecuta una vez `grok --trust inspect` en la carpeta del proyecto.

En el resto de este README, `factory` es `node .prz-factory/bin/factory.mjs`. Para teclear solo `factory`, ejecuta `npm link` dentro de `.prz-factory`.

### Arrancar

```sh
factory serve          # el tablero, en http://localhost:4747
```

Y en una sesión de Claude Code dentro de Orca, en el proyecto: `/factory-run` (o "arranca la fábrica").

### Actualizar o quitar

- **Actualizar** a la última versión: repite la línea de `npx`. Reemplaza `.prz-factory/` y las skills gestionadas; no toca tu configuración ni una skill tuya con el mismo nombre.
- **Quitar**: borra `.prz-factory/`, las carpetas de `.claude/skills/` que tienen un archivo `.factory-managed`, `.claude/hooks/factory-guard.mjs`, las entradas de `factory-guard` en `.claude/settings.json`, el bloque `prz-factory` de `CLAUDE.md` y `factory.config.json`.

### Publicar una versión de la fábrica

Los cambios de este repo llegan a `main` por rama y pull request: el guard `protected-push` bloquea el push directo a `main` desde una sesión de agente. Una vez en `main`, cada proyecto la recibe al repetir la línea de `npx`.

## Plugin para Orca

Un panel en la barra lateral derecha de Orca con el tablero de cada repo abierto: las tarjetas por columna, quién tiene cada una y las que esperan a una persona. Se actualiza en vivo. Es de solo lectura: mover tarjetas sigue siendo cosa del CLI, de la web y de los agentes.

Se instala una vez por máquina, desde cualquier proyecto que tenga la fábrica:

```sh
orca plugin install .prz-factory/orca-plugin
```

El plugin ejecuta su propio proceso de Node, así que Orca no lo activa sin tu aprobación. Ese comando no instala nada todavía: enseña lo que el plugin podrá hacer (ejecutar su código con tu usuario y leer la lista de workspaces) y una huella `ap1-…`. Si estás de acuerdo, repítelo con la huella:

```sh
orca plugin install .prz-factory/orca-plugin --approve ap1-<la huella que te ha dado>
orca plugin open local.prz-factory-board --panel board
```

Desde un clon de este repo, la carpeta es `./orca-plugin`. Si actualizas la fábrica y el plugin ha cambiado, la huella cambia y Orca pide aprobarlo de nuevo. Más detalle en [orca-plugin/README.md](orca-plugin/README.md).

## Reglas para los agentes

Cada regla la hace cumplir el código, no la buena voluntad del agente. `factory agents-md` escribe el resumen en el `CLAUDE.md` (o `AGENTS.md`) de cada proyecto, y cada skill repite las de su rol en su sección "Never".

| Regla | Quién la hace cumplir |
|---|---|
| El tablero se lee y se cambia solo con el CLI `factory`, nunca editando `board.json` | `src/store.mjs`: lock y escritura atómica |
| Una tarjeta entra en Ready solo si pasa `factory lint`, y sale solo con sus dependencias en Done | `src/store.mjs`, `src/ticket.mjs` |
| Un agente por tarjeta (y uno por lente en la revisión); cada uno en su worktree, nunca en el checkout principal | `claim` en `src/store.mjs`, `startLane` en `src/lanes.mjs` |
| Cada rol solo puede pasar la tarjeta a sus columnas; ninguno la mueve a Done | `LANES` en `src/lanes.mjs` |
| Solo el merge gate aterriza código: el commit exacto que aprobó todo el panel, con `verify` en verde | `src/merge.mjs` |
| Lo que toca el negocio lo aprueba una persona: riesgo High, etiquetas `auth`, `payments`, `pricing`, `schema`, `ops`, rutas sensibles o un diff grande | `src/merge.mjs`, `merge` en `factory.config.json` |
| Un agente puede subir una tarjeta a revisión humana, nunca bajarla; nunca usa `--human` ni `--force` | skills; el gate solo acepta `--human` con la etiqueta `merge-approval`, que solo pone él |
| Nada de `git merge`, commit o push sobre la rama base desde un worker | guard `protected-push` |
| No leer `.env` ni archivos de claves; no escribir claves literales | guards `secrets` y `key-literals` |
| Borrados recursivos solo dentro del proyecto | guard `delete-outside` |
| No inventar una decisión de producto: la tarjeta va a `blocked` con la pregunta | skills `factory-spec`, `factory-build`, `factory-review` |
| El mínimo código que resuelve la tarjeta; el que no debería existir se devuelve | skills `ponytail` y `ponytail-review` |
| Commits y comentarios en un formato único, con evidencias | `skills/factory-board/references/writing-standard.md` |
| A la cuarta vuelta al Builder, o al segundo worker caído, la tarjeta para y espera a una persona | `sendBack` en `src/store.mjs`, `reclaim` en `src/run.mjs` |

Los guards (`hooks/factory-guard.mjs`) funcionan igual con Claude Code y con Grok.

## Roles de agentes

Cada rol es un worker de Orca en su propio worktree. Carga su skill solo, por la tarea que recibe.

| Rol | Trabaja en | Qué hace | Termina con | Skill | Modelo en este repo |
|---|---|---|---|---|---|
| **Coordinador** | — | Lanza a los demás, reconcilia el tablero y te avisa de cada solicitud. Nunca redacta, construye, revisa ni mergea | — | `factory-run` | el de tu sesión |
| **Spec Writer** | `spec` | Lee el código, recorta la idea, la redacta como tarjeta y clasifica su impacto en el negocio | `handoff` a `ready` o `blocked` | `factory-spec` + `ponytail` | Claude Sonnet 5.5; subagente Opus 5.5 si la tarjeta es difícil |
| **Builder** | `building` | Construye la tarjeta en su rama, con los tests primero | `handoff` a `review` o `blocked` | `factory-build` + `ponytail` | Claude Sonnet 5.5; subagente Opus 5.5 para lo difícil |
| **Reviewers**, uno por lente | `review` | Revisan el mismo commit en paralelo: `qa`, `security`, `code` y `ops` | `verdict`: pass, fail o escalar | `factory-review` + `ponytail-review` | Grok 4.7, esfuerzo alto |
| **Agente de merge** | `merge` | Comprueba si el cambio toca el negocio, te lo explica y lanza el merge gate | `merge`, o `handoff` a `blocked` | `factory-merge` | Claude Haiku 5.5 |
| **QA** | `qa` | Solo para tarjetas con la etiqueta `qa`: prueba lo que ya está en la rama base | `merge` (cierra la tarjeta) | `factory-qa` | Claude |

Qué mira cada lente del panel (`skills/factory-review/references/lenses.md`):

| Lente | Su pregunta |
|---|---|
| `qa` | ¿Hace lo que dice la tarjeta, y hay un test que lo notaría si dejara de hacerlo? |
| `security` | ¿Se puede abusar de este cambio? |
| `code` | ¿Es el cambio correcto, y hace falta cada línea? |
| `ops` | ¿Qué le hace esto al negocio y al producto en marcha? |

El modelo de cada rol se elige en `factory.config.json`. Un proyecto recién instalado corre todos los roles en Claude; esta es la configuración de este repo:

```json
"agents": {
  "spec":   { "agent": "claude", "model": "claude-sonnet-5-5" },
  "build":  { "agent": "claude", "model": "claude-sonnet-5-5" },
  "review": { "agent": "grok",   "model": "grok-4.7", "effort": "high" },
  "merge":  { "agent": "claude", "model": "claude-haiku-5-5" }
}
```

## Skills

`skills/` es la fuente. `factory install` las copia a `.claude/skills/` de cada proyecto, y los agentes las eligen solos por su descripción: ninguna hay que invocarla a mano.

| Skill | Quién la usa | Para qué |
|---|---|---|
| `factory-run` | Coordinador | Vaciar el tablero lanzando un agente por tarjeta y paso |
| `factory-spec` | Spec Writer | Convertir una idea en una tarjeta que se pueda construir |
| `factory-build` | Builder | Construir una tarjeta con tests y entregarla al panel |
| `factory-review` | Reviewers | Revisar un cambio por una lente y dar un veredicto |
| `factory-merge` | Agente de merge | Decidir quién aterriza el cambio y lanzar el merge gate |
| `factory-qa` | QA | Probar lo que ya está en la rama base |
| `factory-board` | Todos | Leer y cambiar el tablero con el CLI; incluye el estándar de escritura |
| `ponytail` | Spec Writer y Builder | El mínimo cambio que resuelve el problema entero |
| `ponytail-review` | Reviewers | Revisar como quien recibirá el aviso cuando falle |
| `factory-lint` | Tú, con un agente | Escribir o repasar tarjetas a mano |
| `factory-collect` | Tú, con un agente | Buscar problemas en el código y convertirlos en tarjetas |
| `factory-onboard` | Tú, con un agente | Instalar y configurar la fábrica en un proyecto |

`ponytail` y `ponytail-review` son de [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT) y van incluidas sin modificar, con su licencia.

## Uso diario

| Para | Haz |
|---|---|
| Ver el tablero | `factory serve` → http://localhost:4747, o el panel de Orca |
| Pedir un cambio | botón "+ Nueva idea", o `factory add "<idea>" --column spec` |
| Poner la fábrica a trabajar | `/factory-run` en una sesión de Claude Code dentro de Orca |
| Ver qué pasa | `factory status` |
| Aprobar un merge que te espera | la franja de solicitudes del tablero → "Aprobar y mergear", o `factory merge <id> --sha <sha> --human` |
| Contestar una pregunta de un agente | un comentario en la tarjeta, y arrástrala de vuelta a su columna |
| Parar | pide "stop" al coordinador |
| Limpiar worktrees y ramas de tarjetas terminadas | `factory cleanup --apply` |

`factory --help` lista todos los comandos.

## Desarrollo

```sh
npm test                                   # suite completa (Node test runner)
node --test --test-name-pattern "<nombre>" "test/*.test.mjs"
node bin/factory.mjs eval [caso]           # evals de skills con un agente real (usa tu cuenta)
node bin/factory.mjs install .             # tras tocar skills/ u hooks/: refresca las copias de .claude/
cd orca-plugin && orca plugin test .
```

La arquitectura está en [CLAUDE.md](CLAUDE.md) y el plan, con su estado, en [ROADMAP.md](ROADMAP.md).

Inspirada en [super-board](https://github.com/EricTechPro/super-board) (MIT), con tablero propio en `localhost` en lugar de GitHub Projects y merges locales por fast-forward. Licencia MIT.
