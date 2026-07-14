import { db } from "./db/index";
import { threads, articles, sources, articleThreads, analyses } from "./db/schema";
import { eq, desc } from "drizzle-orm";
import { analyzeThread } from "./deepseek";
import type { AnalysisOutput } from "./deepseek";
import { getThreadPerspectiveCoverage } from "./threads";

/*
 * ============================================================================
 * AUDITORÍA ANTI-BUCLE INFINITO
 * ============================================================================
 *
 * Este analizador NO puede caer en un bucle infinito. A diferencia de la
 * clasificación (que usaba un while(true) re-consultando artículos "pending"),
 * aquí el diseño es inherentemente finito por tres razones:
 *
 * 1. ITERACIÓN SOBRE LISTA FIJA: cargamos TODOS los threads activos UNA sola
 *    vez al inicio (un array fijo). Iteramos con un `for` simple. No hay
 *    while que re-consulte la BD en cada vuelta. Si hay N hilos activos,
 *    el bucle ejecuta exactamente N iteraciones. Finito por construcción.
 *
 * 2. SIN COLAS REABASTECIBLES: no usamos un campo "pending" que deba cambiar
 *    de estado para salir de una cola. El filtro es estático: threads activos
 *    con >= 2 perspectivas. Que un hilo se analice no cambia este filtro
 *    (sigue activo, sigue teniendo >= 2 perspectivas). Si reapareciera en
 *    una segunda ejecución del endpoint, sería una nueva llamada, no un
 *    bucle dentro de la misma ejecución. Cada ejecución es autocontenida.
 *
 * 3. SALVAGUARDA DURA: MAX_THREADS_PER_RUN = 50. Si la lista de hilos a
 *    procesar supera este límite, la ejecución ABORTA con error antes de
 *    hacer cualquier llamada a DeepSeek. Esto protege contra bugs de filtro
 *    que pudieran inflar la lista (ej: si accidentalmente se seleccionaran
 *    todos los threads en vez de solo los activos).
 *
 * RESUMEN: El clasificador falló porque su condición de parada (IS NULL en
 * article_threads) nunca se cumplía para los artículos ignorados. El
 * analizador no tiene condición de parada dinámica: itera una lista fija
 * conocida de antemano. Es un `for`, no un `while`. No puede divergir.
 * ============================================================================
 */

const ARTICLES_PER_THREAD = 40;
const MAX_THREADS_PER_RUN = 50;

export async function analyzeAllThreads(): Promise<{
  totalActive: number;
  analyzed: number;
  skipped: number;
  failed: number;
  totalTimeMs: number;
}> {
  const started = Date.now();

  /*
   * Carga ÚNICA de todos los threads activos. Esta lista es FIJA: no se
   * vuelve a consultar durante la ejecución. Es la base de la garantía
   * anti-bucle.
   */
  const allActive = db
    .select({
      id: threads.id,
      title: threads.title,
      state: threads.state,
    })
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  if (allActive.length === 0) {
    console.log("📭 No hay hilos activos para analizar.");
    return { totalActive: 0, analyzed: 0, skipped: 0, failed: 0, totalTimeMs: 0 };
  }

  /*
   * Filtrar por triangulabilidad: solo hilos con >= 2 perspectivas.
   * Los hilos "cojos" (1 sola perspectiva) no se pueden triangular.
   */
  const eligible: Array<{ id: number; title: string; state: string | null; coverage: ReturnType<typeof getThreadPerspectiveCoverage> }> = [];

  for (const t of allActive) {
    const coverage = getThreadPerspectiveCoverage(t.id);
    if (coverage.isTriangulable) {
      eligible.push({ ...t, coverage });
    }
  }

  const skipped = allActive.length - eligible.length;

  /*
   * SALVAGUARDA DURA: si el filtro por algún bug devuelve demasiados hilos,
   * abortamos ANTES de hacer cualquier llamada a la API.
   */
  if (eligible.length > MAX_THREADS_PER_RUN) {
    throw new Error(
      `ABORTADO: ${eligible.length} hilos elegibles excede el máximo de ${MAX_THREADS_PER_RUN}. ` +
        `Revisa el filtro de perspectivas o aumenta MAX_THREADS_PER_RUN si es intencional.`
    );
  }

  console.log(
    `\n🔬 INICIANDO ANÁLISIS — ${eligible.length} hilos de ${allActive.length} activos (${skipped} saltados por <2 perspectivas)\n`
  );

  let analyzed = 0;
  let failed = 0;

  /*
   * for simple sobre lista fija. No hay while, no hay re-consulta a BD.
   * Cada iteración es independiente: si falla, continuamos con la siguiente.
   */
  for (let i = 0; i < eligible.length; i++) {
    const thread = eligible[i];
    const label = `[${i + 1}/${eligible.length}]`;

    console.log(
      `${label} Analizando "${thread.title}" — ${thread.coverage.perspectives.length} perspectivas, ${thread.coverage.totalArticles} artículos...`
    );

    const t0 = Date.now();

    try {
      /*
       * Cargar los artículos más recientes de este hilo.
       * JOIN: article_threads → articles → sources (para obtener bias).
       */
      const threadArticles = db
        .select({
          sourceName: sources.name,
          bias: sources.bias,
          title: articles.title,
          content: articles.content,
        })
        .from(articleThreads)
        .innerJoin(articles, eq(articleThreads.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(eq(articleThreads.threadId, thread.id))
        .orderBy(desc(articles.publishedAt))
        .limit(ARTICLES_PER_THREAD)
        .all();

      if (threadArticles.length === 0) {
        console.log(`${label} ⏭  Saltado — sin artículos vinculados.`);
        skipped;
        continue;
      }

      /*
       * Llamar al analista (Pro + thinking, MODEL_SMART).
       */
      const analysis: AnalysisOutput = await analyzeThread({
        threadTitle: thread.title,
        threadState: thread.state ?? null,
        articles: threadArticles,
      });

      const now = new Date().toISOString();

      /*
       * Guardar el análisis en la tabla analyses.
       */
      db.insert(analyses)
        .values({
          threadId: thread.id,
          summary: analysis.summary,
          cuiBono: analysis.cuiBono,
          saidVsDone: analysis.saidVsDone,
          deviation: analysis.deviation,
          prediction: analysis.prediction,
          verdict: analysis.verdict,
          analysisDate: now,
          createdAt: now,
        })
        .run();

      /*
       * Actualizar el state del hilo (la memoria acumulada) y updatedAt.
       */
      db.update(threads)
        .set({
          state: analysis.newState,
          updatedAt: now,
        })
        .where(eq(threads.id, thread.id))
        .run();

      const elapsed = Date.now() - t0;
      analyzed++;

      console.log(`${label} ✅ Completado en ${(elapsed / 1000).toFixed(1)}s`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${label} ❌ FALLÓ: ${message}`);
      console.error(`${label}    Continuando con el siguiente hilo...`);
    }
  }

  const totalTimeMs = Date.now() - started;

  const summary = {
    totalActive: allActive.length,
    analyzed,
    skipped,
    failed,
    totalTimeMs,
  };

  console.log(
    `\n🏁 ANÁLISIS COMPLETADO — ${summary.analyzed} hilos analizados, ${summary.skipped} saltados, ${summary.failed} fallidos — ${(totalTimeMs / 1000).toFixed(1)}s total\n`
  );

  return summary;
}
