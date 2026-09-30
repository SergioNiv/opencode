# Documentación del plugin `actor-critic.ts`

Documentación del plugin **Actor-Crítico** de opencode y de los **bugs de
opencode v1.18.33** que tuvimos que rodear con un parche en el propio plugin.

## Archivos

| Archivo | Qué dice |
|---------|----------|
| [actor-critic.md](./actor-critic.md) | Cómo funciona el patrón Actor-Crítico (variantes 1 y 2, modelos, personalización). |
| [parche-actor-critic.md](./parche-actor-critic.md) | **El parche aplicado:** los 4 cambios hechos en el plugin (con código y líneas). |
| [upgrade-checklist.md](./upgrade-checklist.md) | **Qué configurar si opencode parchea el bug.** Checklist paso a paso. |

## TL;DR — el estado actual

- **opencode v1.18.33 no entrega las opciones del plugin.** La tupla
  `["./plugin/actor-critic.ts", {…}]` de `opencode.json` se parsea bien, pero el
  parámetro `options` llega `undefined` al plugin (**Bug 1**). El plugin lo rodea
  leyendo un **sidecar** `plugin/actor-critic.options.json` + la env
  `ACTOR_CRITIC_KEEP_CRITIC_SESSION`. Por eso **hoy se edita el sidecar, no
  `opencode.json`**.
- **Las sesiones del crítico ahora son de primer nivel** (sin `parent_id`), así
  que **aparecen** en `session list`/TUI cuando `keepCriticSession: true`. Antes
  eran hijas y quedaban ocultas (**Bug 2**).
- **`maxIterations=N` crea exactamente N sesiones del crítico** (se ajustó el
  umbral a `>=`).

## ¿Qué configuro si opencode parchea el Bug 1?

**Resposta corta:** nada en el plugin. Cuando opencode sí entregue las opciones,
el valor de **`opencode.json`** volverá a mandar (el plugin prioriza lo nativo
sobre el sidecar por clave) y el sidecar quedará como respaldo. Pasos de
detección y limpieza: **[upgrade-checklist.md](./upgrade-checklist.md)**.

Detección rápida:

```bash
rm -f /tmp/actor-critic-debug.log
ACTOR_CRITIC_DEBUG=1 opencode
grep 'INIT' /tmp/actor-critic-debug.log
#   rawOptions=undefined          → bug AÚN presente (sidecar activo)
#   rawOptions={ "maxIterations": … } → bug YA parcheado (nativo manda)
```

> El probe está **off por defecto**: sin `ACTOR_CRITIC_DEBUG=1` el plugin no
> escribe a `/tmp` en cada arranque.

## ¿Cómo funciona el bucle? (resumen)

1. El Actor termina su turno (`session.idle`).
2. El plugin crea una sesión de primer nivel `[critic] revisión N` y le envía
   **requisitos + diff**.
3. El Crítico emite `VEREDICTO: APROBADO` → fin (toast de éxito) — o rechaza →
   la corrección vuelve a la **sesión original del Actor** y se repite con una
   **nueva** sesión del crítico.
4. Se detiene al aprobar o al llegar a `maxIterations` revisiones.

Detalle completo del patrón: [actor-critic.md](./actor-critic.md).

## Opciones del plugin (resumen)

| Opción | Default | Descripción |
|--------|---------|-------------|
| `keepCriticSession` | `false` | Si `true`, no borra la sesión del crítico tras el veredicto (depurar). |
| `maxIterations` | `3` | **N sesiones de crítico exactas** por tarea. |
| `actorAgent` | `actor-managed` | Agente que arranca el bucle (variante 1). |
| `criticAgent` | `critic` | Agente evaluador. |
| `inlineActorAgent` | — | Si se define, activa la variante 2 (crítica en la misma sesión). |
| `maxDiffChars` | `40000` | Tamaño máximo del diff enviado al crítico (se trunca). |
| `maxContextChars` | `4000` | Contexto máximo de la sesión enviado al crítico. |

> **Fuentes de opciones (hoy):** `ACTOR_CRITIC_KEEP_CRITIC_SESSION` (env, solo
> `keepCriticSession`) > `opencode.json` (nativo, ignorado por el Bug 1) >
> **sidecar `plugin/actor-critic.options.json`** (la que manda hoy) > defaults.
