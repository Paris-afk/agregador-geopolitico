import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

/*
 * sources — Fuentes de noticias (ej: Kathimerini, Reuters, etc.)
 *
 * Tipos de dato en SQLite:
 *   - integer con autoIncrement para IDs: SQLite autoincrementa rowid cuando
 *     la columna es INTEGER PRIMARY KEY, no necesita tipo serial.
 *   - text para strings: SQLite no tiene varchar; text es el tipo canónico.
 *   - text con enum para bias: restringe las perspectivas geopolíticas posibles
 *     a nivel TypeScript (en SQLite es solo text, sin CHECK constraint).
 *   - integer con mode "boolean": SQLite no tiene tipo booleano nativo; Drizzle
 *     serializa/deserializa automáticamente entre 0/1 y true/false.
 *   - text para fechas: SQLite no tiene timestamp nativo. Usamos ISO 8601 en
 *     texto para legibilidad y portabilidad (alternativa: integer Unix epoch).
 *   - lastFetchStatus es nullable: una fuente recién creada aún no ha sido
 *     consultada, por lo que no tiene estado de fetch previo.
 *   - lastFetchAt es nullable por la misma razón; solo se setea tras el
 *     primer intento de ingesta.
 */
export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  rssUrl: text("rss_url").notNull(),
  bias: text("bias", {
    enum: [
      "greek",
      "turkish",
      "russian",
      "chinese",
      "european",
      "western_thinktank",
      "other",
    ],
  }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  lastFetchStatus: text("last_fetch_status", {
    enum: ["ok", "error", "blocked", "empty"],
  }),
  lastFetchAt: text("last_fetch_at"),
});

/*
 * articles — Artículos crudos obtenidos vía RSS de cada fuente.
 *
 *   - sourceId referencia sources.id con foreign key.
 *   - url es unique para evitar duplicados al re-insertar artículos ya capturados.
 *   - publishedAt es la fecha original de publicación según la fuente.
 *   - fetchedAt es la fecha en que nuestro sistema capturó el artículo.
 *   - content puede ser el texto completo o un resumen/extracto del feed.
 *   - classificationStatus rastrea el pipeline de clasificación:
 *     "pending" → aún no procesado por el clasificador
 *     "classified" → vinculado al menos a un thread en article_threads
 *     "ignored" → DeepSeek lo marcó como irrelevante (deportes, farándula, etc.)
 *     "deferred" → necesita un hilo NUEVO que aún no existe; el job diario lo
 *       deja apartado para que el job semanal (createNewThreads=true) lo
 *       procese cuando cree el hilo que necesita.
 *
 *     Flujo de estados (máquina de estados del pipeline):
 *       ┌─────────┐
 *       │ pending │──(encaja en hilo existente)──→ classified
 *       │         │──(irrelevante)───────────────→ ignored
 *       │         │──(necesita hilo nuevo,        → deferred
 *       └─────────┘   solo en modo semanal)───────→ classified
 *
 *     Este campo es lo que permite que el bucle de clasificación termine:
 *     ningún artículo se queda "pending" tras ser procesado. En modo diario,
 *     los que necesitan hilo nuevo pasan a "deferred"; en modo semanal,
 *     se consumen tanto "pending" como "deferred".
 */
export const articles = sqliteTable("articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id")
    .notNull()
    .references(() => sources.id),
  title: text("title").notNull(),
  content: text("content").notNull(),
  url: text("url").notNull().unique(),
  publishedAt: text("published_at").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  classificationStatus: text("classification_status", {
    enum: ["pending", "classified", "ignored", "deferred"],
  })
    .notNull()
    .default("pending"),
  imageUrl: text("image_url"),
  resolvedUrl: text("resolved_url"),
  imageFetchedAt: text("image_fetched_at"),
  fullText: text("full_text"),
  fullTextFetchedAt: text("full_text_fetched_at"),
});

/*
 * ============================================================================
 * SISTEMA DE ANÁLISIS CON MEMORIA HISTÓRICA
 * ============================================================================
 *
 * Arquitectura de las 4 tablas nuevas y su propósito:
 *
 *   articles ──┐
 *              ├── article_threads ──┐
 *   threads ───┘                    │
 *       │                           └── (tabla puente muchos-a-muchos)
 *       ├── events     (línea temporal de hechos del hilo)
 *       └── analyses   (análisis de DeepSeek sobre el hilo)
 *
 *   Flujo: un artículo nuevo se vincula a uno o varios threads. DeepSeek
 *   lee los artículos del thread, produce un analysis, y actualiza el state
 *   del thread (la memoria acumulada). Además, de cada artículo pueden
 *   extraerse events concretos que se añaden a la línea temporal del thread.
 */

/*
 * threads — Hilos geopolíticos persistentes.
 *
 *   Cada thread representa una narrativa o conflicto de larga duración
 *   (ej: "Tensiones en el Egeo", "Ruta de la Seda digital"). No es un
 *   simple tag: tiene memoria.
 *
 *   state es el campo clave de la arquitectura:
 *     - Almacena la SÍNTESIS ACUMULADA del hilo hasta la fecha.
 *     - Cada vez que DeepSeek analiza el thread, state se actualiza con
 *       la nueva trayectoria, intenciones detectadas y evolución.
 *     - Es lo que permite que el sistema "recuerde" lo que sabía ayer
 *       y compare con lo nuevo hoy. Sin state, cada análisis sería un
 *       borrón y cuenta nueva.
 *     - Es nullable porque un thread recién creado puede no tener
 *       síntesis todavía (hasta el primer análisis).
 *
 *   origin:
 *     - "ai"  → DeepSeek detectó este hilo automáticamente al analizar feeds.
 *     - "manual" → Lo creé yo desde la UI (ej: vi un patrón y abrí el hilo).
 */
export const threads = sqliteTable("threads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  state: text("state"),
  origin: text("origin", { enum: ["ai", "manual"] }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /*
   * ENTIDADES DEL TEATRO — extraídas en cada análisis, sobrescritas como el
   * state. Almacenadas como JSON arrays (text) porque SQLite no tiene arrays.
   *
   *   - countries:    códigos ISO 3166-1 alpha-2 de países que son ACTORES o
   *                   ESCENARIO (no los mencionados de pasada).
   *   - actors:       actores no estatales/supranacionales (OTAN, UE, Hezbolá,
   *                   Gazprom, milicias, empresas).
   *   - domains:      recursos/dominios materiales en juego (energía, agua,
   *                   rutas marítimas, chips, tierras raras, armas, datos).
   *                   Clave para conectar teatros por CADENA MATERIAL.
   *   - tensionLevel: escalada 1-5 (1 latente → 5 conflicto abierto).
   */
  countries: text("countries"),
  actors: text("actors"),
  domains: text("domains"),
  tensionLevel: integer("tension_level"),
});

/*
 * events — Hechos concretos en la línea temporal de un thread.
 *
 *   Un event es un punto discreto en el tiempo: "El 12 de julio, el
 *   buque X entró en aguas en disputa". Los events se extraen de los
 *   artículos (un artículo puede generar 0, 1 o varios events) y se
 *   vinculan al thread al que pertenecen cronológica y temáticamente.
 *
 *   eventDate es la fecha en que ocurrió el hecho (según la fuente),
 *   no cuándo se registró en el sistema (eso es createdAt).
 */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threads.id),
  description: text("description").notNull(),
  eventDate: text("event_date").notNull(),
  createdAt: text("created_at").notNull(),
});

/*
 * analyses — Análisis de DeepSeek sobre un thread en una fecha concreta.
 *
 *   Cada fila es UN análisis puntual (ej: "análisis diario del 14-jul-2026
 *   del thread Egeo"). Estructura inspirada en el método de análisis de
 *   inteligencia: qué pasó, quién gana, contraste narrativa/acción, desvíos
 *   del patrón, predicción falsable, y veredicto final.
 *
 *   threadId es nullable porque un análisis podría ser multi-thread o
 *   exploratorio (sin hilo asignado todavía). En la práctica, casi siempre
 *   pertenecerá a un thread.
 */
export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: integer("thread_id").references(() => threads.id),
  summary: text("summary").notNull(),
  cuiBono: text("cui_bono").notNull(),
  saidVsDone: text("said_vs_done").notNull(),
  deviation: text("deviation"),
  prediction: text("prediction"),
  predictionStatement: text("prediction_statement"),
  predictionCondition: text("prediction_condition"),
  predictionFalsification: text("prediction_falsification"),
  predictionReviewDate: text("prediction_review_date"),
  rebuttal: text("rebuttal"),
  alternativeHypothesis: text("alternative_hypothesis"),
  rebuttalVerdict: text("rebuttal_verdict", {
    enum: ["sostiene", "debilita", "refuta"],
  }),
  verdict: text("verdict").notNull(),
  analysisDate: text("analysis_date").notNull(),
  createdAt: text("created_at").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
});

/*
 * article_threads — Tabla puente muchos-a-muchos entre artículos y threads.
 *
 *   Un artículo puede alimentar múltiples hilos (ej: una noticia sobre
 *   maniobras militares puede ser relevante para el hilo "Egeo" y para
 *   el hilo "OTAN"). Un hilo se nutre de múltiples artículos.
 *
 *   La PK compuesta (articleId, threadId) evita duplicados: un mismo
 *   artículo no puede vincularse dos veces al mismo hilo.
 */
export const articleThreads = sqliteTable(
  "article_threads",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threads.id),
  },
  (table) => [primaryKey({ columns: [table.articleId, table.threadId] })],
);

/*
 * thread_links — Conexiones entre teatros detectadas por el meta-análisis.
 *
 * A diferencia de la consolidación (que funde teatros que son el MISMO juego),
 * un link es una RELACIÓN material entre dos teatros distintos que comparten
 * cadena, bloque, presión coordinada, competencia por recurso, distracción o
 * motor interno. La "neurona": conecta el tablero para revelar lo que ningún
 * teatro revela por separado.
 *
 *   - linkType: tipo de conexión (enum cerrado).
 *   - rationale: por qué están conectados, en términos MATERIALES.
 *   - strength: 1-3 (débil → fuerte).
 */
export const threadLinks = sqliteTable("thread_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadA: integer("thread_a")
    .notNull()
    .references(() => threads.id),
  threadB: integer("thread_b")
    .notNull()
    .references(() => threads.id),
  linkType: text("link_type", {
    enum: [
      "cadena_material",
      "mismo_bloque",
      "presion_coordinada",
      "competencia_recurso",
      "distraccion",
      "motor_interno",
    ],
  }).notNull(),
  rationale: text("rationale").notNull(),
  strength: integer("strength").notNull(),
  detectedAt: text("detected_at").notNull(),
  /*
   * ESTABILIDAD DEL GRAFO: los links se recalculan cada semana y algunos
   * pares de peso medio oscilan entre corridas. En lugar de duplicar, si un
   * par ya existe se ACTUALIZA: timesConfirmed++ y lastSeenAt se refresca.
   * Un enlace confirmado N semanas seguidas es más fiable que uno de una vez.
   */
  timesConfirmed: integer("times_confirmed").notNull().default(1),
  lastSeenAt: text("last_seen_at").notNull(),
});

/*
 * meta_analyses — Lectura del tablero GLOBAL (el "editorial").
 *
 * No resume teatros uno por uno: revela qué aporta el CONJUNTO. Producido por
 * runMetaAnalysis() sobre los ~20 teatros más relevantes de los últimos 7 días
 * y los thread_links detectados entre ellos.
 */
export const metaAnalyses = sqliteTable("meta_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  systemReading: text("system_reading").notNull(),
  blocFormation: text("bloc_formation").notNull(),
  crossPatterns: text("cross_patterns").notNull(),
  contradictions: text("contradictions").notNull(),
  predictionStatement: text("prediction_statement").notNull(),
  predictionCondition: text("prediction_condition").notNull(),
  predictionFalsification: text("prediction_falsification").notNull(),
  predictionReviewDate: text("prediction_review_date"),
  verdict: text("verdict").notNull(),
  threadIds: text("thread_ids").notNull(),
  createdAt: text("created_at").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
});

/*
 * predictions — Registro de predicciones falsables, para cerrar el ciclo de
 * validación y medir el track record del analista.
 *
 * Las predicciones son BINARIAS por diseño (sin status "partial"): al llegar
 * la fecha de revisión se evalúan como confirmadas o falsadas. Solo cuando la
 * evidencia no permite saber si ocurrió se marcan "unverifiable".
 *
 *   - sourceType: thread (viene de un análisis de teatro) | meta (sistémica).
 *   - sourceId: id del análisis o meta_análisis de origen.
 *   - status: pending | confirmed | falsified | unverifiable.
 */
export const predictions = sqliteTable("predictions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceType: text("source_type", { enum: ["thread", "meta"] }).notNull(),
  sourceId: integer("source_id").notNull(),
  threadId: integer("thread_id").references(() => threads.id),
  statement: text("statement").notNull(),
  condition: text("condition"),
  falsificationCondition: text("falsification_condition"),
  reviewDate: text("review_date"),
  status: text("status", {
    enum: ["pending", "confirmed", "falsified", "unverifiable"],
  })
    .notNull()
    .default("pending"),
  confidence: text("confidence", { enum: ["alta", "media", "baja"] }),
  rebuttal: text("rebuttal"),
  resolution: text("resolution"),
  resolvedAt: text("resolved_at"),
  evidenceArticleIds: text("evidence_article_ids"),
  createdAt: text("created_at").notNull(),
});

/*
 * ============================================================================
 * RELATIONS — Definiciones de navegación entre tablas para Drizzle.
 * ============================================================================
 *
 * Las relations() permiten que Drizzle infiera los tipos en queries con
 * joins navegando el grafo de tablas de forma tipada, ej:
 *
 *   db.query.threads.findMany({ with: { events: true, analyses: true } })
 *
 * Cada relación se define en ambos sentidos (one → many y many → one).
 */

export const threadsRelations = relations(threads, ({ many }) => ({
  events: many(events),
  analyses: many(analyses),
  articleThreads: many(articleThreads),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  thread: one(threads, {
    fields: [events.threadId],
    references: [threads.id],
  }),
}));

export const analysesRelations = relations(analyses, ({ one }) => ({
  thread: one(threads, {
    fields: [analyses.threadId],
    references: [threads.id],
  }),
}));

export const articleThreadsRelations = relations(articleThreads, ({ one }) => ({
  article: one(articles, {
    fields: [articleThreads.articleId],
    references: [articles.id],
  }),
  thread: one(threads, {
    fields: [articleThreads.threadId],
    references: [threads.id],
  }),
}));

export const articlesRelations = relations(articles, ({ many }) => ({
  articleThreads: many(articleThreads),
}));
