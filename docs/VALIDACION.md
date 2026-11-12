# Validación de prz-factory

Registro de la Fase 13 del [ROADMAP](../ROADMAP.md): qué se ha probado con agentes reales, cuánto ha tardado y qué ha fallado. Cada paso añade aquí sus números.

Configuración usada: Spec Writer y Builder en Claude Sonnet 5.5 (con subagente Opus 5.5), cuatro reviewers en Grok 4.7 con esfuerzo alto, agente de merge en Claude Haiku 5.5, `maxWorkers: 4`.

## Paso 2 · Ejecución completa en este repo (12 de noviembre de 2026)

Tres tarjetas reales, con el coordinador (`factory-run`) despachando workers de Orca:

| Tarjeta | Qué es | Camino que debía probar | Resultado |
|---|---|---|---|
| #6 | `factory list --column` avisa si la columna no existe | Aprobación de una persona (toca `src/store.mjs`, ruta sensible) | ✅ Llegó a `blocked` con la solicitud en lenguaje claro; espera la aprobación |
| #7 | `factory status` deja de marcar como "stale" un worker relanzado | Merge automático | ✅ Mergeada sola en `a92bab7` |
| #8 | El guard bloquea el force-push a `main` escrito como `+main` | Solicitud por ruta sensible (`hooks/`) | ⚠️ Cinco rondas de review; el límite de devoluciones la llevó a una persona dos veces. En curso |

### Tiempos

| Tarjeta | Spec | Build | Panel de review | Merge | Total |
|---|---|---|---|---|---|
| #7 | 1 min | 2 min | 13 min (esperando huecos) | 1 min | **17 min** de la idea a `main` |
| #6 (tras el rebase) | — | 3 min | 7 min | 1 min | 11 min hasta la solicitud |
| #8 | 1 min | 2–3 min por ronda | 12–20 min por ronda | — | más de 4 h, con dos paradas por decisión humana y una por cuota |

### Lo que funcionó

- **El camino automático completo** (#7): idea → spec → build → cuatro reviewers → agente de merge → `main`, sin intervención.
- **La solicitud a una persona** (#6): el agente de merge (Haiku) escribió qué cambia, por qué se pregunta y cómo deshacerlo, y lanzó el gate sin intentar aprobar por su cuenta.
- **El panel paró un arreglo de seguridad incompleto** (#8): el reviewer `security` encontró, con pruebas reales en git, nueve formas de forzar `main` que el guard no veía; el `code`, después, cuatro casos en que bloqueaba de más.
- **El límite de devoluciones**: a la cuarta vuelta, la #8 pasó sola a `blocked` con `needs-you`.
- **El subagente Opus** (#8, ronda 4): el Builder lo usó para rediseñar la regla como "bloquear por defecto". Funcionó, pero añadió cosas fuera de alcance que el reviewer `code` detectó.
- **El gate**: devolvió la #6 al Builder para hacer rebase cuando su rama se quedó atrás.

### Evals con agentes reales

Las 8 pasan: `spec-empty-cart` y `spec-pricing-is-business` (Sonnet), `build-empty-cart` (Sonnet), `review-code-pass`, `review-qa-missing-test` y `review-ops-escalates-pricing` (Grok), `merge-lands` y `merge-escalates-pricing` (Haiku). `review-ops-escalates-pricing` falló primero por un fallo del eval, no del agente: esperaba el comportamiento anterior a la columna `merge`. Está corregido.

### Lo que falló o costó de más

| Problema | Consecuencia | Estado |
|---|---|---|
| Un reviewer seguía trabajando cuando otra lente ya había cerrado la ronda | Cuota gastada en trabajo que no cuenta: 5 reviewers parados a mano y 4 que terminaron sin poder registrar nada | Arreglado en la rama `docs/validacion`: `status.toStop` y el coordinador los para |
| Workers con el mismo nombre en rondas distintas | Un reviewer de la ronda 2 registró su veredicto con la reserva de la ronda 3 | Arreglado: el nombre lleva la ronda (`review-qa-8-r3`) |
| Terminales y worktrees acumulados en Orca | 14 terminales y 5 worktrees de más | Arreglado: el coordinador libera siempre y limpia tras cada merge |
| El Builder no pedía ayuda a Opus aunque la tarjeta volviera | Dos rondas más de la #8 | Arreglado: el spec del Builder lo exige cuando la tarjeta ha vuelto |
| Cada merge obliga a rebase y revisión completa de las demás tarjetas | La #6 y la #8 se quedaron atrás al mergearse la #7 | Abierto |
| El panel no cabe con `maxWorkers: 4` si hay Builders trabajando | El panel de la #7 tardó 13 min en vez de unos 5 | Abierto |
| El gate mergea sobre el checkout de la persona | Una edición sin commitear bloqueó la aprobación de la #6 | Abierto |
| Arreglos de seguridad por lista negra | Tres rondas de la #8 tapando sintaxis de git | Abierto: el Spec Writer debería pedir de entrada un diseño que bloquee por defecto |
| Cuota de Claude | Un Builder se paró a mitad de ronda | El coordinador ya sabe reintentar la misma tarea |
| Formato de commits | El reviewer `code` vio commits sin `Card: #N` | Abierto: nada lo comprueba |

### Cifras

- **41 workers lanzados** para 3 tarjetas: 2 Spec Writers, 8 Builders (6 solo para la #8), 28 reviewers, 2 agentes de merge y 1 reintento por cuota.
- **28 de los 41 fueron reviewers**: el panel de cuatro lentes es la parte que más agentes consume, sobre todo cuando una tarjeta rebota.
- **Coste por tarjeta:** no se puede medir todavía. Orca no da el consumo por worker; solo vemos que la cuota de Claude se agotó una vez con 4 workers en marcha. Para el paso 4 hará falta una forma de medirlo.

## Paso 3 · Piloto

Pendiente: falta elegir el repositorio.
