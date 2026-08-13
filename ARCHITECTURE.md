# Agregador Geopolítico — Arquitectura

> **Documento de referencia.** Describe cómo funciona el sistema completo: flujo de
> datos, esquema de base de datos, qué función llama a qué, llamadas a la API,
> salvaguardas, cron y operación.
>
> **Léelo antes de modificar cualquier cosa.**

---

## 1. Qué es este proyecto

Un sistema personal de inteligencia geopolítica. Cada madrugada, de forma autónoma:

1. **Ingiere** noticias de varias fuentes RSS, cada una con una perspectiva
   geopolítica declarada (turca, rusa, china, griega, europea, think tank).
2. **Clasifica** los artículos en *teatros estratégicos* (temas persistentes).
3. **Analiza** cada teatro con novedades: triangula las perspectivas, aplica
   *cui bono* material, contrasta lo dicho con lo hecho, detecta desviaciones de
   patrón y emite una predicción falsable con fecha.
4. **Conecta** teatros entre sí por cadenas materiales compartidas.
5. **Sintetiza** semanalmente una lectura de sistema (meta-análisis).
6. **Registra y valida** sus propias predicciones, midiendo su track record.

El resultado se lee como un boletín de inteligencia en el navegador, incluido el
móvil vía Tailscale.

**Principio de diseño central:** el sistema no resume noticias. Analiza *cómo
cada perspectiva encuadra los mismos hechos* y extrae de ahí los intereses
materiales reales. El registro es realpolitik, sin diplomacia.

---

## 2. Stack

| Capa | Tecnología |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| Estilos | Tailwind + estilos inline (sistema de 3 temas por variables CSS) |
| ORM | Drizzle |
| Base de datos | SQLite (`better-sqlite3`), archivo en `./data/geopolitica.db` |
| LLM | DeepSeek vía SDK de OpenAI (`baseURL: https://api.deepseek.com`) |
| RSS | `rss-parser` |
| Scraping | `@extractus/article-extractor` |
| Visualización | `d3-geo`, `d3-force`, `topojson-client`, `world-atlas` |
| Scripts | `tsx` + `dotenv` |
| Proceso | `pm2` (servidor web) + `crontab` (jobs) |
| Servidor | Mac mini, acceso remoto por Tailscale |

**Modelos** (en `.env.local`):
```
DEEPSEEK_MODEL_FAST=deepseek-v4-flash
DEEPSEEK_MODEL_SMART=deepseek-v4-flash
```
Ambos apuntan a Flash. Se migró desde `deepseek-v4-pro` tras verificar paridad
de calidad con ~3x menos coste y ~2x más velocidad. El ID `deepseek-v4-flash`
sirve el checkpoint más reciente automáticamente.

---

## 3. Estructura de directorios

```
agregador-geopolitico/
├── data/
│   └── geopolitica.db          # SQLite (en .gitignore)
├── logs/                       # Salida de los jobs, un archivo por día (en .gitignore)
├── src/
│   ├── app/
│   │   ├── page.tsx                      # Raíz
│   │   ├── layout.tsx, globals.css
│   │   ├── dashboard/page.tsx            # El boletín (portada)
│   │   ├── dashboard/[threadId]/page.tsx # Página de un teatro + chat contextual
│   │   ├── meta/page.tsx                 # Editorial de sistema
│   │   ├── predicciones/page.tsx         # Listado + track record
│   │   ├── predicciones/[id]/page.tsx    # Detalle de una predicción
│   │   ├── tablero/page.tsx              # Mapa + grafo de red
│   │   ├── sources/page.tsx              # CRUD de fuentes
│   │   └── api/                          # Ver sección 6
│   ├── components/
│   │   └── Nav.tsx                       # Navegación + selector de temas
│   ├── lib/
│   │   ├── db/{index,schema,seed,fix-classification-status}.ts
│   │   ├── rss.ts, images.ts, extract.ts
│   │   ├── classify.ts, consolidate.ts, prune.ts
│   │   ├── analyze.ts, verify.ts, redteam.ts
│   │   ├── links.ts, meta.ts, predictions.ts
│   │   ├── deepseek.ts, prompts.ts
│   │   ├── threads.ts, sources.ts, sources-types.ts
│   ├── jobs/
│   │   ├── daily.ts                      # Pipeline nocturno
│   │   ├── weekly.ts                     # Pipeline semanal
│   │   └── analyze-one.ts                # Diagnóstico: analiza un solo hilo
│   └── scripts/
│       ├── clean-images.ts
│       ├── backfill-entities.ts
│       ├── backfill-predictions.ts
│       └── prune-threads.ts
├── .env.local                  # Claves y modelos (en .gitignore)
└── drizzle.config.ts
```

**Regla crítica:** todo vive bajo `src/`. El alias de TypeScript `@/*` apunta a
`./src/*`. **Nunca** crear una carpeta `app/` en la raíz — provocó un bug de 404
al principio del proyecto por duplicación de rutas.

---

## 4. Esquema de base de datos

### `sources`
Las fuentes RSS y su perspectiva.

| Campo | Tipo | Notas |
|---|---|---|
| id | integer PK | |
| name | text | |
| rssUrl | text | |
| bias | enum | `greek` \| `turkish` \| `russian` \| `chinese` \| `european` \| `western_thinktank` \| `other` |
| active | integer | |
| createdAt, lastFetchAt | text | |
| lastFetchStatus | text | |

El campo `bias` es el eje del sistema: la triangulación se hace comparando cómo
fuentes de distinto sesgo encuadran el mismo hecho. Las fuentes concretas son
intercambiables; la cobertura de perspectivas no.

### `articles`
Artículos crudos. **Nunca se modifican tras la ingesta** (salvo los campos de
enriquecimiento y estado).

| Campo | Tipo | Notas |
|---|---|---|
| id | integer PK | |
| sourceId | FK → sources | de aquí hereda la perspectiva |
| title, content | text | `content` = descripción del feed |
| url | text UNIQUE | evita duplicados en la ingesta |
| publishedAt, fetchedAt | text | **`fetchedAt` es el que manda** para "novedad" |
| classificationStatus | enum | `pending` \| `classified` \| `ignored` \| `deferred` |
| imageUrl | text nullable | imagen destacada |
| resolvedUrl | text nullable | URL real del artículo (tras resolver redirects) |
| imageFetchedAt | text nullable | centinela: evita reintentar los que fallan |
| fullText | text nullable | cuerpo scrapeado (máx ~8.000 chars) |
| fullTextFetchedAt | text nullable | centinela |

**Máquina de estados de `classificationStatus`:**
```
pending → classified   (encaja en un hilo existente)
pending → ignored      (ruido: deportes, sucesos, irrelevante)
pending → deferred     (necesita hilo NUEVO, pero estamos en modo diario)
deferred → classified  (el job semanal crea su hilo y lo asigna)
```
El estado `deferred` existe para resolver un bug real: en modo diario no se
crean hilos, así que los artículos de temas nuevos quedaban en `pending` y
reaparecían en cada iteración del bucle → bucle infinito.

### `threads`
Los teatros estratégicos.

| Campo | Tipo | Notas |
|---|---|---|
| id | integer PK | |
| title, description | text | |
| state | text nullable | **LA MEMORIA.** Síntesis acumulada, ~350 palabras |
| origin | enum | `ai` \| `manual` (los `manual` están protegidos de poda/fusión) |
| active | integer | la desactivación es reversible; **nunca se borra** |
| createdAt, updatedAt | text | |
| countries | text (JSON) | array de ISO alpha-2, máx 6 |
| actors | text (JSON) | actores no estatales/supranacionales |
| domains | text (JSON) | **vocabulario cerrado**, 1-4 valores (ver §5) |
| tensionLevel | integer | 1 (latente) a 5 (conflicto abierto) |

**El campo `state` es el concepto clave de todo el sistema.** Cada análisis lo
reescribe. Permite que el análisis diario reciba solo los artículos *nuevos* +
el `state`, en vez de releer los 600 artículos históricos del hilo. Reduce el
input un 50-70% sin perder contexto.

### `analyses`
Los análisis producidos.

| Campo | Notas |
|---|---|
| id, threadId, analysisDate, createdAt | |
| summary | hechos, ya triangulados |
| cuiBono | quién se beneficia, en términos materiales |
| saidVsDone | contraste entre retórica y comportamiento |
| deviation | desviación del patrón previo (usa el `state` como referencia) |
| verdict | veredicto sin diplomacia |
| prediction | *(legacy, texto libre — conservado para histórico)* |
| predictionStatement | qué se predice (una sola proposición binaria) |
| predictionCondition | qué la dispara |
| predictionFalsification | complemento lógico exacto del statement |
| predictionReviewDate | ISO, futura, 30-180 días, ≥ fecha límite del statement |
| rebuttal | contra-argumento del abogado del diablo |
| alternativeHypothesis | lectura rival más fuerte |
| rebuttalVerdict | enum `sostiene` \| `debilita` \| `refuta` |
| read | integer |

### `article_threads`
Tabla puente. PK compuesta (articleId, threadId).

### `thread_links`
Conexiones entre teatros.

| Campo | Notas |
|---|---|
| id, threadA, threadB | |
| linkType | enum `cadena_material` \| `mismo_bloque` \| `presion_coordinada` \| `competencia_recurso` \| `distraccion` \| `motor_interno` |
| rationale | por qué están conectados, en términos **materiales** |
| strength | 1-3 |
| detectedAt, lastSeenAt | |
| timesConfirmed | integer, default 1. **Upsert, no insert:** si el par ya existe se incrementa |

`timesConfirmed >= 2` marca una conexión como *estable*. Es la diferencia entre
una cadena estructural y un solapamiento casual de una sola corrida.

### `meta_analyses`
El editorial de sistema (semanal).

| Campo | Notas |
|---|---|
| id, periodStart, periodEnd, createdAt, read | |
| systemReading | lectura del tablero global |
| blocFormation | qué alineamientos se consolidan o rompen |
| crossPatterns | patrones que cruzan varios teatros |
| contradictions | dónde un actor hace en un frente lo contrario que en otro |
| verdict | |
| predictionStatement / Condition / Falsification / ReviewDate | igual que en `analyses` |
| threadIds | JSON de los teatros considerados |

### `predictions`
Registro y validación.

| Campo | Notas |
|---|---|
| id, sourceId, threadId, createdAt | |
| sourceType | enum `thread` \| `meta` |
| statement, condition, falsificationCondition, reviewDate | |
| status | enum `pending` \| `confirmed` \| `falsified` \| `unverifiable`. **Sin `partial`**: las predicciones son binarias por diseño |
| resolution, resolvedAt | veredicto de la evaluación |
| evidenceArticleIds | JSON de los artículos que la sustentaron |
| confidence | `alta` \| `media` \| `baja` |
| rebuttal | el contra-argumento que sobrevivió |

### `events`
Existe en el esquema y se **reaplica en la consolidación** (`consolidate.ts`
mueve `events.threadId` al canónico al fusionar hilos), pero **no se crean
filas** en el flujo normal (0 filas). Candidata a eliminar.

---

## 5. Vocabulario cerrado de dominios

Definido en `prompts.ts` como `DOMAINS_VOCABULARY`. **El modelo solo puede elegir
de esta lista**, y `normalizeDomains()` filtra contra ella en código.

```
energia_fosil          energia_nuclear        energia_renovable
rutas_maritimas        rutas_terrestres       minerales_criticos
semiconductores        armas_convencionales   armas_estrategicas
agua_alimentos         finanzas               datos_infraestructura
migracion              industria_manufactura  territorio
influencia_politica
```

**Por qué cerrado:** con texto libre, un teatro decía `"energía"` y otro
`"energía nuclear"`, y nunca cruzaban aunque compartieran cadena material. El
vocabulario normalizado es lo que hace posible detectar conexiones.

**Nota:** `influencia_politica` es un dominio *hub* — aparece en casi todos los
teatros, así que discrimina poco como señal de conexión. Mejora pendiente:
aplicarle el mismo tratamiento IDF que a los países, o excluirlo como señal.

---

## 6. Endpoints de la API

Todos en `src/app/api/`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/ingest` | Ingesta RSS |
| GET/POST | `/api/sources` | CRUD de fuentes |
| PATCH/DELETE | `/api/sources/[id]` | |
| POST | `/api/classify` | Clasificación (modo completo por defecto) |
| POST | `/api/consolidate` | Consolidación de hilos duplicados |
| POST | `/api/analyze` | Análisis (default: `onlyWithRecentArticles=false`) |
| GET | `/api/dashboard` | Datos del boletín, ordenados por score |
| PATCH | `/api/analyses/[id]/read` | Marcar leído |
| GET | `/api/map` | Agregado por país: teatros, tensión máx, desviaciones |
| GET | `/api/network` | Nodos y aristas para el grafo |
| GET/POST | `/api/meta` | GET último editorial / POST ejecuta links + meta |
| GET | `/api/threads/[threadId]` | Detalle de un teatro |
| POST | `/api/threads/[threadId]/ask` | Chat contextual |
| GET | `/api/predictions` | dueSoon, pending, resolved, stats |
| GET | `/api/predictions/[id]` | Detalle + evidencia |
| POST | `/api/predictions/evaluate` | Evaluar predicciones vencidas |

---

## 7. Flujo de datos

```
sources
   │ ingestAllSources()               [rss.ts]
   ▼
articles (con perspectiva heredada del source)
   │ extractImagesForArticles()       [images.ts]   ── nivel 1: campos del feed
   │                                                ── nivel 2: og:image de la página
   │ classifyUnassignedArticles()     [classify.ts] ── Flash, lotes de 30
   ▼
threads + article_threads
   │ extractTextsForArticles()        [extract.ts]  ── solo 2 artículos por hilo
   │ analyzeThread()                  [deepseek.ts] ── Flash, artículos nuevos + state
   │   ├─ verifyPredictionFacts()     [verify.ts]   ── corrobora contra la BD
   │   └─ runRedTeam()                [redteam.ts]  ── abogado del diablo
   ▼
analyses + state actualizado + predictions
   │ detectThreadLinks()              [links.ts]    ── reutiliza signalBetween()
   ▼
thread_links
   │ runMetaAnalysis()                [meta.ts]     ── top 20 teatros + sus links
   ▼
meta_analyses
   │
   ▼
/dashboard  /meta  /predicciones  /tablero
```

### Pipeline DIARIO — `src/jobs/daily.ts`

Corre por cron. Fases:

**Fase 1 — Ingesta.** `ingestAllSources()`. Si falla → **aborta** el pipeline
(sin artículos no hay nada que hacer).

**Fase 1b — Imágenes.** `extractImagesForArticles()` sobre los artículos nuevos
de esta corrida. Aislada: si falla, el pipeline continúa. Concurrencia 5,
timeout 8s, tope de ~150 artículos por corrida.

**Fase 2 — Clasificación.** `classifyUnassignedArticles({ createNewThreads: false })`.
Modo diario: solo asigna a hilos existentes; los de tema nuevo pasan a
`deferred`. Si falla → continúa (los artículos se acumulan).

**Fase 3 — Análisis.** `analyzeAllThreads({ onlyWithRecentArticles: true })`.
Solo analiza hilos con artículos nuevos desde su último análisis. Si falla un
hilo → continúa con los demás.

**Fase 3b — Predicciones.** `evaluateDuePredictions()`. Evalúa las vencidas.

Sale con código 0 (éxito) o 1 (error) para que el cron lo registre.

### Pipeline SEMANAL — `src/jobs/weekly.ts`

**Fase 1 — Clasificación completa.** `classifyUnassignedArticles({ createNewThreads: true })`.
Procesa `pending` + `deferred` y **crea hilos nuevos**.

**Fase 2 — Consolidación.** `consolidateThreads({ dryRun: false })`.

**Fase 3 — Poda.** `pruneThreads({ dryRun: false })`.

**Fase 4 — Neurona.** `detectThreadLinks()` y luego `runMetaAnalysis()`.

**Por qué diario vs semanal:** crear hilos es una decisión *estructural*. Un tema
que aparece un solo día es un evento aislado, no un teatro. Esperar a la revisión
semanal deja madurar los temas y filtra ruido. Analizar, en cambio, es el latido:
va diario. Para eventos de ruptura, se crea el hilo a mano desde la UI.

---

## 8. Lógica de las piezas clave

### `analyze.ts` — `analyzeAllThreads(opts)`

Selecciona hilos activos con ≥2 perspectivas. Con
`onlyWithRecentArticles: true`, exige además al menos un artículo con `fetchedAt`
en las últimas 24h.

Para cada hilo:
1. Si tiene `state`: envía **solo los artículos nuevos** desde el último análisis
   + el `state`.
2. Si **no** tiene `state` (primer análisis): envía todos los disponibles (máx ~40)
   para construir la primera memoria. *Salvaguarda importante: sin ella, un hilo
   nuevo se analizaría sin contexto y produciría un `state` pobre que arrastraría
   el problema.*
3. Amplía a texto completo 2 artículos (3 si es primer análisis).
4. Llama a `analyzeThread()`.
5. Valida la respuesta (ver §9).
6. Si hay predicción: verificación factual → red-team → registro.
7. Guarda el análisis y **sobrescribe** `state`, `countries`, `actors`,
   `domains`, `tensionLevel`.

### `consolidate.ts` — pre-filtrado estructural

No compara todos los pares. Primero calcula candidatos con `signalBetween()`:

- **Dominios compartidos** (≥1 obligatorio).
- **Países y actores ponderados por rareza (IDF):** el peso es inverso a la
  frecuencia. Compartir `KZ` (en 2 hilos) es señal fuerte; compartir `US` (en 17)
  es señal nula.
- **Corte de hubs al 25%:** una entidad presente en más del 25% de los hilos
  activos se ignora como señal de conexión.
- Umbral de peso: **1.0** para fusionar.
- `MAX_GROUP_SIZE = 3`, grupos **disjuntos** (greedy por peso descendente).

**Protecciones (`isProtectedThread`):** un hilo con ≥5 perspectivas, >150
artículos o `tensionLevel = 5` **puede absorber pero nunca ser absorbido**. Evita
que un teatro maduro (ej. Rusia-OTAN, 600 artículos) se diluya en un
macro-teatro.

Al fusionar: `mergeThreadStates()` unifica las memorias (sin esto se perdería
historia silenciosamente), `extractEntities()` recalcula entidades, y
`proposeMergedTitle()` propone un título nuevo.

### `prune.ts` — `pruneThreads({ dryRun })`

Desactiva (`active = false`, **nunca borra**) si:
1. <3 artículos y >7 días de antigüedad
2. 1 sola perspectiva y >7 días
3. Sin artículos nuevos en 21 días
4. Sin ningún análisis y >14 días

**No poda nunca:** `origin = manual`, desviación activa, o `tensionLevel >= 4`.

Dry-run por defecto.

### `links.ts` — `detectThreadLinks()`

Reutiliza `signalBetween()` de consolidación, pero con **umbral 0.4** (más
permisivo: aquí buscamos relaciones, no identidad). Tope de 80 pares por corrida,
ordenados por peso.

Cada par va a `classifyLink()` (Flash), que determina `linkType` + `rationale`
material y **puede devolver "sin conexión"** si el solapamiento es casual.

Upsert: si el par existe, incrementa `timesConfirmed`.

### `verify.ts` + `redteam.ts` — el contra-debate

Se ejecuta **antes** de registrar una predicción, pero **solo cuando la
predicción es de riesgo** (filtro condicional):

- Fuente única: la afirmación clave aparece en **1 sola perspectiva** según
  `verifyPredictionFacts()`.
- El teatro tiene **<3 perspectivas** distintas.
- `againstInertia` del analista: la predicción va contra el comportamiento
  histórico del actor.

Si **ninguna** se cumple (corroborada por 3+ perspectivas y continuista), el
red-team se salta y la predicción se registra directamente con confidence alta.
Loguea el desglose: `CONTRA-DEBATE — N evaluados (motivos), M saltados
(corroborados)`.

1. `extractClaims()` saca las afirmaciones fácticas del statement y el summary.
2. `verifyPredictionFacts()` busca corroboración en la BD: ¿en cuántas
   perspectivas distintas aparece cada hecho? Busca en el teatro y en los
   conectados vía `thread_links`.
3. `runRedTeam()` llama al modelo con rol **opuesto**: destruir la predicción.
   Ataca por cuatro vías: calidad de la fuente, inercia estructural, hipótesis
   alternativa, e intereses del predictor.

Resolución:
```
sostiene → se registra tal cual, confidence alta
debilita → se registra suggestedRevision, confidence media
refuta   → NO se registra predicción (mejor ninguna que mala)
```
Si el red-team falla por error de API, la predicción se registra con confidence
media (no bloquea el pipeline).

**Por qué existe:** el sistema generó una predicción de alto impacto (fin de la
presencia naval rusa en Tartus) basándose en **un solo artículo sin corroborar**.
Al preguntarle después por el chat, el propio analista la desmontó. El
razonamiento crítico existía pero llegaba tarde.

### `meta.ts` — `runMetaAnalysis()`

1. Selecciona los teatros con análisis en los últimos 7 días, ordenados por
   `(perspectivas × 2) + (tensionLevel × 3) + (desviación ? 5 : 0)`. **Toma 20**,
   no los 61.
2. Envía por cada uno: título, `state`, verdict, countries, actors, domains,
   tensionLevel. Más los `thread_links` entre ellos.
3. Llama al modelo con el META_PROMPT.

**Los `state` son la clave:** al ser resúmenes comprimidos, caben 20 teatros en
~10K tokens. Con artículos crudos sería imposible.

### `predictions.ts` — el ciclo de falsabilidad

`evaluateDuePredictions()`: toma `pending` con `reviewDate <= hoy` (tope 20),
reúne evidencia posterior a `createdAt` (artículos del teatro con `fetchedAt`
posterior + verdicts de análisis del periodo), y llama al evaluador.

**Reglas del evaluador (críticas):**
- No conceder confirmación por parecido temático.
- **La ausencia del hecho es falsación, no inverificabilidad.** Sin esta regla,
  un modelo complaciente marcaría "inverificable" todo lo que no ocurrió y nunca
  reconocerías un fallo.
- `unverifiable` solo cuando la evidencia no permite saber si ocurrió.
- Ser severo: un track record inflado no vale nada.

### El score del dashboard

```
score = (artículos nuevos hoy × 3)
      + (nº perspectivas × 2)
      + (hay desviación ? 10 : 0)
      + (sin leer ? 5 : 0)
```
La desviación pesa más que nada: que un actor rompa su patrón es la señal de
inteligencia de más valor. El hilo con mayor score va de portada.

---

## 9. Salvaguardas y bugs históricos

**Cada una de estas existe porque un bug real la hizo necesaria.** No las quites.

| Salvaguarda | Bug que la motivó |
|---|---|
| `MAX_ITERATIONS` en clasificación | Bucle infinito: artículos "ignorados" reaparecían como pendientes. Gastó ~65¢ reprocesando ~8.700 artículos |
| Estado `deferred` | En modo diario, los artículos de tema nuevo quedaban en `pending` y reaparecían cada iteración |
| `config({ path: ".env.local" })` al inicio de los scripts | `tsx` **no** carga `.env.local` (eso lo hace Next). Debe ir **antes** de importar módulos que crean el cliente DeepSeek |
| `export PATH=".../nvm/.../bin:$PATH"` en el crontab | El cron corre con PATH mínimo y no encuentra el `node` de nvm |
| `max_tokens: 12000` + log de `finish_reason` | Respuestas truncadas al añadir texto completo. Se cortaba el JSON a medias |
| `sanitizeForPrompt()` | El texto scrapeado traía caracteres de control invisibles que rompían el JSON. Fallaba **siempre el mismo hilo** |
| `hasForeignLanguageContamination()` (umbral 8% CJK/cirílico) | Un análisis salió **entero en chino** por contaminación del input. Peor: contaminó el `state`, lo que se autoperpetuaba |
| Retry degradado (sin `fullText`) | Mejor un análisis sin profundidad que ninguno |
| `isValidReviewDate()` + `extractDeadlineFromStatement()` | Predicciones con fechas **en el pasado**, y `reviewDate` anterior a la fecha límite del propio enunciado |
| `imageFetchedAt` / `fullTextFetchedAt` como centinelas | Reintentos infinitos sobre artículos que siempre fallan |
| Contadores honestos | Reportaba "77 imágenes recuperadas" que eran **logos de Google**, y "78 URLs resueltas" que seguían siendo de `news.google.com`. Un sistema que reporta falsos positivos es peor que uno que falla claro |
| Límites duros en todos los scripts de backfill | Evita lanzar miles de peticiones de golpe |

**Regla general:** todo bucle que llame a una API necesita un tope duro. Todo
proceso que lance peticiones en masa necesita límite y concurrencia acotada.
Todo contador debe reportar la realidad, no el intento.

### Limitación conocida: Google News RSS

Cuatro fuentes usaban feeds de Google News. Resultado del diagnóstico
(verificado con datos):

- El feed **no expone la URL real**: `link`, `guid` y el `<a href>` del
  `description` apuntan todos a `news.google.com`.
- El payload base64 del formato nuevo **no contiene la URL** (verificado: 175
  bytes sin `http`).
- La página intermedia responde **HTTP 200 pero sin enlace de salida** (el
  redirect es por JavaScript).

Conclusión: sin URL real no hay imagen ni texto completo. La solución fue migrar
a **feeds nativos**. Solo Xinhua sigue vía Google News (solo titulares).

Feeds verificados y en uso:
```
turca             https://www.dailysabah.com/rssfeed/homepage
rusa              https://tass.com/rss/v2.xml
griega            https://en.protothema.gr/feed/
think tank        https://www.chathamhouse.org/path/83/feed.xml
europea           Politico Europe (feed directo)
china             Xinhua vía Google News (solo titulares)
```
Descartados: Kathimerini (403), ISW y Greek Reporter (Cloudflare), Global Times
(feed abandonado, últimos artículos de junio), China Daily (**congelado desde
2017** — devuelve XML válido con artículos de hace nueve años), Hürriyet (feed
vacío).

**Lección:** un feed que devuelve XML válido no está necesariamente vivo. Verifica
siempre las fechas antes de conectar una fuente.

---

## 10. Operación

### Base de datos

```bash
npm run db:studio     # Drizzle Studio, abre en local.drizzle.studio
npm run db:push       # Aplica cambios de schema.ts a la BD
```

**IMPORTANTE:** cierra Drizzle Studio antes de `db:push`. Studio bloquea el
archivo SQLite y el push falla.

Se usa `db:push`, **no** `db:migrate` — el historial de migraciones quedó
inconsistente y para un proyecto personal en desarrollo `push` es lo correcto.

### Servidor web

```bash
npm run build
pm2 restart boletin
```

**En producción no hay recarga en caliente.** Cada cambio de código requiere
`build` + `restart`. Si el servidor sirve una versión vieja (ej. una ruta nueva
da 404), es que falta reconstruir.

```bash
pm2 list              # estado
pm2 logs boletin      # logs en vivo
```

El script de arranque incluye `-H 0.0.0.0` para que Tailscale pueda alcanzarlo.

### Arranque automático tras reinicio o corte de luz

**Dos capas independientes, ambas necesarias.** Un corte de luz dejó el servidor
caído: el Mac arrancó pero la app no.

**1. Que el Mac encienda.** Ajustes del Sistema → Energía → "Iniciar
automáticamente después de un fallo de alimentación".

**2. Que la app arranque.** pm2 registrado en launchd:

```
pm2 start npm --name boletin -- run start
pm2 save
pm2 startup        # imprime un comando `sudo env PATH=...`
```

**El `pm2 startup` no basta por sí solo:** imprime un comando con `sudo` que hay
que copiar y ejecutar a mano. Si se omite, pm2 no queda registrado en launchd y
no resucita tras un reinicio. Esto es exactamente lo que falló.

El comando que imprimió pm2 en esta máquina (sustituye el usuario por `<user>`
donde corresponda):

```
sudo env PATH=$PATH:/Users/<user>/.nvm/versions/node/v22.11.0/bin /Users/<user>/.nvm/versions/node/v22.11.0/lib/node_modules/pm2/bin/pm2 startup launchd -u <user> --hp /Users/<user>
```

El comando incluye el PATH de nvm, así que el servicio de launchd sí encuentra
`node` — el riesgo de `env: node: No such file or directory` queda cubierto de
entrada.

Verificación:

```
ls -la ~/Library/LaunchAgents/ | grep -i pm2   # debe existir un plist de pm2
pm2 list                                        # boletin debe estar online
```

**Prueba real:** reiniciar el Mac y comprobar el acceso desde el móvil sin tocar
nada. Un `pm2 resurrect` manual que funciona NO demuestra que el arranque
automático esté configurado.

**Riesgo conocido:** el servicio de launchd puede no incluir el PATH de nvm, y
fallaría con `env: node: No such file or directory` — el mismo problema que tuvo
el cron. Si tras reiniciar pm2 no levanta, es esto: hay que apuntar pm2 a la ruta
absoluta de node.

**Cuidado con los procesos duplicados.** Ejecutar `pm2 start` cuando ya hay un
proceso con ese nombre crea un SEGUNDO proceso compitiendo por el puerto 3000, y
`pm2 save` guardaría el estado duplicado. Si `pm2 list` muestra dos líneas con el
mismo nombre: `pm2 delete all`, arrancar de nuevo, y solo entonces `pm2 save`.

**Recuperación manual** si el servidor está caído:

```
cd <proyecto>
pm2 resurrect        # o: pm2 start npm --name boletin -- run start
pm2 list
```

### Jobs

```bash
npm run job:daily
npm run job:weekly
npx tsx src/jobs/analyze-one.ts <threadId>   # diagnóstico de un solo hilo
```

### Scripts puntuales

```bash
npm run db:seed                            # sembrar las 6 fuentes iniciales
npm run db:fix-status                      # backfill classificationStatus (una vez)
npm run script:prune-threads                   # dry-run
PRUNE_APPLY=1 npm run script:prune-threads     # aplicar
npm run script:backfill-entities
BACKFILL_NORMALIZE=1 npm run script:backfill-entities
npm run script:clean-images
npm run script:backfill-predictions
```

### Cron

```
0 23 * * * export PATH="/Users/<user>/.nvm/versions/node/v22.11.0/bin:$PATH" && cd <proyecto> && npm run job:daily >> logs/daily-$(date +\%Y-\%m-\%d).log 2>&1
0 22 * * 0 export PATH="/Users/<user>/.nvm/versions/node/v22.11.0/bin:$PATH" && cd <proyecto> && npm run job:weekly >> logs/weekly-$(date +\%Y-\%m-\%d).log 2>&1
```

- **Diario a las 23:00** (hora local), **semanal domingos a las 22:00**.
- El `export PATH` es imprescindible: el cron no carga el PATH de nvm.
- El `cd` al proyecto hace que `logs/` sea relativo al proyecto.
- Se gestiona **solo** con `crontab -e` / `crontab -l`. No es un archivo del
  proyecto.
- Requiere que el Mac **no entre en reposo** y que `cron` tenga acceso a disco
  completo en Privacidad y Seguridad de macOS.
- **El cron sí sobrevive a los reinicios** (es un servicio del sistema).

**Por qué a las 23:00 — franjas de precio de DeepSeek**

Desde el 16 de agosto de 2026 (16:00 UTC), DeepSeek factura por franjas: pico al
doble que valle. Ventanas de pico: **01:00–04:00 y 06:00–10:00 UTC**.

| Franja | Lyon verano (CEST, UTC+2) | Lyon invierno (CET, UTC+1) |
|---|---|---|
| Pico 1 | 03:00–06:00 | 02:00–05:00 |
| Pico 2 | 08:00–12:00 | 07:00–11:00 |

Con el cron a las 23:00 / 22:00 local, los jobs corren a 21:00–22:00 UTC: tres o
cuatro horas de margen antes del primer pico, todo el año, incluso si una corrida
se alarga (la de migración de fuentes duró 29 minutos).

**Configuración anterior descartada:** diario 01:00 y semanal 02:00 local. El
semanal caía en pico tras el cambio de hora de octubre (02:00 CET = 01:00 UTC), y
el diario quedaba con solo una hora de margen.

**No ejecutar jobs a mano entre las 07:00 y las 12:00 locales:** cae de lleno en
la segunda ventana de pico.

### Acceso remoto

Tailscale en el Mac y en el móvil. Se accede por la IP del tailnet + puerto 3000.
La IP de Tailscale es **fija**. En modo desarrollo hace falta `allowedDevOrigins`
en `next.config`; en producción no.

---

## 11. Coste

**Tarifas de deepseek-v4-flash** (desde el 16 de agosto de 2026):

| Concepto | Valle | Pico |
|---|---|---|
| 1M input (cache hit) | $0,007 | $0,014 |
| 1M input (cache miss) | $0,22 | $0,44 |
| 1M output | $0,66 | $1,32 |

| Estimación | Aprox. (en valle) |
|---|---|
| Noche tranquila (2-5 hilos) | ~$0,02-0,06 |
| Noche movida (20+ hilos) | ~$0,20 |
| Mes en régimen normal | ~$2-6 |

**Nota:** los precios subieron respecto a los anteriores ($0,14 input / $0,28
output). Correr en valle evita pagar el doble del precio nuevo, pero no devuelve
al precio viejo: la salida es ~2,4x más cara que antes.

Optimizaciones que mantienen el coste bajo:
- **Flash en todo** (~3x más barato que Pro, calidad verificada como equivalente)
- **Análisis incremental**: solo hilos con novedad (de 19 hilos a 2-5 por noche)
- **El `state` como memoria**: input reducido 50-70%
- **Context caching** de DeepSeek: el cache hit cuesta 31x menos que el miss, así
  que mantener prefijos estables entre lotes importa mucho
- **Modelo barato para tareas mecánicas**: clasificar, extraer entidades,
  clasificar links

---

## 12. Método analítico (va en los prompts)

No es decoración: es la especificación del producto.

1. **Separar hecho de relato.**
2. **Triangular por perspectiva** — comparar cómo cada sesgo encuadra lo mismo.
3. **Cui bono material** — rechazar retórica de valores; buscar dinero, energía,
   rutas, territorio, influencia.
4. **Dicho vs hecho** — contrastar declaraciones con comportamiento.
5. **Detectar desviaciones** — usando el `state` como línea base.
6. **Predicción falsable** — una sola proposición binaria, con fecha y condición
   de falsación que sea el complemento lógico exacto.
7. **Veredicto sin diplomacia.**

Vocabulario embebido: DragonBear, Pax Silica, motor soberano, estado bisagra,
hedging, bancabilidad, autonomía estratégica.

**Advertencia sobre sesgo de marco:** al tener ese vocabulario en el prompt, el
modelo puede tender a "encontrar" los conceptos en los datos. Se verificó
corriendo el meta-análisis tres veces sobre los mismos datos: las tesis
convergieron y una rechazó explícitamente el marco fácil ("el conjunto no muestra
una bipolaridad USA-China, sino una multipolaridad caótica"). Si en el futuro las
lecturas semanales oscilan sin razón, sospechar del prompt antes que del mundo.

---

## 13. Mejoras pendientes

| Mejora | Notas |
|---|---|
| `influencia_politica` como dominio hub | Aparece en casi todos los teatros; discrimina poco. Aplicarle IDF o excluirlo como señal de conexión |
| Filtro condicional del red-team | **Implementado.** Solo se ejecuta si la predicción es de riesgo: fuente única (1 perspectiva en verify), teatro con <3 perspectivas, o `againstInertia`. Si está corroborada (3+ perspectivas) y es continuista, se registra con confidence alta sin red-team. Log: "CONTRA-DEBATE — N evaluados (fuente única / <3 persp / contra inercia), M saltados (corroborados)" |
| Escalar el thinking por complejidad | `high` para teatros ricos, bajo para pequeños |
| Detección de eventos de ruptura | Que un tema que explota de golpe cree hilo sin esperar al ciclo semanal |
| Paywalls en el scraping | Detectar y descartar textos sospechosamente cortos o con patrones de suscripción |
| Backfill del histórico de imágenes | Irrecuperable para Google News (tokens muertos); solo aplica a fuentes directas |
| Tabla `events` | Sin usar. Eliminar o darle propósito |
| Densidad del grafo | Necesita semanas de corridas para que `timesConfirmed` distinga lo estructural del ruido |

---

## 14. Notas para el agente de código

- **Un cambio a la vez**, verificando entre medias. La mayoría de los bugs de
  este proyecto surgieron de la interacción entre dos cambios aplicados juntos.
- **Explica el razonamiento antes del código.** El dueño del proyecto quiere
  entender el "por qué" antes de aceptar un diff.
- **Dry-run obligatorio** en cualquier operación destructiva o masiva, aunque sea
  reversible.
- **Nada de `localStorage`** en el frontend: no funciona en este entorno. Estado
  en React.
- **Los contadores no mienten.** Si una operación no logró lo que pretendía, el
  log debe decirlo. Preferimos un fallo visible a un éxito falso.
- **Español** en prompts, logs y análisis.
- Las respuestas del modelo se validan **siempre**: JSON parseable, claves
  obligatorias presentes, idioma correcto, fechas futuras.
