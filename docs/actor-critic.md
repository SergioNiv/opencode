# Patrón Actor-Crítico en opencode

El patrón **Actor-Crítico** (también *Generator-Evaluator*) usa dos modelos:

- **Actor (Generator):** produce el código o la solución.
- **Crítico (Evaluator):** revisa el resultado contra los requisitos, encuentra
  fallos y devuelve una crítica accionable.

En esta configuración:

| Rol     | Agente          | Modelo                   | Modo       |
| ------- | --------------- | ------------------------ | ---------- |
| Actor   | `actor`         | `llama-local/qwen3.8`    | primary    |
| Actor   | `actor-managed` | `llama-local/qwen3.8`    | primary    |
| Crítico | `critic`        | `deepseek/deepseek-flash`| all        |

El Crítico se ejecuta siempre con la variante **`max`** (`reasoningEffort: max`),
definida en `agent/critic.md`, para que su análisis sea lo más profundo posible.

Hay **dos variantes** del mismo patrón:

1. **Variante A — subagente (manual):** el propio Actor decide cuándo llamar al
   Crítico usando la herramienta `task`. No requiere plugin.
2. **Variante B — plugin (automática):** un plugin engancha el final de cada
   turno del Actor y lanza al Crítico automáticamente, en bucle, hasta que
   aprueba. No depende de que el modelo local decida llamar al crítico.

---

## Requisitos

- `qwen3.8` accesible en `http://192.168.68.108:8000/v1` (vLLM del PC).
- `deepseek-flash` con API key válida (`api.deepseek.com`).
- Reiniciar opencode tras crear/editar cualquier agente, comando, plugin o
  `opencode.json`: la configuración **no** se recarga en caliente.

---

## Variante A — subagente (manual)

**Archivos**

- `~/.config/opencode/agent/actor.md` — primario, `llama-local/qwen3.8`.
- `~/.config/opencode/agent/critic.md` — subagente, `deepseek/deepseek-flash`,
  solo lectura (`edit: deny`).
- `~/.config/opencode/command/ac.md` — comando `/ac`.

**Cómo funciona**

1. El Actor planifica e implementa.
2. Al tener una primera versión, llama al subagente `critic` con la herramienta
   `task` (el prompt del Actor lo obliga).
3. El Crítico responde `VEREDICTO: APROBADO | CAMBIOS REQUERIDOS` + lista de
   hallazgos.
4. El Actor aplica las correcciones y repite (máx. 3 iteraciones).

**Uso**

- `/ac <tarea>` — arranca directamente en el agente `actor`.
- O pulsa `Tab`, selecciona el agente **actor** y escribe la tarea.

**Ventaja / límite:** funciona sin plugin, pero la calidad del bucle depende de
que el modelo local (27B) siga las instrucciones y llame al crítico.

---

## Variante B — plugin (automática)

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
| `maxDiffChars`       | `40000`         | Tamaño máximo del diff enviado al crítico (se trunca si excede).   |
| `keepCriticSession`  | `false`         | Si `true`, no borra la sesión hija del crítico (útil para depurar).|

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

## ¿Cuál elegir?

- Modelo local poco fiable siguiendo instrucciones → **Variante B (plugin)**.
- Quieres algo simple, sin plugins, con control manual → **Variante A**.
- Puedes tener ambas activas: `/ac` usa A, `/acp` usa B.

---

## Personalización

- **Cambiar modelos:** edita `model:` en `agent/actor.md`,
  `agent/actor-managed.md` y `agent/critic.md`.
- **Cambiar el criterio del crítico:** edita el prompt o el formato de salida en
  `agent/critic.md`. El plugin considera aprobado cuando aparece
  `VEREDICTO: APROBADO` (regex `VEREDICTO\s*:\s*APROBADO`, sin distinguir
  mayúsculas). Si cambias ese texto, actualiza también el regex en
  `plugin/actor-critic.ts`.
- **Ser más estricto:** sube `maxIterations` y/o endurece el prompt del crítico.
- **Ámbito por proyecto:** mueve los agentes a `.opencode/agent/` del repo si
  prefieres que el patrón viva con el proyecto en lugar de global.

---

## Problemas comunes

- **No aparece el agente/comando:** reinicia opencode.
- **El plugin no arranca:** revisa `logLevel: "DEBUG"` y los logs; verifica que
  `./plugin/actor-critic.ts` exista en `~/.config/opencode/`.
- **El Crítico intenta editar archivos:** su permiso es `edit: deny`; si necesita
  ejecutar tests, `bash` está en `ask` y pedirá confirmación.
- **El bucle no avanza en la variante B:** confirma que el mensaje inicial usó el
  agente `actor-managed` (p. ej. vía `/acp`); el plugin solo se arma con ese
  agente.
- **Aparecen sesiones `[critic] revisión N`:** solo deberían quedar si pusiste
  `keepCriticSession: true` o si el bucle falló a mitad. Bórralas a mano; son
  desechables.
- **El diff no se detecta:** `collectDiff` usa `git diff` sobre `HEAD` (y lista
  archivos sin trackear). Fuera de un repo git cae al resumen de `session.diff`.
- **Se corta por contexto:** el actor local tiene `context: 128000`; para tareas
  largas sube `compaction` o divide la tarea.
