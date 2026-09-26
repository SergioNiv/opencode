import type { Plugin } from "@opencode-ai/plugin"

type Options = {
  actorAgent?: string
  criticAgent?: string
  actorModel?: string
  criticModel?: string
  maxIterations?: number
  maxDiffChars?: number
  keepCriticSession?: boolean
}

const toModelRef = (value?: string): { providerID: string; modelID: string } | undefined => {
  if (!value) return undefined
  const i = value.indexOf("/")
  if (i < 0) return undefined
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) }
}

type State = {
  original: string
  iterations: number
  lastAssistantID?: string
  awaiting: "actor" | "critic"
  done: boolean
  processing: boolean
}

const readText = (parts: any[]): string =>
  (parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()

const approved = (text: string): boolean => /VEREDICTO\s*:\s*APROBADO/i.test(text)

const short = (text: string, max = 40): string => {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

const ActorCriticPlugin: Plugin = async (input, rawOptions) => {
  const opts = (rawOptions ?? {}) as Options
  const actorAgent = opts.actorAgent ?? "actor-managed"
  const criticAgent = opts.criticAgent ?? "critic"
  const actorModel = toModelRef(opts.actorModel)
  const criticModel = toModelRef(opts.criticModel)
  const maxIterations = opts.maxIterations ?? 3
  const maxDiffChars = opts.maxDiffChars ?? 40000
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

  const gitText = async (cmd: ReturnType<typeof $>): Promise<string> => {
    try {
      const out = await cmd.cwd(directory).quiet().nothrow()
      return out.stdout.toString()
    } catch {
      return ""
    }
  }

  const collectDiff = async (sessionID: string): Promise<string> => {
    let diff = await gitText($`git diff --no-color --unified=3 HEAD`)
    if (!diff.trim()) diff = await gitText($`git diff --no-color --unified=3`)
    const untracked = (await gitText($`git ls-files --others --exclude-standard`)).trim()

    const parts: string[] = []
    if (diff.trim()) parts.push(diff.trim())
    if (untracked) parts.push(`ARCHIVOS NUEVOS (sin trackear):\n${untracked}`)

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
        }
      } catch {
        /* sin diff disponible */
      }
    }

    let result = parts.join("\n\n")
    if (result.length > maxDiffChars) {
      result = `${result.slice(0, maxDiffChars)}\n\n... [diff truncado a ${maxDiffChars} caracteres]`
    }
    return result || "(sin cambios detectados por git)"
  }

  const criticPrompt = (original: string, diff: string) =>
    [
      "Revisa los cambios del actor para esta tarea y emite tu veredicto.",
      "Tienes acceso de lectura al repositorio: abre los archivos que necesites",
      "para verificar el contexto, pero basa tu revisión en el diff mostrado.",
      "",
      "REQUISITOS ORIGINALES:",
      original || "(no capturados; revisa el diff)",
      "",
      "DIFF DE LOS CAMBIOS:",
      diff,
      "",
      "Responde con el formato VEREDICTO/HALLAZGOS.",
    ].join("\n")

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
      await toast("No se pudo crear la sesión del crítico.", "error")
      return
    }

    const diff = await collectDiff(actorSessionID)
    criticToActor.set(criticSessionID, actorSessionID)
    st.awaiting = "critic"
    await send(criticSessionID, criticAgent, criticPrompt(st.original, diff), criticModel)
  }

  const processCritique = async (criticSessionID: string, actorSessionID: string, st: State) => {
    const last = await lastAssistant(criticSessionID)

    if (!keepCriticSession) await deleteSession(criticSessionID)
    criticToActor.delete(criticSessionID)

    if (!last) {
      st.done = true
      await toast("El crítico no devolvió respuesta; se detiene el bucle.", "error")
      return
    }

    if (approved(last.text)) {
      st.done = true
      await toast(`Aprobado tras ${st.iterations} iteración(es).`, "success")
      return
    }

    st.iterations += 1
    if (st.iterations > maxIterations) {
      st.done = true
      await toast(
        `Sin aprobación tras ${maxIterations} iteraciones; revisa los hallazgos.`,
        "warning",
      )
      return
    }

    st.awaiting = "actor"
    await send(actorSessionID, actorAgent, fixPrompt(last.text), actorModel)
  }

  return {
    "chat.message": async (msg, output) => {
      if (msg.agent !== actorAgent) return
      const existing = states.get(msg.sessionID)
      if (existing && !existing.done) return
      states.set(msg.sessionID, {
        original: readText(output.parts as any[]),
        iterations: 0,
        awaiting: "actor",
        done: false,
        processing: false,
      })
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
      if (!st || st.done || st.processing || st.awaiting !== "actor") return
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
