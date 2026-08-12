import { db } from "./db/index";
import { threads, articles, sources, articleThreads, analyses } from "./db/schema";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import { analyzeThread } from "./deepseek";
import type { AnalysisOutput } from "./deepseek";
import { getThreadPerspectiveCoverage } from "./threads";
import { extractTextsForArticles, getFullTextForArticles } from "./extract";

/*
 * hasForeignLanguageContamination — Detecta si una respuesta del analista
 * se contaminó con el idioma de las fuentes (chino, japonés, coreano,
 * cirílico) en proporción significativa.
 *
 * El modelo a veces responde en el idioma del contenido cuando hay mucho
 * texto en chino/ruso en el contexto. Comprobamos si los campos de texto
 * contienen rangos Unicode CJK (U+4E00–U+9FFF, U+3400–U+4DBF) o cirílico
 * (U+0400–U+04FF) en proporción > ~8% de los caracteres — si lo supera,
 * la respuesta no es español y debe descartarse/reintentarse.
 */
function hasForeignLanguageContamination(analysis: AnalysisOutput): boolean {
  const textFields = [
    analysis.summary,
    analysis.cuiBono,
    analysis.saidVsDone,
    analysis.deviation ?? "",
    analysis.prediction ?? "",
    analysis.verdict,
    analysis.newState,
  ];

  const allText = textFields.join(" ");
  if (allText.length < 50) return false;

  let foreign = 0;
  for (const ch of allText) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    // CJK unificado (chino/japonés/coreano)
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      foreign++;
      continue;
    }
    // Cirílico (ruso, búlgaro, etc.)
    if (code >= 0x0400 && code <= 0x04ff) {
      foreign++;
    }
  }

  return foreign / allText.length > 0.08;
}

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
  // Desglose del abogado del diablo (para medir si el refutador es útil)
  let redTeamSostiene = 0;
  let redTeamDebilita = 0;
  let redTeamRefuta = 0;
  // Predicciones que pasaron por refutación vs. saltadas (corroboradas)
  let redTeamEvaluated = 0;
  let redTeamSkipped = 0;
  let redTeamSkipBySource = 0;
  let redTeamSkipByPerspectives = 0;
  let redTeamSkipByInertia = 0;

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
          id: articles.id,
          sourceName: sources.name,
          bias: sources.bias,
          title: articles.title,
          content: articles.content,
          resolvedUrl: articles.resolvedUrl,
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

      /*
       * SCRAPING QUIRÚRGICO (solo artículos críticos):
       *   - Hilo con state previo: ampliamos los 2 artículos nuevos más recientes.
       *   - Hilo SIN state (primer análisis): ampliamos máximo 3 (puede haber
       *     25 nuevos; ampliar todos dispararía el input).
       *   El resto entra con titular+snippet como antes.
       */
      const MAX_FULL_TEXT = isFirstAnalysis ? 3 : 2;
      const criticalTargets = threadArticles
        .filter((a) => a.resolvedUrl)
        .slice(0, MAX_FULL_TEXT)
        .map((a) => ({ id: a.id, resolvedUrl: a.resolvedUrl }));

      const { expanded, extraChars } = await extractTextsForArticles(criticalTargets);
      const fullTexts = getFullTextForArticles(criticalTargets.map((t) => t.id));

      /*
       * Construir el input del analista:
       *   - Los que tienen fullText van como TEXTO COMPLETO (hasFullText).
       *   - Los demás como TITULAR Y RESUMEN (snippet).
       */
      const analystArticles = threadArticles.map((a) => {
        const ft = fullTexts.get(a.id);
        return {
          sourceName: a.sourceName,
          bias: a.bias,
          title: a.title,
          content: ft ?? a.content,
          hasFullText: !!ft,
        };
      });

      const stateLabel = !isFirstAnalysis ? "+ state" : "sin state previo";
      console.log(
        `${label} Enviando al analista: ${threadArticles.length} artículos nuevos ${stateLabel} (${expanded} con texto completo, +${extraChars.toLocaleString()} caracteres)`
      );

      /*
       * Llamar al analista (Pro + thinking, MODEL_SMART) con DEGRADACIÓN.
       *
       * Escalera de reintentos (máximo 2 llamadas extra):
       *   1. Intento completo (fullText donde haya).
       *   2. Si JSON inválido O idioma incorrecto → reintento SIN texto
       *      completo (solo titulares + snippet + state). El texto scrapeado
       *      de TASS/RT puede contaminar la respuesta; quitarlo a menudo lo
       *      arregla. Mejor un análisis sin profundidad que ninguno.
       *   3. (El idioma ya se maneja con buildUserPromptRetry en el intento 2.)
       */
      let analysis: AnalysisOutput | null = null;

      // artículos degradados: sin fullText, solo snippet (más corto)
      const degradedArticles = analystArticles.map((a) => ({
        sourceName: a.sourceName,
        bias: a.bias,
        title: a.title,
        content: a.content,
        hasFullText: false, // aunque haya fullText, no lo enviamos en degradado
      }));

      // Intento 1: completo
      try {
        analysis = await analyzeThread({
          threadTitle: thread.title,
          threadState: thread.state ?? null,
          articles: analystArticles,
        });

        if (hasForeignLanguageContamination(analysis)) {
          console.log(`⚠️ ${label} RESPUESTA EN IDIOMA INCORRECTO — reintentando en modo degradado...`);
          analysis = await analyzeThread(
            {
              threadTitle: thread.title,
              threadState: thread.state ?? null,
              articles: degradedArticles,
            },
            { retry: true }
          );
          if (analysis && hasForeignLanguageContamination(analysis)) {
            console.log(`❌ ${label} El reintento SIGUE en idioma incorrecto. Descartando (sin guardar).`);
            throw new Error("Respuesta en idioma incorrecto tras reintento — análisis descartado");
          }
        }
      } catch (err) {
        // JSON inválido u otro fallo → DEGRADADO: sin fullText, una sola vez
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`⚠️ ${label} Fallo en intento completo ("${msg.slice(0, 80)}") — reintentando en modo degradado (sin texto completo)...`);
        try {
          analysis = await analyzeThread({
            threadTitle: thread.title,
            threadState: thread.state ?? null,
            articles: degradedArticles,
          });
          if (analysis && hasForeignLanguageContamination(analysis)) {
            console.log(`❌ ${label} Degradado en idioma incorrecto. Descartando.`);
            throw new Error("Análisis degradado en idioma incorrecto — descartado");
          }
        } catch (degradedErr) {
          const dMsg = degradedErr instanceof Error ? degradedErr.message : String(degradedErr);
          console.error(`❌ ${label} El reintento degradado TAMBIÉN falló: ${dMsg}`);
          throw degradedErr;
        }
      }

      if (!analysis) {
        throw new Error("Análisis nulo — descartado");
      }

      const now = new Date().toISOString();

      /*
       * Guardar el análisis en la tabla analyses.
       */
      const insertedAnalysis = db
        .insert(analyses)
        .values({
          threadId: thread.id,
          summary: analysis.summary,
          cuiBono: analysis.cuiBono,
          saidVsDone: analysis.saidVsDone,
          deviation: analysis.deviation,
          prediction: analysis.prediction,
          predictionStatement: analysis.predictionStatement ?? null,
          predictionCondition: analysis.predictionCondition ?? null,
          predictionFalsification: analysis.predictionFalsification ?? null,
          predictionReviewDate: analysis.predictionReviewDate ?? null,
          verdict: analysis.verdict,
          analysisDate: now,
          createdAt: now,
        })
        .returning({ id: analyses.id })
        .get();

      /*
       * CONTRA-DEBATE ANTES DE PREDECIR (PASO 2 y 3):
       *   - verifyPredictionFacts: corrobora las afirmaciones en la BD.
       *   - runRedTeam: el abogado del diablo intenta destruir la predicción.
       * Resolución:
       *   - 'sostiene' → se registra tal cual, confidence alta.
       *   - 'debilita' → se registra la versión revisada, confidence media.
       *   - 'refuta'   → NO se registra predicción (mejor ninguna que mala).
       * Los campos rebuttal/alternativeHypothesis/verdict se guardan en analyses.
       */
      let predictionToRegister: {
        statement: string;
        condition: string | null;
        falsification: string | null;
        reviewDate: string | null;
        confidence: "alta" | "media" | "baja";
        rebuttal: string;
      } | null = null;

      if (insertedAnalysis && analysis.predictionStatement) {
        try {
          const { verifyPredictionFacts, getContextThreadIds } = await import("./verify");
          const { runRedTeam } = await import("./redteam");

          const contextThreadIds = getContextThreadIds(thread.id);
          const verification = verifyPredictionFacts({
            statement: analysis.predictionStatement,
            summary: analysis.summary,
            threadId: thread.id,
            contextThreadIds,
          });

          /*
           * FILTRO CONDICIONAL del red-team:
           * Solo se ejecuta si la predicción es RIESGOSA:
           *   1. El hecho que la sustenta aparece en 1 sola perspectiva
           *      (según verify.ts) → fuente única sin corroborar.
           *   2. El teatro tiene menos de 3 perspectivas distintas.
           *   3. La predicción va contra la inercia (againstInertia).
           * Si NINGUNA se cumple (corroborada por 3+ perspectivas y
           * continuista), se salta el red-team y se registra con confidence
           * alta directamente.
           */
          const theaterPerspectives = thread.coverage.perspectives.length;
          const singleSource = verification.isSingleSource;
          const againstInertia = analysis.againstInertia === true;
          const shouldRedTeam = singleSource || theaterPerspectives < 3 || againstInertia;

          if (!shouldRedTeam) {
            redTeamSkipped++;
            // registrar directamente con confidence alta, sin refutación
            predictionToRegister = {
              statement: analysis.predictionStatement,
              condition: analysis.predictionCondition ?? null,
              falsification: analysis.predictionFalsification ?? null,
              reviewDate: analysis.predictionReviewDate ?? null,
              confidence: "alta",
              rebuttal: "",
            };
            console.log(`      ✓ Predicción corroborada (${theaterPerspectives} perspectivas, continuista) — red-team saltado.`);
          } else {
            redTeamEvaluated++;
            const reasons: string[] = [];
            if (singleSource) { redTeamSkipBySource++; reasons.push("fuente única"); }
            if (theaterPerspectives < 3) { redTeamSkipByPerspectives++; reasons.push("<3 perspectivas"); }
            if (againstInertia) { redTeamSkipByInertia++; reasons.push("contra inercia"); }
            console.log(`      ⚖️ Red-team disparado (${reasons.join(", ")})`);

            const redTeam = await runRedTeam({
              statement: analysis.predictionStatement,
              reasoning: `${analysis.summary}\n\nCui bono: ${analysis.cuiBono}\nVeredicto: ${analysis.verdict}`,
              verification: verification.total,
              context: `${thread.state ?? "(sin state)"}\nTeatros conectados: ${contextThreadIds.join(", ") || "ninguno"}`,
            });

            // Guardar el contra-argumento en el análisis
            db.update(analyses)
              .set({
                rebuttal: redTeam.rebuttal,
                alternativeHypothesis: redTeam.alternativeHypothesis,
                rebuttalVerdict: redTeam.verdict,
              })
              .where(eq(analyses.id, insertedAnalysis.id))
              .run();

            console.log(`      ⚖️ Red-team "${thread.title}": ${redTeam.verdict}`);

            if (redTeam.verdict === "sostiene") {
              redTeamSostiene++;
              predictionToRegister = {
                statement: analysis.predictionStatement,
                condition: analysis.predictionCondition ?? null,
                falsification: analysis.predictionFalsification ?? null,
                reviewDate: analysis.predictionReviewDate ?? null,
                confidence: "alta",
                rebuttal: redTeam.rebuttal,
              };
            } else if (redTeam.verdict === "debilita") {
              redTeamDebilita++;
              const revised = redTeam.suggestedRevision?.trim();
              predictionToRegister = {
                statement: revised || analysis.predictionStatement,
                condition: analysis.predictionCondition ?? null,
                falsification: analysis.predictionFalsification ?? null,
                reviewDate: analysis.predictionReviewDate ?? null,
                confidence: "media",
                rebuttal: redTeam.rebuttal,
              };
            } else {
              redTeamRefuta++;
              console.log(`      🚫 Predicción REFUTADA para "${thread.title}" — no se registra.`);
              predictionToRegister = null;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`      ⚠️ Contra-debate falló ("${msg}") — registrando predicción sin red-team.`);
          predictionToRegister = {
            statement: analysis.predictionStatement,
            condition: analysis.predictionCondition ?? null,
            falsification: analysis.predictionFalsification ?? null,
            reviewDate: analysis.predictionReviewDate ?? null,
            confidence: "media",
            rebuttal: "",
          };
        }
      }

      if (insertedAnalysis && predictionToRegister) {
        const { registerPredictionFromAnalysis } = await import("./predictions");
        registerPredictionFromAnalysis({
          analysisId: insertedAnalysis.id,
          threadId: thread.id,
          statement: predictionToRegister.statement,
          condition: predictionToRegister.condition,
          falsification: predictionToRegister.falsification,
          reviewDate: predictionToRegister.reviewDate,
          createdAt: now,
          confidence: predictionToRegister.confidence,
          rebuttal: predictionToRegister.rebuttal || null,
        });
      }

      /*
       * Actualizar el state del hilo (la memoria acumulada), las entidades
       * del teatro (countries/actors/domains como JSON) y el nivel de
       * tensión. Todo se sobrescribe en cada análisis, igual que el state.
       */
      db.update(threads)
        .set({
          state: analysis.newState,
          updatedAt: now,
          countries: JSON.stringify(analysis.countries ?? []),
          actors: JSON.stringify(analysis.actors ?? []),
          domains: JSON.stringify(analysis.domains ?? []),
          tensionLevel: analysis.tensionLevel ?? null,
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
    redTeam: { sostiene: redTeamSostiene, debilita: redTeamDebilita, refuta: redTeamRefuta },
    redTeamFilter: { evaluated: redTeamEvaluated, skipped: redTeamSkipped },
  };

  console.log(
    `\n🏁 ANÁLISIS COMPLETADO — ${summary.analyzed} hilos analizados, ${summary.skipped} saltados, ${summary.failed} fallidos — ${(totalTimeMs / 1000).toFixed(1)}s total`
  );
  if (redTeamEvaluated + redTeamSkipped > 0) {
    console.log(
      `⚖️  CONTRA-DEBATE — ${redTeamEvaluated} evaluados (${redTeamSkipBySource} por fuente única, ${redTeamSkipByPerspectives} por <3 perspectivas, ${redTeamSkipByInertia} contra inercia), ${redTeamSkipped} saltados (corroborados) — ${redTeamSostiene} sostienen, ${redTeamDebilita} debilitan, ${redTeamRefuta} refutan`
    );
  }
  console.log();

  return summary;
}
