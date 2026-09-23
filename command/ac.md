---
description: Inicia el patrón Actor-Crítico (Actor qwen3.8 local + Crítico deepseek-flash)
agent: actor
---

Trabaja como ACTOR sobre la siguiente tarea:

$ARGUMENTS

Recuerda el flujo obligatorio: implementa, luego llama al subagente `critic`
con la herramienta `task` para que evalúe, aplica sus correcciones y repite
hasta obtener `VEREDICTO: APROBADO` (máximo 3 iteraciones). No termines sin
haber pasado por el crítico.
