import { db } from "./db/index";
import { threads, articles, sources, articleThreads, analyses } from "./db/schema";
import { eq, desc, sql } from "drizzle-orm";
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

/*
 * analyzeAllThreads — Analiza hilos activos con >=2 perspectivas.
 *
 * Parámetro onlyWithRecentArticles:
 *   - false (default): analiza TODOS los hilos triangulables. Útil para
 *     forzar un re-análisis manual completo desde la API.
 *   - true: solo analiza hilos que tienen al menos UN artículo con fetchedAt
 *     en las últimas 24 horas. Los hilos sin artículos recientes se saltan:
 *     su state ya refleja todo lo conocido, y re-analizarlos produciría
 *     prácticamente el mismo resultado gastando tokens de Pro+thinking.
 *     El filtro de 24h usa fetchedAt (cuándo lo capturamos), no publishedAt
 *     (cuándo se publicó), porque fetchedAt es lo que avanza con cada job
 *     diario: un artículo capturado hoy es "nuevo para el sistema",
 *     independientemente de su fecha de publicación original.
 */
export async function analyzeAllThreads(opts?: {
  onlyWithRecentArticles?: boolean;
}): Promise<{
  totalActive: number;
  analyzed: number;
  skipped: number;
  failed: number;
  totalTimeMs: number;
}> {
  const onlyWithRecentArticles = opts?.onlyWithRecentArticles ?? false;
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

  const skippedByPerspectives = allActive.length - eligible.length;

  /*
   * Filtro opcional: solo hilos con artículos recientes (últimas 24h).
   *
   * Por qué este filtro es correcto:
   *   Un hilo sin artículos nuevos en 24h no tiene novedades que integrar
   *   en su state. Re-analizarlo produciría un análisis casi idéntico al
   *   anterior: el mismo state de entrada, los mismos 40 artículos más
   *   recientes (que no cambiaron), el mismo veredicto. Gastar una llamada
   *   a Pro+thinking en eso es desperdiciar tokens sin ganar señal nueva.
   *   Si un operador quiere forzar re-análisis completo, usa la API
   *   (POST /api/analyze) que llama con onlyWithRecentArticles=false.
   */
  let skippedByNoRecentArticles = 0;

  if (onlyWithRecentArticles) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const filtered: typeof eligible = [];

    for (const t of eligible) {
      const hasRecent = (
        db
          .select({ count: sql<number>`COUNT(*)` })
          .from(articleThreads)
          .innerJoin(articles, eq(articleThreads.articleId, articles.id))
          .where(
            sql`${eq(articleThreads.threadId, t.id)} AND ${articles.fetchedAt} >= ${cutoff}`
          )
          .get()
      )?.count ?? 0;

      if (hasRecent > 0) {
        filtered.push(t);
      }
    }

    skippedByNoRecentArticles = eligible.length - filtered.length;
    eligible.length = 0;
    eligible.push(...filtered);
  }

  const totalSkipped = skippedByPerspectives + skippedByNoRecentArticles;

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
    `\n🔬 INICIANDO ANÁLISIS — ${eligible.length} hilos a analizar de ${allActive.length} activos ` +
    `(${skippedByPerspectives} sin cobertura, ${skippedByNoRecentArticles} sin artículos recientes)\n`
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
       * Cargar SOLO los artículos NUEVOS desde el último análisis.
       *
       * Optimización de tokens: los artículos históricos ya están resumidos
       * en thread.state (la memoria acumulada). Enviarlos de nuevo a
       * Pro+thinking sería redundante y costoso. Solo enviamos:
       *   - Los artículos con fetchedAt posterior al último análisis.
       *   - El state actual (que resume todo lo anterior).
       *
       * Reducción estimada: un hilo típico acumula ~40-200 artículos.
       * En cada análisis diario, solo ~3-8 son nuevos (los del día).
       * Esto reduce el input de 40 artículos (~15-25K tokens) a ~3-8
       * artículos (~4-10K tokens) + state (~500-1000 tokens). Es una
       * reducción de ~50-70% en tokens de entrada para análisis diarios.
       *
       * Caso especial — PRIMER ANÁLISIS (state es null):
       *   Sin memoria previa, no tenemos resumen del contexto histórico.
       *   Enviamos todos los artículos disponibles (hasta el límite ~40)
       *   para que el analista pueda construir el state inicial desde cero.
       *   Este caso solo ocurre UNA vez por hilo (cuando se crea), así que
       *   el costo es aceptable.
       *
       * Caso sin análisis previo pero con state (raro, ej. state manual):
       *   Usamos últimas 48h como ventana conservadora.
       */

      /*
       * Fecha del último análisis para este hilo (si existe).
       */
      const lastAnalysis = db
        .select({ analysisDate: analyses.analysisDate })
        .from(analyses)
        .where(eq(analyses.threadId, thread.id))
        .orderBy(desc(analyses.analysisDate))
        .limit(1)
        .get();

      const isFirstAnalysis = !lastAnalysis;

      /*
       * Construir la query con filtro temporal si hay análisis previo.
       * Si es primer análisis → carga todos los artículos del hilo (sin
       * filtro de fecha, porque no hay state que resuma el contexto previo).
       * Si ya fue analizado → solo artículos con fetchedAt > lastAnalysisDate
       * (los nuevos desde entonces; el state ya resume los anteriores).
       */
      const articleFilter = isFirstAnalysis
        ? sql`${eq(articleThreads.threadId, thread.id)}`
        : sql`${eq(articleThreads.threadId, thread.id)} AND ${articles.fetchedAt} > ${lastAnalysis.analysisDate}`;

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
        .where(articleFilter)
        .orderBy(desc(articles.publishedAt))
        .limit(ARTICLES_PER_THREAD)
        .all();

      if (threadArticles.length === 0) {
        console.log(`${label} ⏭  Saltado — sin artículos nuevos desde el último análisis.`);
        continue;
      }

      const stateLabel = !isFirstAnalysis ? "+ state" : "sin state previo";
      console.log(
        `${label} Enviando al analista: ${threadArticles.length} artículos nuevos ${stateLabel}`
      );

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
    skipped: totalSkipped,
    failed,
    totalTimeMs,
  };

  console.log(
    `\n🏁 ANÁLISIS COMPLETADO — ${summary.analyzed} hilos analizados, ${summary.skipped} saltados, ${summary.failed} fallidos — ${(totalTimeMs / 1000).toFixed(1)}s total\n`
  );

  return summary;
}
