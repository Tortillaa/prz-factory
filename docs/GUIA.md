# Guía de uso de prz-factory

Cómo usar la fábrica, paso a paso: desde que escribes una idea hasta que el cambio está en `main`.

## El proceso de un vistazo

```text
 Tú                Spec Writer        Builder          Panel de reviewers            Merge gate
 ──                ───────────        ───────          ──────────────────            ──────────
 escribes   →      redacta la   →     construye   →    qa · security · code · ops →  cambio pequeño: se mergea solo
 una idea          tarjeta            con tests        (todos a la vez)              toca el negocio: te pide aprobación

 columna:  spec  →  ready  →  building  →  review  →  done
                                              └────→  blocked (te espera a ti)
```

Tú solo haces dos cosas: **mandar ideas** y **responder a las solicitudes** que te llegan al tablero. Todo lo demás lo hacen agentes, cada uno en su propio worktree de Orca.

| Quién | Qué hace | Qué no hace nunca |
|---|---|---|
| **Spec Writer** | Lee el código, convierte tu idea en una tarjeta completa, decide si toca el negocio y la pasa a Ready él solo | Escribir código, inventarse una decisión de producto |
| **Builder** | Construye la tarjeta en su rama, con los tests primero | Mergear |
| **Reviewers** (uno por lente) | Revisan el mismo commit en paralelo, cada uno con su especialidad | Arreglar el código, revisar fuera de su lente |
| **Merge gate** | Comprueba todo y mergea, o te pide aprobación | Mergear algo que no aprobó el panel entero |
| **Coordinador** | Lanza a los demás y te avisa | Construir, revisar o mergear |

---

## Parte 1 · Preparar un proyecto (una sola vez)

### Paso 1. Instala el comando `factory`

Necesitas Node 22 o superior, git y Orca.

```sh
cd C:\Users\aitor\Github\Documents\prz-factory
npm link            # deja el comando `factory` disponible en cualquier carpeta
factory --version   # comprueba que responde
```

### Paso 2. Instala la fábrica en tu proyecto

```sh
cd <tu proyecto>
factory install .   # copia los skills y los guard hooks a .claude/ y crea factory.config.json
factory doctor      # te dice qué falta
```

También puedes abrir Claude Code en el proyecto y decir **"onboard"**: el skill `factory-onboard` hace estos pasos contigo y te pregunta lo que necesita.

### Paso 3. Ajusta `factory.config.json`

Es el archivo donde decides cómo se comporta la fábrica en ese proyecto. Lo más importante:

```json
{
  "baseBranch": "main",
  "verify": ["npm test"],
  "maxWorkers": 4,
  "review": { "lenses": ["qa", "security", "code", "ops"] },
  "merge": {
    "humanRisk": ["high"],
    "humanLabels": ["auth", "payments", "pricing", "schema", "ops", "money", "needs-human"],
    "humanPaths": ["src/billing/**", "migrations/**", "**/*.sql"],
    "maxLines": 400
  }
}
```

| Campo | Qué decide |
|---|---|
| `verify` | Los comandos que demuestran que el proyecto funciona. Sin ellos, el merge gate no mergea nada. |
| `maxWorkers` | Cuántos agentes trabajan a la vez. Ponlo al menos igual al número de reviewers (4) para que el panel corra entero en paralelo. |
| `review.lenses` | Qué reviewers expertos revisan cada cambio. |
| `merge.humanLabels` | Las áreas de negocio. Una tarjeta con una de estas etiquetas nunca se mergea sola. |
| `merge.humanPaths` | **Las rutas sensibles de tu proyecto.** Si un cambio toca un archivo de esta lista, te pide aprobación, diga lo que diga la tarjeta. Es tu red de seguridad: no depende del criterio de ningún agente. |
| `merge.maxLines` | Un cambio con más líneas que esto también espera tu aprobación. |

**Dedica un minuto a `humanPaths`.** Pon ahí las carpetas donde vive el dinero, los permisos, la base de datos y el despliegue de tu proyecto.

### Paso 4. Guarda la configuración

```sh
factory agents-md                 # escribe las reglas del proyecto en CLAUDE.md, para los agentes
git add -A && git commit -m "Instala prz-factory"
```

Hay que commitear `.claude/` y `factory.config.json`: cada agente trabaja en un worktree nuevo y los necesita.

---

## Parte 2 · El día a día

### Paso 1. Abre el tablero

```sh
factory serve       # abre http://localhost:4747
```

Déjalo abierto. Se actualiza solo cuando los agentes mueven tarjetas.

### Paso 2. Manda una idea

En el tablero, pulsa **"+ Nueva idea"** (arriba a la izquierda) y escríbela con tus palabras: qué quieres y, si lo sabes, dónde.

> **Título:** el carrito pierde los productos
> **Cuerpo:** si cierro la pestaña y vuelvo, el carrito está vacío. Quiero que se conserve.

No hace falta formato ni detalle técnico. La tarjeta aparece en la columna **SPEC**.

Desde la terminal es lo mismo:

```sh
factory add "el carrito pierde los productos" --body "si cierro la pestaña y vuelvo, el carrito está vacío" --column spec
```

Puedes mandar varias ideas seguidas; la fábrica las va cogiendo por orden.

### Paso 3. Arranca la fábrica

Abre una sesión de Claude Code **dentro de Orca**, en el proyecto, y escribe:

```text
/factory-run
```

(o "arranca la fábrica"). Esa sesión es el **coordinador**. Lanza un agente por cada trabajo pendiente, te cuenta cada paso en una línea y te avisa cuando algo te necesita. No hace falta que mires: Orca lo despierta cuando un agente termina.

### Paso 4. Mira cómo avanza

En el tablero verás la tarjeta moverse sola:

1. **SPEC → READY.** El Spec Writer ha leído el código y ha reescrito tu idea como una tarjeta completa (problema, solución, criterios de aceptación comprobables y riesgo). Ábrela para leer lo que ha entendido.
2. **READY → BUILDING.** El Builder la construye en su rama.
3. **BUILDING → REVIEW.** Entra el panel. En la tarjeta ves una etiqueta por reviewer:

   | Etiqueta | Significa |
   |---|---|
   | `qa ·` | esperando reviewer |
   | `qa …` | revisando |
   | `qa ✓` | ha aprobado este commit |
   | `qa ✖` | ha encontrado un bloqueo |

4. **REVIEW → DONE**, si los cuatro aprueban y el cambio es pequeño. Ya está en `main`.

Si un reviewer encuentra un problema, la tarjeta vuelve a **BUILDING** con el hallazgo, el Builder lo arregla y el panel la revisa otra vez desde cero. A la cuarta vuelta sin converger, la fábrica para y te la manda a ti.

Qué mira cada reviewer:

| Reviewer | Su pregunta |
|---|---|
| **qa** | ¿Hace lo que dice la tarjeta, y hay un test que lo notaría si dejara de hacerlo? |
| **security** | ¿Se puede abusar de este cambio? |
| **code** | ¿Es el cambio correcto, y solo ese cambio? |
| **ops** | ¿Qué le hace esto al negocio y al producto en marcha? |

### Paso 5. Responde a las solicitudes

Cuando algo te necesita, aparece una franja amarilla arriba del tablero: **"🙋 N solicitudes esperan tu respuesta"**. El coordinador también te lo dice en el chat. Hay dos tipos.

#### Solicitud de tipo "aprobar merge"

El cambio está construido y **aprobado por todo el panel**, pero toca el negocio, así que no se mergea sin ti. Pasa cuando:

- la tarjeta es de riesgo **High**,
- lleva una etiqueta de negocio (`auth`, `payments`, `pricing`, `schema`, `ops`),
- toca una ruta de `merge.humanPaths`,
- supera `merge.maxLines` líneas, o
- un reviewer lo ha escalado (`needs-human`).

Qué haces:

1. Pulsa la solicitud. Lee el último comentario `[merge]`: dice **por qué** te lo pide, la rama y el commit.
2. Lee los comentarios de los reviewers (`review:qa`, `review:security`, `review:code`, `review:ops`).
3. Si quieres ver el código: `git diff main...<rama>`.
4. Para aprobar, pulsa **"Aprobar y mergear"**. El merge gate vuelve a ejecutar `verify` y lo mergea.
   Desde la terminal: `factory merge <id> --sha <commit> --human`.
5. Si no lo apruebas, escribe por qué en un comentario y arrastra la tarjeta a **BUILDING** (para que lo cambien) o a **BACKLOG** (para aparcarla).

La aprobación queda fijada al commit que revisaste: si alguien añade commits después, el merge se niega.

#### Solicitud de tipo "responder"

Un agente no puede seguir sin una decisión tuya. Lo habitual es que el **Spec Writer** tenga una pregunta de producto que tu idea no contesta ("¿se crean cuentas nuevas al entrar con Google, o solo las existentes?").

Qué haces:

1. Pulsa la solicitud y lee la pregunta en el último comentario.
2. Contesta con un **comentario** en la tarjeta.
3. Arrastra la tarjeta de vuelta a la columna donde estaba: a **SPEC** si preguntaba el Spec Writer, a **BUILDING** si preguntaba el Builder.

La fábrica la recoge en el siguiente ciclo, con tu respuesta.

### Paso 6. Termina

Cuando no queda nada por hacer, el coordinador te da el resumen: qué se ha mergeado (con sus commits), qué espera tu aprobación y qué está bloqueado.

De vez en cuando, limpia los worktrees y las ramas de las tarjetas terminadas:

```sh
factory cleanup            # lista lo que se puede borrar
factory cleanup --apply    # lo borra
```

---

## Parte 3 · Situaciones concretas

| Quiero… | Haz |
|---|---|
| Ver el estado sin abrir la web | `factory status` |
| Parar la fábrica | Di "stop" al coordinador |
| Escribir yo la tarjeta completa, sin Spec Writer | "+ Nueva tarjeta" en BACKLOG, o pide a Claude "escribe una tarjeta para…" (skill `factory-lint`), y muévela a READY |
| Que una idea no se trabaje todavía | Déjala en **BACKLOG**: la fábrica nunca coge nada de ahí. Arrástrala a SPEC cuando quieras |
| Cambiar la prioridad | Arrastra las tarjetas dentro de la columna: se trabajan de arriba abajo |
| Que una tarjeta espere a otra | Edítala y pon el número de la otra en "Bloqueada por" |
| Buscar problemas en el código y convertirlos en tarjetas | Pide a Claude "busca problemas" (skill `factory-collect`). Llegan a BACKLOG; mueve a SPEC las que quieras |
| Probar algo que ya está en `main`, sin construir nada | Una tarjeta con la etiqueta `qa`: un agente la prueba y abre una idea por cada fallo |
| Forzar que un cambio pase por mí | Añade la etiqueta `needs-human` a la tarjeta |
| Añadir o quitar un reviewer | Cambia `review.lenses` en `factory.config.json` |
| Ver todos los comandos | `factory --help` |

### Si algo va mal

| Síntoma | Causa y solución |
|---|---|
| El panel ha aprobado, pero la tarjeta sigue en REVIEW | Tu checkout de `main` tiene cambios sin commitear y el merge gate no lo toca. Haz commit o stash y ejecuta `factory merge <id>`. |
| Una tarjeta rebota entre BUILDING y REVIEW | A la cuarta vuelta pasa sola a BLOCKED con una solicitud. Lee los hallazgos: suele faltar una decisión en la tarjeta. |
| Una tarjeta está en BLOCKED y no sé por qué | Ábrela: el último comentario lo explica. |
| Un agente se ha quedado colgado | `factory status` marca los claims viejos con ⚠️. Di "status" al coordinador, o libérala con `factory reclaim <id>`. |
| `factory doctor` falla | Sigue la línea `→` que acompaña a cada fallo. |
| La fábrica no coge mis tarjetas | Comprueba que están en SPEC o READY (no en BACKLOG) y que el coordinador está en marcha. |

---

## Resumen en cinco líneas

1. `factory serve` y abre el tablero.
2. **"+ Nueva idea"**: escribe lo que quieres.
3. `/factory-run` en una sesión de Claude Code dentro de Orca.
4. Los cambios pequeños llegan solos a `main`.
5. Los que tocan el negocio aparecen en la franja de solicitudes: léelos y pulsa **"Aprobar y mergear"**.
