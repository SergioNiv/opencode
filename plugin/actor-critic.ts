import type { Plugin } from "@opencode-ai/plugin"

type Options = {
  actorAgent?: string
  criticAgent?: string
  actorModel?: string
  criticModel?: string
  inlineActorAgent?: string
  inlineCriticAgent?: string
  inlineActorModel?: string
  inlineCriticModel?: string
  maxIterations?: number
  maxDiffChars?: number
  maxContextChars?: number
  keepCriticSession?: boolean
}

const toModelRef = (value?: string): { providerID: string; modelID: string } | undefined => {
  if (!value) return undefined
  const i = value.indexOf("/")
  if (i < 0) return undefined
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) }
}

type Mode = "session" | "inline" | "waiting"

const errorMessage = (error: any): string =>
  error?.data?.message ?? error?.message ?? error?.name ?? "error desconocido"

/** `diff` = hay contenido; `statsonly` = solo lista de archivos; `empty` = nada. */
type Diff = { text: string; kind: "diff" | "statsonly" | "empty" }

type State = {
  mode: Mode
  original: string
  iterations: number
  lastAssistantID?: string
  awaiting: "actor" | "critic"
  done: boolean
  processing: boolean
  baseTitle?: string
}

const readText = (parts: any[]): string =>
  (parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()

// Anclado a línea completa: si el crítico cita o niega la cadena dentro de su
// explicación ("no procede VEREDICTO: APROBADO…"), no debe contar como aprobado.
// Tampoco aceptamos sufijos tipo "APROBADO CON RESERVAS".
const approved = (text: string): boolean => /^\s*VEREDICTO\s*:\s*APROBADO\s*$/im.test(text)

const NOT_APPROVED = "⛔ NO APROBADO"
const APPROVED = "✅ APROBADO"

const short = (text: string, max = 40): string => {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

const ActorCriticPlugin: Plugin = async (input, rawOptions) => {
  const opts = (rawOptions ?? {}) as Options
  const actorAgent = opts.actorAgent ?? "actor-managed"
  const criticAgent = opts.criticAgent ?? "critic"
  const inlineActorAgent = opts.inlineActorAgent
  const inlineCriticAgent = opts.inlineCriticAgent ?? "critic"
  const actorModel = toModelRef(opts.actorModel)
  const criticModel = toModelRef(opts.criticModel)
  const inlineActorModel = toModelRef(opts.inlineActorModel)
  const inlineCriticModel = toModelRef(opts.inlineCriticModel)
  const maxIterations = opts.maxIterations ?? 3
  const maxDiffChars = opts.maxDiffChars ?? 40000
  const maxContextChars = opts.maxContextChars ?? 4000
  const keepCriticSession = opts.keepCriticSession ?? false
  const { client, directory, $ } = input

  const states = new Map<string, State>()
  const criticToActor = new Map<string, string>()

  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error",
  ) => {
    try {
      await client.tui.showToast({
        body: { title: "Actor-Critic", message, variant, duration: 5000 },
      })
    } catch {
      /* el TUI puede no estar disponible (ej. modo servidor) */
    }
  }

  const lastAssistant = async (sessionID: string) => {
    const res: any = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    })
    const list: any[] = res?.data ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry?.info?.role === "assistant" && !entry.info.summary) {
        return { info: entry.info, text: readText(entry.parts) }
      }
    }
    return undefined
  }

  const send = async (
    sessionID: string,
    agent: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ) => {
    await client.session.promptAsync({
      path: { id: sessionID },
      query: { directory },
      body: {
        agent,
        parts: [{ type: "text", text }],
        ...(model ? { model } : {}),
      },
    })
  }

  const createCriticSession = async (
    actorSessionID: string,
    iteration: number,
    original: string,
  ): Promise<string | undefined> => {
    const res: any = await client.session.create({
      query: { directory },
      body: {
        parentID: actorSessionID,
        title: `[critic] revisión ${iteration} — ${short(original)}`,
      },
    })
    const session = res?.data ?? res
    return session?.id
  }

  const deleteSession = async (sessionID: string) => {
    try {
      await client.session.delete({ path: { id: sessionID }, query: { directory } })
    } catch {
      /* la sesión pudo ser borrada por el usuario */
    }
  }

  // El SDK no permite insertar mensajes sintéticos, así que el veredicto final
  // se marca en el título de la sesión: es lo único que sobrevive al bucle y
  // queda visible en el listado de sesiones una vez el toast ha desaparecido.
  const VERDICT_SUFFIX = /\s*—\s*\d+\s+iteraciones?,\s*hallazgos abiertos\s*$/

  const stripVerdictMarkers = (title: string): string => {
    let base = title.split("\n")[0].trim()
    for (const marker of [APPROVED, NOT_APPROVED]) {
      if (base.startsWith(marker)) base = base.slice(marker.length)
    }
    return base
      .replace(VERDICT_SUFFIX, "")
      .replace(/^[\s\-—:]+/, "")
      .trim()
  }

  const markVerdict = async (sessionID: string, st: State, ok: boolean) => {
    const prefix = ok ? APPROVED : NOT_APPROVED
    try {
      if (st.baseTitle === undefined) {
        const res: any = await client.session.get({ path: { id: sessionID }, query: { directory } })
        st.baseTitle = stripVerdictMarkers(res?.data?.title ?? "") || short(st.original, 60)
      }
      const suffix = ok ? "" : ` — ${st.iterations} iteraciones, hallazgos abiertos`
      await client.session.update({
        path: { id: sessionID },
        query: { directory },
        body: { title: `${prefix} ${st.baseTitle}${suffix}`.slice(0, 200) },
      })
    } catch {
      /* el título es cosmético; nunca debe romper el bucle */
    }
  }

  const gitText = async (cmd: ReturnType<typeof $>): Promise<string> => {
    try {
      const out = await cmd.cwd(directory).quiet().nothrow()
      return out.stdout.toString()
    } catch {
      return ""
    }
  }

  const MAX_UNTRACKED_FILES = 25
  const MAX_UNTRACKED_FILE_CHARS = 8000

  const readUntracked = async (files: string[]): Promise<string> => {
    const shown = files.slice(0, MAX_UNTRACKED_FILES)
    const blocks: string[] = []

    for (const file of shown) {
      const res = await $`cat -- ${file}`.cwd(directory).quiet().nothrow()
      if (res.exitCode !== 0) {
        const reason = res.stderr.toString().trim() || `exit ${res.exitCode}`
        blocks.push(`--- ARCHIVO NUEVO: ${file} ---\n(no se pudo leer: ${reason})`)
        continue
      }
      let body = res.stdout.toString()
      if (body.includes("\u0000")) {
        body = "(archivo binario; contenido omitido)"
      } else if (body.length > MAX_UNTRACKED_FILE_CHARS) {
        body = `${body.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n... [truncado a ${MAX_UNTRACKED_FILE_CHARS} caracteres]`
      }
      blocks.push(`--- ARCHIVO NUEVO: ${file} ---\n${body}`)
    }

    if (files.length > shown.length) {
      blocks.push(
        `--- ${files.length - shown.length} ARCHIVO(S) NUEVO(S) MÁS, SIN MOSTRAR ---\n` +
          files
            .slice(shown.length)
            .map((f) => `- ${f}`)
            .join("\n") +
          "\nÁbrelos con `read` antes de emitir el veredicto.",
      )
    }

    return blocks.join("\n\n")
  }

  const collectDiff = async (sessionID: string): Promise<Diff> => {
    let diff = await gitText($`git diff --no-color --unified=3 HEAD`)
    if (!diff.trim()) diff = await gitText($`git diff --no-color --unified=3`)
    const untracked = (await gitText($`git ls-files --others --exclude-standard`))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    const parts: string[] = []
    if (diff.trim()) parts.push(diff.trim())
    if (untracked.length) parts.push(await readUntracked(untracked))

    if (parts.length === 0) {
      try {
        const res: any = await client.session.diff({
          path: { id: sessionID },
          query: { directory },
        })
        const files: any[] = res?.data ?? []
        if (files.length) {
          parts.push(
            "ARCHIVOS MODIFICADOS:\n" +
              files.map((f) => `- ${f.file} (+${f.additions} -${f.deletions})`).join("\n"),
          )
          let result = parts.join("\n\n")
          if (result.length > maxDiffChars) {
            result = `${result.slice(0, maxDiffChars)}\n\n... [diff truncado a ${maxDiffChars} caracteres]`
          }
          return { text: result, kind: "statsonly" }
        }
      } catch {
        /* sin diff disponible */
      }
    }

    if (parts.length === 0) return { text: "(sin cambios detectados por git)", kind: "empty" }

    let result = parts.join("\n\n")
    if (result.length > maxDiffChars) {
      result = `${result.slice(0, maxDiffChars)}\n\n... [diff truncado a ${maxDiffChars} caracteres]`
    }
    return { text: result, kind: "diff" }
  }

  // Contexto económico de la tarea: los mensajes de usuario (requisito,
  // aclaraciones, plan) más el último mensaje del actor (su resumen/intención).
  // El crítico es de nube y caro: no se le pasa la transcripción completa.
  const sessionContext = async (sessionID: string): Promise<string> => {
    try {
      const res: any = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      })
      const list: any[] = res?.data ?? []
      const userLines: string[] = []
      let lastActor = ""
      for (const entry of list) {
        const info = entry?.info
        if (!info) continue
        const text = readText(entry.parts)
        if (!text) continue
        // En modo inline el prompt del propio crítico vive en la misma sesión:
        // no se debe auto-incluir (aportaría el diff anterior de balde).
        if (info.role === "user" && info.agent !== criticAgent && info.agent !== inlineCriticAgent) {
          userLines.push(text)
        } else if (info.role === "assistant" && !info.summary) {
          lastActor = text
        }
      }
      const parts: string[] = []
      userLines.forEach((text) => parts.push(`[usuario] ${text}`))
      if (lastActor) parts.push(`[actor] ${lastActor}`)
      if (!parts.length) return ""
      let result = parts.join("\n\n")
      if (result.length > maxContextChars) {
        // Conserva el inicio (requisito + aclaraciones) y el final (resumen
        // del actor); el trabajo intermedio no le interesa al crítico.
        const head = Math.floor(maxContextChars * 0.6)
        const tail = Math.max(0, maxContextChars - head - 40)
        result =
          result.slice(0, head) +
          `\n\n... [contexto truncado a ${maxContextChars} caracteres] ...\n\n` +
          result.slice(result.length - tail)
      }
      return result
    } catch {
      return ""
    }
  }

  const criticPrompt = async (original: string, diff: Diff, context: string) => {
    const lines = [
      "Revisa los cambios del actor para esta tarea y emite tu veredicto.",
      "Tienes acceso de lectura al repositorio: abre los archivos que necesites",
      "para verificar el contexto, pero basa tu revisión en el diff mostrado.",
      "",
      "REQUISITOS ORIGINALES:",
      original || "(no capturados; revisa el diff)",
      "",
    ]

    if (context) {
      lines.push(
        "CONTEXTO DE LA TAREA (mensajes de usuario y resumen del actor; incluye",
        "decisiones y aclaraciones que el diff por sí solo no muestra):",
        context,
        "",
      )
    }

    if (diff.kind === "empty") {
      lines.push(
        "AVISO — SIN CAMBIOS: git no detecta ninguna modificación ni archivo nuevo.",
        "Esto no es automáticamente un fallo; decide según los requisitos:",
        "- Si la tarea pedía implementar, corregir o refactorizar código, el actor",
        "  no hizo el trabajo → exige cambios con un hallazgo [critico].",
        "- Si la tarea era solo informativa (explicar, analizar, responder), no hay",
        "  código que revisar y puedes aprobar.",
        "- Si el actor afirma haber cambiado algo con el diff vacío, compruébalo con",
        "  `git status` y `git log -1`: pudo haber commiteado o trabajado en otro",
        "  directorio. Reporta lo que encuentres.",
        "",
      )
    } else if (diff.kind === "statsonly") {
      lines.push(
        "AVISO — DIFF SIN CONTENIDO: solo se obtuvo la lista de archivos tocados,",
        "no su contenido. Ábrelos con `read` antes de opinar; no emitas veredicto",
        "sin haber visto el código real.",
        "",
      )
    }

    lines.push("DIFF DE LOS CAMBIOS:", diff.text, "", "Responde con el formato VEREDICTO/HALLAZGOS.")
    return lines.join("\n")
  }

  const fixPrompt = (critique: string) =>
    [
      "El crítico ha revisado tu trabajo. Aplica TODAS las correcciones señaladas.",
      "No llames a ningún subagente; solo implementa los cambios.",
      "",
      "CRÍTICA DEL REVISOR:",
      critique,
    ].join("\n")

  const reviewActor = async (actorSessionID: string, st: State) => {
    const last = await lastAssistant(actorSessionID)
    if (!last) return
    if (last.info.id === st.lastAssistantID) return
    st.lastAssistantID = last.info.id

    if (last.info.error) {
      st.done = true
      await markVerdict(actorSessionID, st, false)
      await toast("El modelo devolvió un error; se detiene el bucle.", "error")
      return
    }

    const criticSessionID = await createCriticSession(
      actorSessionID,
      st.iterations + 1,
      st.original,
    )
    if (!criticSessionID) {
      st.done = true
      await markVerdict(actorSessionID, st, false)
      await toast("No se pudo crear la sesión del crítico.", "error")
      return
    }

    const diff = await collectDiff(actorSessionID)
    const context = await sessionContext(actorSessionID)
    criticToActor.set(criticSessionID, actorSessionID)
    st.awaiting = "critic"
    await send(criticSessionID, criticAgent, await criticPrompt(st.original, diff, context), criticModel)
  }

  const processCritique = async (criticSessionID: string, actorSessionID: string, st: State) => {
    const last = await lastAssistant(criticSessionID)
    criticToActor.delete(criticSessionID)

    const discard = async () => {
      if (!keepCriticSession) await deleteSession(criticSessionID)
    }

    if (!last) {
      st.done = true
      await discard()
      await markVerdict(actorSessionID, st, false)
      await toast("El crítico no devolvió respuesta; se detiene el bucle.", "error")
      return
    }

    // Si la llamada al modelo del crítico falló (cuota, red, API), el último
    // mensaje tiene `error` y sin texto: reenviar una crítica vacía al actor
    // solo encadena turnos sin sentido. Se detiene el bucle con el motivo.
    if (last.info.error || !last.text) {
      st.done = true
      await discard()
      await markVerdict(actorSessionID, st, false)
      await toast(`El crítico falló (${short(errorMessage(last.info.error), 120)}); se detiene el bucle.`, "error")
      return
    }

    if (approved(last.text)) {
      st.done = true
      await discard()
      await markVerdict(actorSessionID, st, true)
      await toast(`Aprobado tras ${st.iterations} iteración(es).`, "success")
      return
    }

    st.iterations += 1
    if (st.iterations > maxIterations) {
      st.done = true
      // En modo bloqueante la revisión NO se borra: conserva los hallazgos
      // abiertos para poder auditar por qué se rechazó la tarea.
      await markVerdict(actorSessionID, st, false)
      await toast(
        `Sin aprobación tras ${maxIterations} iteraciones; revisa los hallazgos.`,
        "warning",
      )
      return
    }

    await discard()
    st.awaiting = "actor"
    await send(actorSessionID, actorAgent, fixPrompt(last.text), actorModel)
  }

  const reviewActorInline = async (sessionID: string, st: State) => {
    const last = await lastAssistant(sessionID)
    if (!last) return
    if (last.info.id === st.lastAssistantID) return
    st.lastAssistantID = last.info.id

    if (last.info.error) {
      st.done = true
      await markVerdict(sessionID, st, false)
      await toast("El modelo devolvió un error; se detiene el bucle.", "error")
      return
    }

    const diff = await collectDiff(sessionID)
    const context = await sessionContext(sessionID)
    st.awaiting = "critic"
    await send(sessionID, inlineCriticAgent, await criticPrompt(st.original, diff, context), inlineCriticModel)
  }

  const processCritiqueInline = async (sessionID: string, st: State) => {
    const last = await lastAssistant(sessionID)
    if (!last || last.info.id === st.lastAssistantID) return
    st.lastAssistantID = last.info.id

    // Mismo caso que en modo sesión: la llamada al crítico falló y no hay
    // crítica real que inyectar.
    if (last.info.error || !last.text) {
      st.done = true
      await markVerdict(sessionID, st, false)
      await toast(`El crítico falló (${short(errorMessage(last.info.error), 120)}); se detiene el bucle.`, "error")
      return
    }

    if (approved(last.text)) {
      st.done = true
      await markVerdict(sessionID, st, true)
      await toast(`Aprobado tras ${st.iterations} iteración(es).`, "success")
      return
    }

    st.iterations += 1
    if (st.iterations > maxIterations) {
      st.done = true
      await markVerdict(sessionID, st, false)
      await toast(
        `Sin aprobación tras ${maxIterations} iteraciones; revisa los hallazgos.`,
        "warning",
      )
      return
    }

    st.awaiting = "actor"
    await send(sessionID, inlineActorAgent ?? actorAgent, fixPrompt(last.text), inlineActorModel)
  }

  return {
    "chat.message": async (msg, output) => {
      const text = readText(output.parts as any[])
      const actorMode: Mode | undefined =
        inlineActorAgent && msg.agent === inlineActorAgent
          ? "inline"
          : msg.agent === actorAgent
            ? "session"
            : undefined
      const existing = states.get(msg.sessionID)
      if (!existing) {
        // El requisito suele formularse bajo otro agente (p. ej. modo plan);
        // se captura el primer mensaje de usuario de la sesión como original,
        // y el modo se resuelve cuando llegue un mensaje del actor.
        states.set(msg.sessionID, {
          mode: actorMode ?? "waiting",
          original: text,
          iterations: 0,
          awaiting: "actor",
          done: false,
          processing: false,
        })
        return
      }
      if (!actorMode) return
      if (existing.mode === "waiting") {
        existing.mode = actorMode
        return
      }
      if (existing.done) {
        states.set(msg.sessionID, {
          mode: actorMode,
          original: text,
          iterations: 0,
          awaiting: "actor",
          done: false,
          processing: false,
        })
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID

      const actorSessionID = criticToActor.get(sessionID)
      if (actorSessionID) {
        const st = states.get(actorSessionID)
        if (!st || st.done || st.processing || st.awaiting !== "critic") return
        st.processing = true
        try {
          await processCritique(sessionID, actorSessionID, st)
        } catch (error) {
          await toast(`Error al procesar la crítica: ${String(error)}`, "error")
        } finally {
          st.processing = false
        }
        return
      }

      const st = states.get(sessionID)
      // "waiting": sesión con requisito capturado pero sin mensaje del actor
      // todavía; no hay nada que revisar.
      if (!st || st.done || st.processing || st.mode === "waiting") return

      if (st.mode === "inline") {
        if (st.awaiting === "actor") {
          st.processing = true
          try {
            await reviewActorInline(sessionID, st)
          } catch (error) {
            await toast(`Error en el bucle Actor-Critic: ${String(error)}`, "error")
          } finally {
            st.processing = false
          }
        } else {
          st.processing = true
          try {
            await processCritiqueInline(sessionID, st)
          } catch (error) {
            await toast(`Error al procesar la crítica: ${String(error)}`, "error")
          } finally {
            st.processing = false
          }
        }
        return
      }

      if (st.awaiting !== "actor") return
      st.processing = true
      try {
        await reviewActor(sessionID, st)
      } catch (error) {
        await toast(`Error en el bucle Actor-Critic: ${String(error)}`, "error")
      } finally {
        st.processing = false
      }
    },
  }
}

export default ActorCriticPlugin
