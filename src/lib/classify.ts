import { db } from "./db/index";
import { articles, sources, threads, articleThreads } from "./db/schema";
import { eq, sql, or, inArray } from "drizzle-orm";
import { classifyArticles } from "./deepseek";
import type { ClassifyOutput } from "./deepseek";

const BATCH_SIZE = 30;
const PAUSE_MS = 500;

/*
 * classifyUnassignedArticles — Orquesta la clasificación de TODOS los
 * artículos pendientes, procesando lote por lote hasta agotarlos.
 *
 * Modo DIARIO (createNewThreads=false):
 *   - Solo procesa artículos con classificationStatus = "pending".
 *   - Los asigna SOLO a hilos existentes.
 *   - Los que necesitan hilo nuevo → se marcan "deferred" (NO "pending").
 *     El job semanal los consumirá cuando cree los hilos que necesitan.
 *   - Termina cuando no quedan "pending". Los "deferred" no reaparecen.
 *
 * Modo SEMANAL (createNewThreads=true):
 *   - Procesa artículos "pending" Y "deferred".
 *   - Crea hilos nuevos para los que DeepSeek propone.
 *   - Todos los procesados terminan en "classified" o "ignored".
 *
 * Flujo de estados:
 *   pending ─┬─ (hilo existente) → classified
 *            ├─ (irrelevante) ────→ ignored
 *            └─ (hilo nuevo,      → deferred [diario] o classified [semanal]
 *                createNewThreads?)
 */

export async function classifyUnassignedArticles(opts?: {
  createNewThreads?: boolean;
}): Promise<{
  totalProcessed: number;
  totalClassified: number;
  threadsCreated: number;
  totalIgnored: number;
  totalDeferred: number;
  batchesFailed: number;
}> {
  const createNewThreads = opts?.createNewThreads ?? true;

  /*
   * En modo semanal procesamos tanto "pending" como "deferred".
   * En modo diario solo "pending" (los deferred esperan al job semanal).
   */
  const targetStatuses = createNewThreads
    ? (["pending", "deferred"] as const)
    : (["pending"] as const);

  const pendingCount = (
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(articles)
      .where(inArray(articles.classificationStatus, targetStatuses))
      .get()
  )?.count ?? 0;

  const estimatedBatches = Math.ceil(pendingCount / BATCH_SIZE);
  const MAX_ITERATIONS = estimatedBatches + 5;

  const mode = createNewThreads ? "COMPLETO (crea hilos nuevos)" : "DIARIO (solo hilos existentes)";
  console.log(
    `\n📰 CLASIFICACIÓN INICIADA [${mode}] — ${pendingCount} artículos (${targetStatuses.join(" + ")}) (~${estimatedBatches} lotes, máx ${MAX_ITERATIONS} iteraciones)\n`
  );

  let cumulativeProcessed = 0;
  let cumulativeClassified = 0;
  let cumulativeThreadsCreated = 0;
  let cumulativeIgnored = 0;
  let cumulativeDeferred = 0;
  let batchesFailed = 0;
  let batchIndex = 0;

  while (true) {
    /*
     * Paso 0: Salvaguarda anti-bucle infinito.
     * Si por algún bug los pending no bajan, cortamos antes de saturar la API.
     */
    if (batchIndex >= MAX_ITERATIONS) {
      console.error(
        `\n⛔ ABORTANDO: se alcanzó el límite de ${MAX_ITERATIONS} iteraciones. ` +
          `Posible bug: los artículos no están cambiando de estado. ` +
          `Revisa classify.ts y la lógica de UPDATE classificationStatus.\n`
      );
      break;
    }

    /*
     * Paso 1: Obtener el siguiente lote de artículos (pending / pending+deferred).
     */
    const batch = db
      .select({
        id: articles.id,
        title: articles.title,
        content: articles.content,
        sourceName: sources.name,
        bias: sources.bias,
      })
      .from(articles)
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(inArray(articles.classificationStatus, targetStatuses))
      .limit(BATCH_SIZE)
      .all();

    if (batch.length === 0) {
      console.log("✅ No quedan artículos por procesar. Terminado.\n");
      break;
    }

    batchIndex++;

    /*
     * Paso 2: Recargar threads existentes ANTES de cada lote.
     */
    const existingThreads = db
      .select({
        id: threads.id,
        title: threads.title,
        description: threads.description,
      })
      .from(threads)
      .where(eq(threads.active, true))
      .all();

    console.log(
      `📦 Lote ${batchIndex}/${MAX_ITERATIONS} — ${batch.length} artículos, ${existingThreads.length} hilos existentes`
    );

    try {
      /*
       * Paso 3: Clasificar con DeepSeek.
       */
      const classification: ClassifyOutput = await classifyArticles({
        articles: batch,
        existingThreads,
      });

      /*
       * Paso 4a: Crear hilos nuevos propuestos (solo si createNewThreads=true).
       *
       * En modo diario (createNewThreads=false), NO creamos hilos nuevos.
       * Los artículos que no encajan en hilos existentes se quedan como
       * "pending" para que el job semanal los procese con createNewThreads=true.
       */
      const tempIdToRealId = new Map<string, number>();
      const now = new Date().toISOString();

      if (createNewThreads) {
        for (const proposal of classification.proposedThreads) {
          const row = db
            .insert(threads)
            .values({
              title: proposal.title,
              description: proposal.description,
              origin: "ai",
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: threads.id })
            .get();

          if (row) {
            tempIdToRealId.set(proposal.tempId, row.id);
          }
        }
      }

      let batchClassified = 0;
      let batchIgnored = 0;

      /*
       * Paso 4b: Procesar assignments, insertar vínculos y actualizar status.
       */
      for (const assignment of classification.assignments) {
        if (assignment.ignore) {
          /*
           * Marcamos como "ignored" para que no reaparezca en lotes futuros.
           * Sin este UPDATE, el artículo seguiría "pending" → bucle infinito.
           */
          db.update(articles)
            .set({ classificationStatus: "ignored" })
            .where(eq(articles.id, assignment.articleId))
            .run();

          batchIgnored++;
          continue;
        }

        let targetThreadId: number | null = null;

        if (assignment.threadId) {
          targetThreadId = assignment.threadId;
        } else if (assignment.newThreadProposal && createNewThreads) {
          /*
           * Modo semanal: creamos el hilo nuevo y vinculamos el artículo.
           */
          if ("tempId" in assignment.newThreadProposal) {
            const resolved = tempIdToRealId.get(assignment.newThreadProposal.tempId);
            if (resolved) targetThreadId = resolved;
          } else if ("title" in assignment.newThreadProposal) {
            const row = db
              .insert(threads)
              .values({
                title: assignment.newThreadProposal.title,
                description: assignment.newThreadProposal.description,
                origin: "ai",
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: threads.id })
              .get();
            if (row) targetThreadId = row.id;
          }
        } else if (assignment.newThreadProposal && !createNewThreads) {
          /*
           * Modo diario: el artículo necesita un hilo que aún no existe.
           * Lo marcamos como "deferred" para que NO reaparezca en el bucle
           * diario (solo selecciona "pending"). El job semanal lo procesará
           * cuando createNewThreads=true y podrá crear el hilo que necesita.
           *
           * ANTES DEL BUG: se quedaba como "pending" → bucle infinito.
           * AHORA: pasa a "deferred" → sale de la cola diaria limpiamente.
           */
          db.update(articles)
            .set({ classificationStatus: "deferred" })
            .where(eq(articles.id, assignment.articleId))
            .run();

          cumulativeDeferred++;
          continue;
        }

        if (targetThreadId) {
          db.insert(articleThreads)
            .values({
              articleId: assignment.articleId,
              threadId: targetThreadId,
            })
            .onConflictDoNothing()
            .run();

          /*
           * Marcamos como "classified" para que no reaparezca en lotes futuros.
           */
          db.update(articles)
            .set({ classificationStatus: "classified" })
            .where(eq(articles.id, assignment.articleId))
            .run();

          batchClassified++;
        }
      }

      cumulativeProcessed += batch.length;
      cumulativeClassified += batchClassified;
      cumulativeThreadsCreated += createNewThreads ? classification.proposedThreads.length : 0;
      cumulativeIgnored += batchIgnored;

      console.log(
        `   ✅ Clasificados: ${batchClassified} | Ignorados: ${batchIgnored} | Diferidos: ${createNewThreads ? 0 : "(ver acumulado)"} | Hilos nuevos: ${createNewThreads ? classification.proposedThreads.length : "—"}`
      );
      console.log(
        `   📊 Acumulado — ${cumulativeClassified} clasificados, ${cumulativeDeferred} diferidos, ${cumulativeThreadsCreated} hilos, ${cumulativeIgnored} ignorados`
      );
    } catch (err) {
      batchesFailed++;
      cumulativeProcessed += batch.length;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`   ❌ LOTE ${batchIndex} FALLÓ: ${message}`);
      console.error(`   Continuando con el siguiente lote...`);
    }

    if (batch.length === BATCH_SIZE) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  const summary = {
    totalProcessed: cumulativeProcessed,
    totalClassified: cumulativeClassified,
    threadsCreated: cumulativeThreadsCreated,
    totalIgnored: cumulativeIgnored,
    totalDeferred: cumulativeDeferred,
    batchesFailed,
  };

  console.log(
    `🏁 CLASIFICACIÓN COMPLETADA — ${summary.totalClassified} clasificados, ${summary.totalDeferred} diferidos, ${summary.threadsCreated} hilos, ${summary.totalIgnored} ignorados, ${summary.batchesFailed} lotes fallidos\n`
  );

  return summary;
}
