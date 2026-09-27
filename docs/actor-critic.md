# Patrón Actor-Crítico en opencode

El patrón **Actor-Crítico** (también *Generator-Evaluator*) usa dos modelos:

- **Actor (Generator):** produce el código o la solución.
- **Crítico (Evaluator):** revisa el resultado contra los requisitos, encuentra
  fallos y devuelve una crítica accionable.

En esta configuración:

| Rol     | Agente                  | Modelo                   | Modo       |
| ------- | ----------------------- | ------------------------ | ---------- |
| Actor   | `actor-managed`         | `llama-local/qwen3.8`    | primary    |
| Actor   | `actor-managed-inline`  | `llama-local/qwen3.8`    | primary    |
| Crítico | `critic`                | `deepseek/deepseek-flash`| all        |

Hay **un solo Crítico** (`critic`), que se ejecuta siempre con la variante
**`max`** (`reasoningEffort: max`) definida en su agente. Lo que cambia entre
variantes no es el crítico, sino **cómo el plugin lo invoca**.

Hay **dos variantes** del mismo patrón:

1. **Variante 1 — plugin, sesión hija (automática):** el plugin engancha el
   final de cada turno del Actor y lanza al Crítico en una **sesión hija**
   desechable, en bucle, hasta que aprueba. No depende del modelo local.
2. **Variante 2 — plugin, misma sesión (automática):** igual que la 1, pero el
   plugin **inyecta el prompt del Crítico en la propia sesión del Actor**, así
   que ves el prompt y la respuesta en la UI.

---

## Requisitos

- `qwen3.8` accesible en `http://192.168.68.108:8000/v1` (vLLM del PC).
- `deepseek-flash` con API key válida (`api.deepseek.com`).
- Reiniciar opencode tras crear/editar cualquier agente, comando, plugin o
  `opencode.json`: la configuración **no** se recarga en caliente.

> **El crítico lo lanza solo el plugin.** En `opencode.json` la herramienta
> `task` tiene `"critic": "deny"` (denegado), así que ningún modelo puede
> invocarlo por su cuenta: su `description` ni siquiera aparece en el prompt de
> `task`. Solo lo lanzan las variantes 1 y 2 (`/acp`, `/acpi`), que no usan
> `task` sino la API de sesiones.

---

## Variante 1 — plugin, sesión hija (automática)

**Archivos**

- `~/.config/opencode/plugin/actor-critic.ts` — orquestador.
- `~/.config/opencode/agent/actor-managed.md` — actor sin instrucción de `task`.
- `~/.config/opencode/agent/critic.md` — mismo crítico (`mode: all`).
- `~/.config/opencode/command/acp.md` — comando `/acp`.
- `~/.config/opencode/opencode.json` — registra el plugin.

**Cómo funciona**

El plugin escucha los eventos de opencode:

1. Con `chat.message` **arma** el bucle cuando detecta un mensaje dirigido al
   agente `actor-managed` (guarda los requisitos originales).
2. Con `event: session.idle` detecta que el Actor terminó su turno, calcula el
   **diff** (`git diff`, o resumen vía `session.diff`) y crea una **sesión hija**
   del Crítico con título `[critic] revisión N — <tarea>`.
3. Lanza al Crítico en esa sesión hija con solo **requisitos + diff** (no el
   historial completo del Actor).
4. Cuando el Crítico termina, lee su veredicto y **borra la sesión hija**
   automáticamente:
   - `VEREDICTO: APROBADO` → termina y muestra un toast de éxito.
   - `CAMBIOS REQUERIDOS` → reinyecta la crítica al Actor y repite.
5. Se detiene al aprobar o al superar `maxIterations`, con un toast.

**Por qué una sesión hija:** el input del Crítico queda **acotado** (requisitos
+ diff + lo que lea), en lugar de crecer con todo el historial del Actor. Así se
gastan menos tokens cloud. La hija es desechable y se borra tras cada revisión,
de modo que solo te queda la sesión **padre** (la del Actor) para continuar.

**Uso**

- `/acp <tarea>` — arranca en el agente `actor-managed` y el plugin hace el
  resto.

**Configuración del plugin** (`opencode.json`):

```json
"plugin": [
  [
    "./plugin/actor-critic.ts",
    {
      "maxIterations": 3,
      "actorAgent": "actor-managed",
      "criticAgent": "critic",
      "actorModel": "llama-local/qwen3.8",
      "criticModel": "deepseek/deepseek-flash",
      "maxDiffChars": 40000,
      "keepCriticSession": false
    }
  ]
]
```

| Opción               | Default         | Descripción                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `maxIterations`      | `3`             | Correcciones máximas antes de parar.                               |
| `actorAgent`         | `actor-managed` | Agente que arranca el bucle.                                       |
| `criticAgent`        | `critic`        | Agente evaluador.                                                  |
| `actorModel`         | (el del agente) | Fuerza el modelo del Actor (formato `proveedor/modelo`).           |
| `criticModel`        | (el del agente) | Fuerza el modelo del Crítico (formato `proveedor/modelo`).         |
| `maxDiffChars`       | `40000`         | Tamaño máximo del diff enviado al crítico (se trunca si excede).   |
| `keepCriticSession`  | `false`         | Si `true`, no borra la sesión hija del crítico (útil para depurar).|

> `actorModel`/`criticModel` son **opcionales**: si los omites, se usa el `model:`
> definido en el archivo del agente. Al forzarlos aquí, ten en cuenta que la
> `variant` del agente puede no aplicarse (ver la sección “Cambiar el modelo”).

**Ventaja / límite:** el bucle es determinista, no depende del modelo local y
gasta menos tokens cloud (input del crítico acotado). A cambio, el crítico solo
juzga el resultado (el diff), no el proceso intermedio. Requiere que el plugin
esté registrado y que opencode se reinicie.

**Sobre las sesiones:** las hijas del crítico son de tipo “hija” (llevan
`parentID`), no aparecen como sesiones sueltas del proyecto y se **borran**
automáticamente tras cada revisión. Para continuar una tarea, retoma siempre la
sesión **padre** (donde escribiste el mensaje). Si activas
`keepCriticSession: true` para depurar, aparecerán con el título
`[critic] revisión N — …`; bórralas a mano cuando termines.

---

## Variante 2 — plugin, crítica en la misma sesión

**Archivos**

- `~/.config/opencode/plugin/actor-critic.ts` — mismo orquestador, en modo
  `inline`.
- `~/.config/opencode/agent/actor-managed-inline.md` — actor sin instrucción de
  `task`, mismo modelo local.
- `~/.config/opencode/agent/critic.md` — el **mismo** crítico que la variante 1.
- `~/.config/opencode/command/acpi.md` — comando `/acpi`.

**Cómo funciona**

1. Con `chat.message` **arma** el bucle cuando detecta un mensaje al agente
   `actor-managed-inline`.
2. Con `event: session.idle` detecta que el Actor terminó y **inyecta el prompt
   del Crítico en la MISMA sesión** con `agent=critic`; verás ese prompt y la
   respuesta del Crítico en el hilo de la sesión.
3. Cuando el Crítico termina, lee su veredicto en esa misma sesión:
   - `VEREDICTO: APROBADO` → termina y muestra un toast de éxito.
   - `CAMBIOS REQUERIDOS` → reinyecta la crítica al Actor (`agent` del Actor) y
     repite.
4. Se detiene al aprobar o al superar `maxIterations`, con un toast.

**Diferencia con la variante 1**

- **Ventaja:** todo el bucle queda **visible** en la sesión del Actor; se ve
  exactamente qué prompt recibe el Crítico.
- **Coste:** el Crítico ve **todo el historial** de la sesión (no solo requisitos
  + diff), así que gasta más tokens cloud que la variante 1.

**Uso**

- `/acpi <tarea>` — arranca en `actor-managed-inline` y el plugin hace el resto.

**Configuración del plugin** (`opencode.json`):

```json
{
  "actorAgent": "actor-managed",
  "criticAgent": "critic",
  "inlineActorAgent": "actor-managed-inline"
}
```

| Opción               | Default         | Descripción                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `inlineActorAgent`   | (desactivado)   | Activa la variante 2 para ese agente. Si se omite, no existe.      |
| `inlineCriticAgent`  | `critic`        | Crítico de la variante 2 (se inyecta en la sesión del Actor).      |
| `inlineActorModel`   | (el del agente) | Fuerza el modelo del Actor de la variante 2.                       |
| `inlineCriticModel`  | (el del agente) | Fuerza el modelo del Crítico de la variante 2.                     |

> `actorAgent`/`criticAgent` son las opciones de la variante 1 e `inline*` las de
> la variante 2; ambas conviven en la **misma** instancia del plugin y comparten
> el crítico `critic`.

---

## ¿Cuál elegir?

- Priorizas gastar menos tokens cloud → **Variante 1** (crítico en sesión hija).
- Prefieres **ver el prompt del crítico** en la UI → **Variante 2** (misma sesión).
- Ambas conviven: `/acp` usa la variante 1 y `/acpi` la variante 2.

---

## Cambiar el modelo del Actor y del Crítico

Hay tres formas, de la más permanente a la más puntual.

### 1. Por agente (recomendado)

Edita el campo `model:` en el archivo del agente. El formato es
`proveedor/modelo`:

| Agente          | Archivo                         | Modelo actual             |
| --------------- | ------------------------------- | ------------------------- |
| Actor (var. 1)  | `agent/actor-managed.md`        | `llama-local/qwen3.8`     |
| Actor (var. 2)  | `agent/actor-managed-inline.md` | `llama-local/qwen3.8`     |
| Crítico (todas) | `agent/critic.md`               | `deepseek/deepseek-flash` |

Ejemplo para cambiar el Crítico a otro modelo:

```yaml
---
model: deepseek/deepseek-reasoner
variant: max
---
```

- El `model:` del agente **manda** sobre el modelo global/sesión.
- El campo `variant:` selecciona una de las `variants` del modelo definidas en
  `opencode.json` (p. ej. `max`, `high`, `low`). Es la forma de fijar el esfuerzo
  de razonamiento (el Crítico ya usa `variant: max`).
- Requiere **reiniciar opencode**.

### 2. Por plugin (variantes 1 y 2, sin editar agentes)

Añade `actorModel`/`criticModel` (variante 1) y/o
`inlineActorModel`/`inlineCriticModel` (variante 2) a las opciones del plugin en
`opencode.json`:

```json
[
  "./plugin/actor-critic.ts",
  {
    "actorModel": "llama-local/qwen3.8",
    "criticModel": "deepseek/deepseek-flash"
  }
]
```

- Formato `proveedor/modelo`.
- Si se omiten, el plugin usa el `model:` del agente correspondiente.
- Requiere **reiniciar opencode**.
- Ojo: al forzar el modelo desde el plugin, la **`variant` del agente puede no
  aplicarse**. Si necesitas el Crítico en `max`, deja
  `options.reasoningEffort: max` en `agent/critic.md` (ya está puesto).

### 3. Puntual en la TUI (solo Actor primario)

- Puedes cambiar el modelo de la sesión con el selector de modelos de la TUI.
- Pero si el agente define `model:`, ese gana. Para que el Actor use el modelo
  que elijas en la TUI, **quita el campo `model:`** de `actor-managed.md` /
  `actor-managed-inline.md` (entonces hereda el modelo por defecto/sesión).
- El Crítico **no** se controla desde el selector: lo lanza el plugin, y su
  modelo sale de `critic.md` o de `criticModel`/`inlineCriticModel`. Para
  cambiarlo puntualmente, usa la opción 1 o 2.

### Añadir modelos o variantes nuevos

Los modelos disponibles son los definidos en `provider.<id>.models` de
`opencode.json`. Ahí mismo defines sus `variants` (p. ej. `reasoningEffort`).
Tras añadir uno, úsalo en el agente como `proveedor/modelo`.

---

## Personalización

- **Cambiar el criterio del crítico:** edita el prompt o el formato de salida en
  `agent/critic.md` (afecta a ambas variantes). El plugin considera aprobado
  cuando aparece `VEREDICTO: APROBADO` (regex `VEREDICTO\s*:\s*APROBADO`, sin
  distinguir mayúsculas). Si cambias ese texto, actualiza también el regex en
  `plugin/actor-critic.ts`.
- **Ser más estricto:** sube `maxIterations` y/o endurece el prompt del crítico.
- **Ámbito por proyecto:** mueve los agentes a `.opencode/agent/` del repo si
  prefieres que el patrón viva con el proyecto en lugar de global.

---

## Problemas comunes

- **No aparece el agente/comando:** reinicia opencode.
- **El plugin no arranca:** revisa `logLevel: "DEBUG"` y los logs; verifica que
  `./plugin/actor-critic.ts` exista en `~/.config/opencode/`.
- **El Crítico intenta editar archivos:** su permiso es `edit: deny`; para
  inspeccionar puede usar `bash`, que está en `allow` (`critic.md`), así que no
  pide confirmación. Nota: `bash: allow` no impide escrituras vía shell; la
  restricción de solo lectura es por prompt.
- **El bucle no avanza en la variante 1:** confirma que el mensaje inicial usó el
  agente `actor-managed` (p. ej. vía `/acp`); el plugin solo se arma con ese
  agente.
- **El bucle no avanza en la variante 2:** confirma que el mensaje inicial usó el
  agente `actor-managed-inline` (p. ej. vía `/acpi`), y que `inlineActorAgent`
  está configurado en `opencode.json`.
- **Aparecen sesiones `[critic] revisión N`:** solo deberían quedar si pusiste
  `keepCriticSession: true` o si el bucle falló a mitad. Bórralas a mano; son
  desechables.
- **El diff no se detecta:** `collectDiff` usa `git diff` sobre `HEAD` (y lista
  archivos sin trackear). Fuera de un repo git cae al resumen de `session.diff`.
- **Se corta por contexto:** el actor local tiene `context: 128000`; para tareas
  largas sube `compaction` o divide la tarea.
