# Checklist — si opencode parchea el Bug 1

El documento principal para la pregunta: **"¿qué configuro si algún día opencode
arregla el bug de las opciones?"**

Contexto: hoy opencode 1.18.33 **no** entrega las opciones de la tupla al plugin
(Bug 1), así que la fuente activa es el **sidecar**
`plugin/actor-critic.options.json` (+ la env `ACTOR_CRITIC_KEEP_CRITIC_SESSION`).
Cuando opencode sí las entregue, la prioridad del plugin hace que el valor
**nativo** (`opencode.json`) mande **sin tocar el plugin**. Este es el plan para
asumir ese cambio de forma limpia.

---

## 0. ¿Ya lo parchearon? (detección)

```bash
rm -f /tmp/actor-critic-debug.log
ACTOR_CRITIC_DEBUG=1 opencode   # activa el probe de diagnóstico (off por defecto)
grep 'INIT' /tmp/actor-critic-debug.log
```

> El probe está **off por defecto**: sin `ACTOR_CRITIC_DEBUG=1` el plugin no
> escribe a `/tmp`. La línea `INIT` lleva `rawOptions=`. Léela:

| `rawOptions=` | Significado |
|---------------|-------------|
| `undefined` | **Aún no.** opencode sigue descartando las opciones. No hagas nada; el sidecar sigue activo. |
| `{ "maxIterations": 3, … }` (JSON) | **Sí.** opencode ya entrega las opciones → sigue los pasos 1–5. |

Confirma además la versión:

```bash
opencode --version
```

y revisa los release notes de opencode por cambios en el cargador de plugins
(tuplas `plugin: [ [name, options] ]`).

> Si el plugin ya no tiene el log de diagnóstico (ver paso 5), puedes comprobarlo
> por el comportamiento: con `keepCriticSession: true` en **`opencode.json`**
> (sin sidecar ni env) y viendo que la sesión del crítico **se conserva**, opencode
> ya pasa las opciones.

---

## 1. Decide la fuente de verdad

Una vez que `rawOptions` llega, el plugin ya favorece lo **nativo**. Dos opciones:

- **Opción A (recomendada) — volver a `opencode.json`:** edita las opciones en el
  tuple de `opencode.json` y **elimina el sidecar**. `opencode.json` vuelve a ser
  la única fuente. Menos superficie de mantenimiento.
- **Opción B — mantener el sidecar como respaldo:** deja el sidecar; el nativo
  manda cuando hay, el sidecar cuando no. Más seguridad, pero dos fuentes que
  mantener en sincronía.

> En ambos casos **el plugin no requiere cambios**: su lógica de prioridad
> (`{ ...sidecar, ...native }` + env) ya gestiona el bug parcheado.

---

## 2. Si eliges la Opción A

1. Asegúrate de que el tuple en `opencode.json` tiene las opciones que quieres
   (ya las tiene hoy, líneas 43–56):

   ```json
   "plugin": [
     [
       "./plugin/actor-critic.ts",
       {
         "maxIterations": 3,
         "actorAgent": "actor-managed",
         "criticAgent": "critic",
         "inlineActorAgent": "actor-managed-inline",
         "maxDiffChars": 20000,
         "maxContextChars": 4000,
         "keepCriticSession": true
       }
     ]
   ]
   ```

2. Elimina el sidecar (o déjalo vacío `{}` si prefieres conservarlo como
   respaldo futuro):

   ```bash
   rm ~/.config/opencode/plugin/actor-critic.options.json
   ```

3. (Opcional) Despega la env `ACTOR_CRITIC_KEEP_CRITIC_SESSION` si la tenías
   definida (en tu shell profile o el entorno desde donde arrancas opencode).

---

## 3. Verifica

```bash
rm -f /tmp/actor-critic-debug.log
ACTOR_CRITIC_DEBUG=1 opencode
grep 'INIT' /tmp/actor-critic-debug.log
# esperado: INIT … keepCriticSession=true rawOptions={"maxIterations":3,…}
```

Prueba funcional: arranca `/acp <tarea>`; tras la primera revisión,
`opencode session list` debe mostrar la sesión `[critic] revisión 1` **conservada**
(con `keepCriticSession: true`) y **visible**. Y en el log, `DISCARD
keepCriticSession=true` **sin** `DELETE_SESSION`.

---

## 4. Qué NO hay que cambiar

| Cambio del plugin | ¿Se toca al parchear opencode? |
|-------------------|--------------------------------|
| **Cambio 1** (merge sidecar+env+nativo) | No. El nativo pasa a mandar; el code ya lo gestiona. |
| **Cambio 2** (sin `parentID`) | No. Es independiente del bug de options; funciona con cualquier filtrado de `session list`. |
| **Cambio 3** (umbral `>=`) | No. Es una corrección de off-by-one, no depende del bug. |
| **Cambio 4** (log diagnóstico) | Opcional: puede retirarse (paso 5). |

---

## 5. Limpieza opcional (tras confirmar)

Cuando ya no necesites el log, borra el diagnóstico del plugin
`plugin/actor-critic.ts`:

- El bloque de definición de `DEBUG_LOG` / `dbg` (líneas 5–12).
- Las llamadas `dbg(…)` (líneas 112, 184, 191, 194, 460).

Reinicia opencode. **Opcional:** el log es inofensivo (escribe a `/tmp`); puedes
dejarlo por si surge otro problema.

---

## Tabla resumen — hoy vs. futuro

| Situación | Fuente activa de opciones | Qué editar |
|-----------|---------------------------|------------|
| **Hoy** (Bug 1 presente) | Sidecar + env `ACTOR_CRITIC_KEEP_CRITIC_SESSION` | `plugin/actor-critic.options.json` o la env |
| **Futuro** (Bug 1 parcheado) | Nativo (`opencode.json`) | `opencode.json` (y opcionalmente borrar el sidecar) |

## Nota sobre el Bug 2

Las sesiones del crítico son **de primer nivel** (`parent_id = null`) para que
aparezcan en el listado/TUI. Es independiente del bug de options: **no hay nada
que "revertir"** aquí. Ver [parche-actor-critic.md](./parche-actor-critic.md),
cambio 2.
