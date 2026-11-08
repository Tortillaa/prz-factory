# prz-factory

Una fábrica de software para agentes de código que corre en [Orca](https://www.onorca.dev/). Escribes tarjetas en un tablero local, las mueves a **Ready**, y la fábrica las devuelve probadas, revisadas y mergeadas: un worker de Orca por tarjeta y lane (build → QA → review), cada uno en su worktree, y un merge gate que solo deja entrar en la rama base el commit exacto que se revisó y verificó.

Inspirada en [super-board](https://github.com/EricTechPro/super-board) (MIT), con tablero propio en `localhost` en lugar de GitHub Projects y merges locales por fast-forward.

## Requisitos

Node 22 o superior, git, y Orca para lanzar workers (el tablero, el CLI y los lanes funcionan sin él).

## Instalar en un proyecto

```sh
git clone <este repo> prz-factory && cd prz-factory && npm link   # deja `factory` en el PATH
cd <tu proyecto>
factory install .      # skills y guard hooks en .claude/, factory.config.json
factory doctor         # qué falta
```

O, desde Claude Code en el proyecto, pide "onboard" y el skill `factory-onboard` te guía: comprueba `verify`, la política de merge y el bloque para agentes.

## Usar

| Para | Haz |
|---|---|
| Ver el tablero | `factory serve` → http://localhost:4747 (o el panel de Orca, ver `orca-plugin/`) |
| Escribir una tarjeta | botón "+ Nueva tarjeta", `factory add`, o pide al skill `factory-lint` que la redacte contigo |
| Encontrar problemas y convertirlos en tarjetas | skill `factory-collect` |
| Vaciar el tablero | skill `factory-run` en una sesión de Claude Code dentro de Orca |
| Ver qué pasa | `factory status` |
| Parar | pide "stop" al coordinador (`factory stop` + `orca orchestration worker-stop`) |
| Aprobar un merge que espera a una persona | botón "Aprobar y mergear" en la tarjeta, o `factory merge <id> --sha <sha> --human` |
| Limpiar worktrees y ramas de tarjetas terminadas | `factory cleanup --apply` |

`factory --help` lista todos los comandos.

## Cómo decide

- **Tarjeta como contrato.** Una tarjeta solo entra en Ready si pasa `factory lint`: Problem, Fix, Acceptance Criteria comprobables y Risk.
- **Dependencias.** Una tarjeta no sale de Ready hasta que lo que la bloquea está en Done.
- **Merge gate.** Antes de mergear comprueba que la rama no ha cambiado desde la revisión, que contiene la base y que `verify` pasa sobre ese commit. Deja el merge a una persona si el riesgo es High, hay labels sensibles o el diff supera `merge.maxLines`.
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
