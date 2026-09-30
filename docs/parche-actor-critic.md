# Parche aplicado al plugin `actor-critic.ts`

Registro de los cambios hechos en `~/.config/opencode/plugin/actor-critic.ts`
para rodear **dos bugs de opencode v1.18.33**. Cada cambio incluye el porqué,
el código exacto (con línea), y cómo verificarlo.

> **Fecha:** 2026-09-29 · **opencode:** 1.18.33 · **plugin:** 671 líneas
> **Binario:** `~/.opencode/bin/opencode` · **SDK types:** `@opencode-ai/plugin` v1.18.11

---

## Los dos bugs que motivaron el parche

### Bug 1 — opencode no entrega las opciones del plugin

En `opencode.json` el plugin se registra en **forma tupla**:

```json
"plugin": [
  ["./plugin/actor-critic.ts", { "keepCriticSession": true, "maxIterations": 3, ... }]
]
```

El schema lo acepta (sin error de config), **pero** al ejecutar, el plugin recibe
`rawOptions === undefined`. Es decir: opencode 1.18.33 **no pasa** las opciones de
la tupla al plugin.

**Evidencia:**
- El **schema de config** sí conserva la tupla:
  `J7.Spec = Union(String, Tuple(String, Record))` (binario, offset ~104790414).
  `opencode.json` se parsea bien y las opciones quedan en el config.
- El **servicio de plugin** (binario, offsets ~104164100–104171748) tiene
  `pluginSpecifier`/`pluginOptions`, pero al invocar el plugin **no propaga**
  `$.options`. Se valida en el schema pero no se reenvía a la función. Ese es el
  bug: la options se pierde entre el config y la invocación.
- **Log de diagnóstico** (`/tmp/actor-critic-debug.log`), primera ejecución:
  `INIT ... rawOptions=undefined` a pesar de tener la tupla en `opencode.json`.

**Consecuencia que lo delató:** con `keepCriticSession: true`, la sesión del
crítico **se seguía borrando** (DELETE_SESSION) pese a la config.

### Bug 2 — las sesiones hija no aparecen en `session list`/TUI

El plugin creaba la sesión del crítico con `parentID` (sesión **hija** del actor).
`opencode session list` y la TUI **filtran por `parent_id IS NULL`** (parámetro
`roots` de la función de listado `gQ`, binario ~98434243), así que las sesiones con
`parent_id != null` **no** se muestran.

**Evidencia:** la DB (`~/.local/share/opencode/opencode.db`) tenía la sesión del
crítico `ses_f0f8acb59…` con `parent_id = actor`, pero `opencode session list`
mostraba 13 sesiones raíz y **cero** `[critic]`.

**Conclusión:** las hijas son invisibles en el listado/TUI por diseño de opencode
(filtra a raíces), no por fallo del plugin.

---

## Resumen de cambios

| # | Cambio | Razona un bug | Líneas |
|---|--------|---------------|--------|
| 1 | Carga de opciones: sidecar + env + nativo (prioridad por clave) | Rodea el **Bug 1** | 41–49, 100–101 |
| 2 | Se elimina `parentID` al crear la sesión del crítico | Rodea el **Bug 2** | 169–183 |
| 3 | Umbral `>` → `>=` en el guard de iteraciones | `maxIterations=N` = N sesiones exactas | 490–493, 550–552 |
| 4 | Log de diagnóstico bajo `ACTOR_CRITIC_DEBUG` (off por defecto) | Validar Bug 1 y 2 | 5–15, 119 |

---

## Cambio 1 — Carga de opciones (sidecar + env + nativo)

**Por qué:** con el Bug 1, `rawOptions` llega `undefined`, así que el plugin no
puede leer `opencode.json`. Se leen las opciones por **tres fuentes** con
prioridad **por clave**, para que cuando opencode parchee el Bug 1 el valor
nativo tome el control **sin tocar el plugin**.

**Código:**

`plugin/actor-critic.ts:41–49` — fuente de verdad (sidecar co-ubicado):

```ts
const SIDE_CAR = fileURLToPath(new URL("./actor-critic.options.json", import.meta.url))

const loadSidecarOptions = (): Partial<Options> => {
  try {
    return JSON.parse(fs.readFileSync(SIDE_CAR, "utf8")) as Partial<Options>
  } catch {
    return {}
  }
}
```

`plugin/actor-critic.ts:100–101` — merge con prioridad por clave:

```ts
const ActorCriticPlugin: Plugin = async (input, rawOptions) => {
  // native (rawOptions) tiene prioridad sobre el sidecar por clave; el env
  // ACTOR_CRITIC_KEEP_CRITIC_SESSION, si está definido, pisa keepCriticSession.
  const opts: Options = { ...loadSidecarOptions(), ...(rawOptions ?? {}) }
  const envKeep = process.env.ACTOR_CRITIC_KEEP_CRITIC_SESSION
  if (envKeep !== undefined) opts.keepCriticSession = envKeep === "1" || envKeep === "true"
  ...
```

**Prioridad resultante (de mayor a menor):**

| Clave | 1º (gana) | 2º | 3º | default |
|-------|-----------|----|----|---------|
| `keepCriticSession` | env `ACTOR_CRITIC_KEEP_CRITIC_SESSION` | nativo (`rawOptions`) | sidecar | `false` |
| resto de claves | nativo (`rawOptions`) | sidecar | — | ver tabla de opciones |

> "Por clave": si una clave no está en la fuente de mayor prioridad, se toma de la
> siguiente. No es todo-o-nada.

**Archivos afectados:**
- `plugin/actor-critic.ts` (lectura + merge).
- **`plugin/actor-critic.options.json`** (sidecar **nuevo**, la fuente activa hoy):

  ```json
  {
    "maxIterations": 3,
    "actorAgent": "actor-managed",
    "criticAgent": "critic",
    "inlineActorAgent": "actor-managed-inline",
    "maxDiffChars": 20000,
    "maxContextChars": 4000,
    "keepCriticSession": true
  }
  ```

**Verificación:** tras el cambio, el log mostró `INIT ...
keepCriticSession=true rawOptions=undefined` y **sin** línea `DELETE_SESSION` →
la sesión del crítico se conservó pese a que `opencode.json` sigue "ignorado".

> **Mientras el Bug 1 esté presente, edita el SIDEAR (o la env) para cambiar
> opciones — NO `opencode.json`.** Ver [upgrade-checklist.md](./upgrade-checklist.md).

---

## Cambio 2 — Sesiones del crítico de primer nivel (sin `parentID`)

**Por qué:** con el Bug 2, las sesiones hija (`parent_id != null`) no aparecen en
`session list`/TUI. Para poder **ver** y depurar la sesión del crítico, se crea
**de primer nivel** (`parent_id = null`).

**Código:** `plugin/actor-critic.ts:169–183` (`createCriticSession`):

```ts
    // Sin parentID: las sesiones hija (parent_id != null) las oculta la lista de
    // sesiones (CLI `session list` y TUI, que filtran por `parent_id IS NULL`),
    // así que el crítico sería invisible. Con parent_id=null aparece como sesión
    // de primer nivel y se puede abrir/inspeccionar. El flujo del plugin no depende
    // de parent_id (usa su propio Map `criticToActor`).
    const res: any = await client.session.create({
      query: { directory },
      body: {
        title: `[critic] revisión ${iteration} — ${short(original)}`,
      },
    })
```

**Efecto colateral:** ninguno — el flujo del plugin usa su propio `Map
criticToActor` (línea 119), no `parent_id`. Con `keepCriticSession: true` cada
`[critic] revisión N` queda **visible** en el listado; con `false`, sigue
borrándose.

**Verificación:** `opencode session list` muestra la sesión `[critic] …` como
entrada de primer nivel. Confirmado por el usuario: "ya veo la sesión del crítico
como padre en el listado".

---

## Cambio 3 — Umbral `>` → `>=` (N sesiones exactas)

**Por qué:** con `>`, `maxIterations=3` creaba **4** sesiones de crítico
(off-by-one). Con `>=` crea exactamente **N**.

**Código:** dos guards.

Modo sesión — `plugin/actor-critic.ts:490–493` (`processCritique`):

```ts
    // >= (no >): con maxIterations=N se crean exactamente N sesiones del
    // crítico; el N-ésimo rechazo detiene el bucle en vez de encolar un N+1.
    st.iterations += 1
    if (st.iterations >= maxIterations) {
```

Modo inline — `plugin/actor-critic.ts:550–552` (`processCritiqueInline`):

```ts
    // >= (no >): con maxIterations=N se hacen exactamente N rondas de revisión.
    st.iterations += 1
    if (st.iterations >= maxIterations) {
```

**Tras el cambio (con `maxIterations=3`):**

| Vuelta | Sesión creada | Tras rechazar |
|--------|---------------|---------------|
| 1 | `[critic] revisión 1` | `iters=1`, `1>=3?` no → corrige al actor |
| 2 | `[critic] revisión 2` | `iters=2`, `2>=3?` no → corrige al actor |
| 3 | `[critic] revisión 3` | `iters=3`, `3>=3?` **sí** → detiene (toast "Sin aprobación tras 3 iteraciones") |

Se crean **exactamente 3** sesiones (o menos si aprueba antes). El toast de fallo
ahora coincide con el número real.

---

## Cambio 4 — Log de diagnóstico (flag, off por defecto)

**Por qué:** para validar los Bugs 1 y 2 y, después, detectar si opencode entrega
las opciones al plugin.

**Estado actual:** el diagnóstico está **detrás del env `ACTOR_CRITIC_DEBUG`**
(off por defecto), así que **no escribe a `/tmp` en cada arranque**. Tras validar
los bugs se retiraron las llamadas detalladas (`CREATE_CRITIC`, `DELETE_SESSION`,
`DISCARD`, `IDLE`); quedó **solo el probe `INIT`**, que es el que interesa para
detectar el Bug 1.

**Código:** `plugin/actor-critic.ts:5–15`:

```ts
// Diagnóstico opcional (off por defecto): con ACTOR_CRITIC_DEBUG=1 escribe a
// /tmp/actor-critic-debug.log.
const DEBUG_LOG = "/tmp/actor-critic-debug.log"
const DEBUG = process.env.ACTOR_CRITIC_DEBUG === "1" || process.env.ACTOR_CRITIC_DEBUG === "true"
const dbg = (msg: string) => {
  if (!DEBUG) return
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* el logging nunca debe romper el plugin */
  }
}
```

Única llamada (`plugin/actor-critic.ts:119`):

| Línea | Evento |
|-------|--------|
| 119 | `INIT keepCriticSession=… rawOptions=…` (arranque) |

**Uso (solo cuando lo necesites):**

```bash
rm -f /tmp/actor-critic-debug.log
ACTOR_CRITIC_DEBUG=1 opencode          # activa el diagnóstico para esta sesión
grep 'INIT' /tmp/actor-critic-debug.log
```

Sin `ACTOR_CRITIC_DEBUG` el plugin **no** escribe nada. Para eliminarlo por
completo, borra el bloque 5–15 y la llamada 119, y reinicia opencode.

---

## Archivos tocados

| Archivo | Cambio |
|---------|--------|
| `plugin/actor-critic.ts` | Cambios 1–4 |
| `plugin/actor-critic.options.json` | **Nuevo** (sidecar, cambio 1) |
| `opencode.json` | Sin cambios (el tuple sigue ahí pero es ignorado por el Bug 1) |

## Verificación global

1. `rm -f /tmp/actor-critic-debug.log && ACTOR_CRITIC_DEBUG=1 opencode`
2. `grep 'INIT' /tmp/actor-critic-debug.log` → esperado: `keepCriticSession=true
   rawOptions=undefined` (hoy; ver [upgrade-checklist.md](./upgrade-checklist.md)).
3. Lanza `/acp <tarea>`; tras la 1ª revisión, `opencode session list` debe mostrar
   la sesión `[critic] revisión 1` (conservada y visible).

## Si opencode parchea el Bug 1

Cuando `INIT … rawOptions={…}` aparezca (JSON en vez de `undefined`), el valor
nativo (`opencode.json`) vuelve a mandar y el sidecar queda como respaldo. **El
plugin no requiere cambios.** Pasos detallados: [upgrade-checklist.md](./upgrade-checklist.md).
