# prz-factory

Una fábrica de software para agentes de código que corre en [Orca](https://www.onorca.dev/). Mandas una idea con tus palabras y la fábrica la devuelve construida, revisada y mergeada: un **Spec Writer** la convierte en una tarjeta completa, un **Builder** la construye (Sonnet, con un subagente Opus para lo difícil), un **panel de reviewers** expertos (QA, seguridad, código y operaciones) la revisa en paralelo, y un **agente de merge** decide quién la aterriza: los cambios pequeños se mergean solos; los que tocan el negocio esperan tu aprobación en el tablero, con una explicación de qué cambia y cómo deshacerlo. Cada agente es un worker de Orca en su propio worktree, y un merge gate solo deja entrar en la rama base el commit exacto que se revisó y verificó.

La guía paso a paso está en [docs/GUIA.md](docs/GUIA.md).

Inspirada en [super-board](https://github.com/EricTechPro/super-board) (MIT) e incluye las skills `ponytail` y `ponytail-review` de [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT), con tablero propio en `localhost` en lugar de GitHub Projects y merges locales por fast-forward.

## Requisitos

Node 22 o superior, git, acceso a este repo en GitHub (es privado: `gh auth login` o tus credenciales de git), y Orca para lanzar workers (el tablero, el CLI y los lanes funcionan sin él). No hace falta clonar ni instalar nada más.

## Instalar en un proyecto

Abre tu agente (Claude Code, Grok…) en el repositorio y pídele:

> Instala prz-factory en este repositorio: ejecuta `npx -y github:Tortillaa/prz-factory install .` y después sigue la skill factory-onboard que se acaba de instalar.

O hazlo tú en la terminal del proyecto:

```sh
npx -y github:Tortillaa/prz-factory install .   # lo descarga de GitHub y lo copia al proyecto
```

La fábrica entera (CLI, tablero web, guards y skills) queda dentro del proyecto, en `.prz-factory/`, `.claude/` y `factory.config.json`: commitéalos y cada worktree la tendrá. Desde entonces el comando es `node .prz-factory/bin/factory.mjs` (o `factory`, si además lo tienes en el PATH con `npm link`). Para actualizar a la última versión, vuelve a ejecutar la línea de `npx`.

## Usar

| Para | Haz |
|---|---|
| Ver el tablero | `factory serve` → http://localhost:4747 (o el panel de Orca, ver `orca-plugin/`) |
| Pedir un cambio | botón "+ Nueva idea", o `factory add "<idea>" --column spec`: el Spec Writer la redacta y la pasa a Ready |
| Escribir tú la tarjeta completa | botón "+ Nueva tarjeta", `factory add`, o pide al skill `factory-lint` que la redacte contigo |
| Encontrar problemas y convertirlos en tarjetas | skill `factory-collect` |
| Vaciar el tablero | skill `factory-run` en una sesión de Claude Code dentro de Orca |
| Ver qué pasa | `factory status` |
| Parar | pide "stop" al coordinador (`factory stop` + `orca orchestration worker-stop`) |
| Aprobar un merge que espera a una persona | la franja "solicitudes" del tablero → botón "Aprobar y mergear" en la tarjeta, o `factory merge <id> --sha <sha> --human` |
| Limpiar worktrees y ramas de tarjetas terminadas | `factory cleanup --apply` |

`factory --help` lista todos los comandos.

## Cómo decide

- **Spec Writer.** Lee el código, redacta la tarjeta y clasifica su impacto en el negocio (labels `auth`, `payments`, `pricing`, `schema`, `ops`). Si le falta una decisión, no la inventa: te la pregunta en el tablero.
- **Tarjeta como contrato.** Una tarjeta solo entra en Ready si pasa `factory lint`: Problem, Fix, Acceptance Criteria comprobables y Risk.
- **Dependencias.** Una tarjeta no sale de Ready hasta que lo que la bloquea está en Done.
- **Código que merece existir.** Cada paso carga la skill [ponytail](https://github.com/DietrichGebert/ponytail) (MIT, incluida en la fábrica): antes de escribir, se pregunta si eso tiene que existir, si ya está en el código, si lo da la librería estándar o una dependencia instalada, y solo entonces escribe el mínimo que funciona. Los reviewers usan `ponytail-review` y devuelven el código que sobra.
- **Cualquier agente de Orca.** Cada paso puede correr en un agente distinto (`agents` en `factory.config.json`): por ejemplo, los reviewers en Grok para no gastar cuota de Claude. Grok lee las mismas skills, instrucciones y guards de `.claude/`.
- **Panel de revisión.** Un reviewer por lente (`review.lenses`), todos a la vez y sobre el mismo commit. Tienen que aprobar todos; un solo fallo devuelve la tarjeta al Builder.
- **Merge gate.** Antes de mergear comprueba que la rama no ha cambiado desde la revisión, que contiene la base, que el panel entero aprobó ese commit y que `verify` pasa sobre él. Deja el merge a una persona si el riesgo es High, la tarjeta lleva un label de negocio, el diff toca una ruta sensible (`merge.humanPaths`), supera `merge.maxLines` o un reviewer lo escaló.
- **Rebotes.** La cuarta vuelta a Building pasa a Blocked para una persona.
- **Guard hooks.** Bloquean leer `.env`/claves, escribir claves literales, que los workers toquen la rama base y los borrados recursivos fuera del proyecto.

El plan y su estado están en [ROADMAP.md](ROADMAP.md); la arquitectura, en [CLAUDE.md](CLAUDE.md).

## Desarrollar

```sh
npm test                                   # suite completa (Node test runner)
node --test --test-name-pattern "<nombre>" "test/*.test.mjs"
factory eval [caso]                        # evals de skills con Claude Code headless (usa tu cuenta)
cd orca-plugin && orca plugin test .
```
