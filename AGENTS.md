# Instrucciones para agentes de código

> Lee **ARCHITECTURE.md** antes de tocar nada. Este archivo son las reglas de
> trabajo; ese otro es cómo funciona el sistema.

---

## Contexto en una frase

Sistema personal de inteligencia geopolítica: ingiere RSS multi-perspectiva,
clasifica en teatros estratégicos, analiza triangulando sesgos con memoria
comprimida, conecta teatros por cadenas materiales, y hace predicciones
falsables que valida contra la realidad. Next.js + Drizzle + SQLite + DeepSeek.
Corre solo cada madrugada en un Mac mini.

---

## Reglas de oro

### 1. Un cambio a la vez
La mayoría de los bugs de este proyecto surgieron de aplicar dos cambios juntos:
el scraping de texto completo provocó tres bugs distintos (truncado por
`max_tokens`, contaminación de idioma, JSON envenenado por caracteres de
control) que solo se pudieron aislar porque se aplicaron por separado.

Aplica un cambio, verifica, y solo entonces sigue.

### 2. Explica antes de codificar
El dueño del proyecto quiere entender el razonamiento antes de aceptar un diff.
Di qué vas a cambiar, por qué, y qué podría romperse. No entregues solo código.

### 3. Dry-run en todo lo destructivo o masivo
Cualquier operación que modifique muchas filas o lance muchas peticiones debe
tener modo dry-run **por defecto**, y activarse con una variable de entorno
explícita (`PRUNE_APPLY=1`, `BACKFILL_APPLY=1`).

Esto vale incluso para operaciones reversibles: `active = false` se puede
deshacer, pero conviene ver la lista antes.

### 4. Tope duro en todo bucle que llame a una API
Un bucle sin límite costó ~65¢ reprocesando 8.700 artículos por un bug de
estados. Todo bucle con llamadas al modelo necesita `MAX_ITERATIONS` o
equivalente, y debe abortar con un mensaje que explique la sospecha.

### 5. Los contadores no mienten
Se reportó "77 imágenes recuperadas" cuando eran todas el logo de Google News,
y "78 URLs resueltas" cuando seguían siendo de `news.google.com`. **Un sistema
que reporta falsos positivos es peor que uno que falla claramente**, porque
tomas decisiones sobre datos mentirosos.

Si una operación no logró lo que pretendía, el log debe decirlo. Nunca cuentes
como éxito algo que no lo es.

### 6. Best-effort en el enriquecimiento, abort en lo esencial
- Falla la ingesta → **aborta** (sin artículos no hay nada que hacer)
- Falla una imagen, un scraping, un red-team → **continúa** y loguea
- Falla el análisis de un hilo → **continúa** con los demás

### 7. Valida siempre las respuestas del modelo
Antes de guardar cualquier salida del LLM:
- ¿JSON parseable? (loguea la posición exacta del error si falla, y guarda la
  respuesta cruda completa en `logs/` para poder inspeccionarla)
- ¿Están todas las claves obligatorias?
- ¿`finish_reason` es `"stop"` y no `"length"`? (truncado)
- ¿Está en español? (umbral de caracteres CJK/cirílico)
- ¿Las fechas son futuras y coherentes con el enunciado?

Si falla, **reintenta una vez** con instrucción reforzada. Si vuelve a fallar,
descarta y márcalo — nunca guardes datos corruptos. Un `state` contaminado se
autoperpetúa.

### 8. Nada de `localStorage`
No funciona en este entorno. Estado en React (`useState`). Si el usuario pide
persistencia entre sesiones, explícale la limitación y ofrece alternativas.

### 9. Español
Prompts, logs, análisis, comentarios de código explicativos. La interfaz también.

---

## Convenciones técnicas

| Tema | Regla |
|---|---|
| Rutas | **Todo** bajo `src/`. Nunca crear `app/` en la raíz (causó un bug de 404) |
| Imports | Alias `@/*` → `./src/*` |
| Esquema | `npm run db:push`, nunca `db:migrate`. Cerrar Studio antes |
| Modelos | Solo por `.env.local` (`DEEPSEEK_MODEL_FAST` / `DEEPSEEK_MODEL_SMART`), nunca a fuego en el código |
| Scripts standalone | `config({ path: ".env.local" })` **al principio**, antes de importar módulos que crean el cliente DeepSeek |
| Producción | Cambio de código = `npm run build` + `pm2 restart boletin`. No hay recarga en caliente |
| Concurrencia | Máximo 5 peticiones HTTP en paralelo, timeout 8s, User-Agent de navegador |
| Centinelas | Todo campo que se intenta rellenar necesita su `*FetchedAt` para no reintentar infinitamente |
| Reversibilidad | `active = false`, nunca `DELETE` |
| Franjas de precio | Los jobs corren a las 23:00 / 22:00 local para quedar en valle. No ejecutar jobs a mano entre 07:00 y 12:00 locales (pico) |
| Arranque automático | pm2 debe estar registrado en launchd (`pm2 startup` + ejecutar el comando sudo que imprime). Verificar con `ls ~/Library/LaunchAgents/ \| grep pm2` |

---

## Estética de la interfaz

Concepto: **boletín de inteligencia serio**, no dashboard de SaaS.

- Referencias: The Economist, Le Monde diplomatique, Foreign Affairs
- Serif con peso editorial para titulares (los veredictos)
- IBM Plex Mono para metadatos, etiquetas y badges
- Sistema de **3 temas** (claro tipo NYT / oscuro tipo X / auto por
  `prefers-color-scheme`), todo el color vía variables CSS (`var(--fg)`,
  `var(--alarm)`, etc.)
- Un solo color de alarma (rojo), reservado para desviaciones
- Badges de perspectiva como "código de fuentes de inteligencia"
- Responsivo real: se consulta desde el móvil vía Tailscale
- Navegación: `BRIEFING · TABLERO · PREDICCIONES · FUENTES`

**Interacción:** el listado no expande contenido in-line; navega a una página
dedicada. Marcar leído es *optimistic update* (estado local inmediato, PATCH en
background, revertir si falla) — nunca recargar la página.

---

## Antes de dar algo por bueno

1. ¿Compila y el build está limpio?
2. ¿Se verificó con **datos reales**, no con el razonamiento de que debería
   funcionar?
3. Si toca el pipeline: ¿se corrió `npm run job:daily` y se leyó el log?
4. Si toca la interfaz: ¿se comprobó en escritorio **y** en móvil?
5. Si toca el esquema: ¿se aplicó `db:push` y se miró la tabla en Studio?
6. ¿Los contadores del log reflejan lo que de verdad ocurrió?

---

## Errores que ya se cometieron (no repetir)

- Dar por buenas las proporciones estimadas por el modelo en vez de medirlas
- Reportar éxito en operaciones que no lograron nada
- Aplicar dos cambios a la vez y no saber cuál rompió qué
- Asumir que un feed que devuelve XML válido está vivo (China Daily devuelve
  artículos de 2017)
- Derivar códigos ISO cortando las dos primeras letras del nombre del país
  (`"Ukraine".slice(0,2)` = `"UK"` = Reino Unido)
- Permitir predicciones que empaquetan cinco eventos distintos (imposibles de
  evaluar: siempre saldrían "parciales")
- Dejar que el modelo genere fechas en el pasado
- Confiar en un solo artículo sin corroborar para una predicción de alto impacto
