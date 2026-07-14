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
  verdict: text("verdict").notNull(),
  analysisDate: text("analysis_date").notNull(),
  createdAt: text("created_at").notNull(),
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
