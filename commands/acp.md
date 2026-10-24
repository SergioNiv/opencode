---
description: Patrón actor/crítico con qwen3.8 local y deepseek
agent: actor
model: llama-local/qwen3.8#medium
---

Tarea:

$ARGUMENTS

Implementa la tarea. Antes de terminar, llama al subagente `critic` con los
requisitos originales completos y un resumen de los cambios. Aplica todas sus
correcciones y repite hasta que emita `VEREDICTO: APROBADO` (máximo 3 rondas).
