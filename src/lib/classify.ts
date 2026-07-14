import { db } from "./db/index";
import { articles, sources, threads, articleThreads } from "./db/schema";
import { eq, sql } from "drizzle-orm";
import { classifyArticles } from "./deepseek";
import type { ClassifyOutput } from "./deepseek";

const BATCH_SIZE = 30;
const PAUSE_MS = 500;

/*
 * classifyUnassignedArticles — Orquesta la clasificación de TODOS los
 * artículos pendientes, procesando lote por lote hasta agotarlos.
 *
 * Flujo por lote:
 *  1. SELECT de artículos con classificationStatus = "pending".
 *     Ya NO usamos LEFT JOIN con article_threads porque los artículos
 *     "ignored" nunca se vinculan y causaban bucle infinito.
 *  2. Recargamos los threads activos existentes ANTES de cada lote.
 *  3. Llamamos a classifyArticles con DeepSeek (MODEL_FAST, temp 0.2).
 *  4. Creamos threads nuevos y resolvemos tempId → realId.
 *  5. Insertamos vínculos article_threads + marcamos "classified".
 *  6. Artículos ignore → marcamos "ignored".
 *  7. Pausa de 500ms entre lotes.
 *  8. Si un lote falla, console.error y CONTINUAMOS.
 *
 * SALVAGUARDA ANTI-BUCLE:
 *   Max iterations = ceil(pendingCount / BATCH_SIZE) + 5. Si se supera,
 *   abortamos con error claro. Así ningún bug puede causar bucle infinito
 *   llamando a la API de DeepSeek indefinidamente.
 */

export async function classifyUnassignedArticles(): Promise<{
  totalProcessed: number;
  totalClassified: number;
  threadsCreated: number;
  totalIgnored: number;
  batchesFailed: number;
}> {
  const pendingCount = (
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(articles)
      .where(eq(articles.classificationStatus, "pending"))
      .get()
  )?.count ?? 0;

  const estimatedBatches = Math.ceil(pendingCount / BATCH_SIZE);
  const MAX_ITERATIONS = estimatedBatches + 5;

  console.log(
    `\n📰 CLASIFICACIÓN INICIADA — ${pendingCount} artículos pendientes (~${estimatedBatches} lotes, máx ${MAX_ITERATIONS} iteraciones)\n`
  );

  let cumulativeProcessed = 0;
  let cumulativeClassified = 0;
  let cumulativeThreadsCreated = 0;
  let cumulativeIgnored = 0;
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
          `Posible bug: los artículos "pending" no están cambiando de estado. ` +
          `Revisa classify.ts y la lógica de UPDATE classificationStatus.\n`
      );
      break;
    }

    /*
     * Paso 1: Obtener el siguiente lote de artículos PENDING.
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
      .where(eq(articles.classificationStatus, "pending"))
      .limit(BATCH_SIZE)
      .all();

    if (batch.length === 0) {
      console.log("✅ No quedan artículos pendientes. Terminado.\n");
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
       * Paso 4a: Crear hilos nuevos propuestos.
       */
      const tempIdToRealId = new Map<string, number>();
      const now = new Date().toISOString();

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
        } else if (assignment.newThreadProposal) {
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
      cumulativeThreadsCreated += classification.proposedThreads.length;
      cumulativeIgnored += batchIgnored;

      console.log(
        `   ✅ Clasificados: ${batchClassified} | Ignorados: ${batchIgnored} | Hilos nuevos: ${classification.proposedThreads.length}`
      );
      console.log(
        `   📊 Acumulado — ${cumulativeClassified} clasificados, ${cumulativeThreadsCreated} hilos, ${cumulativeIgnored} ignorados`
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
    batchesFailed,
  };

  console.log(
    `🏁 CLASIFICACIÓN COMPLETADA — ${summary.totalClassified} artículos a ${summary.threadsCreated} hilos, ${summary.totalIgnored} ignorados, ${summary.batchesFailed} lotes fallidos\n`
  );

  return summary;
}
