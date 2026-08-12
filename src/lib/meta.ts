import { db } from "./db/index";
import { threads, analyses, metaAnalyses } from "./db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getThreadPerspectiveCoverage } from "./threads";
import { runMetaAnalysisLLM } from "./deepseek";
import { getThreadLinks } from "./links";

/*
 * ============================================================================
 * META-ANÁLISIS — Lectura del tablero GLOBAL.
 * ============================================================================
 *
 * runMetaAnalysis():
 *   1. Selecciona los ~20 teatros más relevantes de los últimos 7 días:
 *      los que tienen análisis reciente, ordenados por
 *      (perspectivas × 2) + (tensionLevel × 3) + (desviación ? 5 : 0).
 *   2. Construye el input con título, state, verdict, entidades y tensión,
 *      más los thread_links detectados entre ellos.
 *   3. Llama a MODEL_SMART con META_PROMPT (lectura del conjunto).
 *   4. Guarda en meta_analyses.
 */

const TOP_N = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseEntities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function hasActiveDeviation(deviation: string | null): boolean {
  if (!deviation) return false;
  const d = deviation.toLowerCase();
  return !(
    d.includes("no aplica") ||
    d.includes("primer análisis") ||
    d.includes("sin desviaciones") ||
    d.includes("no hay desviación")
  );
}

export async function runMetaAnalysis(): Promise<{
  topCount: number;
  linksCount: number;
  metaId: number | null;
}> {
  const cutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();

  /*
   * PASO 1: Teatros activos con análisis en los últimos 7 días.
   */
  const activeThreads = db.select().from(threads).where(eq(threads.active, true)).all();

  const scored: Array<{
    id: number;
    title: string;
    state: string | null;
    verdict: string | null;
    countries: string[];
    actors: string[];
    domains: string[];
    tensionLevel: number | null;
    score: number;
  }> = [];

  for (const t of activeThreads) {
    const latest = db
      .select()
      .from(analyses)
      .where(eq(analyses.threadId, t.id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();

    if (!latest || latest.analysisDate < cutoff) continue;

    const cov = getThreadPerspectiveCoverage(t.id);
    const deviationBonus = hasActiveDeviation(latest.deviation) ? 5 : 0;
    const score = cov.perspectives.length * 2 + (t.tensionLevel ?? 0) * 3 + deviationBonus;

    scored.push({
      id: t.id,
      title: t.title,
      state: t.state,
      verdict: latest.verdict,
      countries: parseEntities(t.countries),
      actors: parseEntities(t.actors),
      domains: parseEntities(t.domains),
      tensionLevel: t.tensionLevel,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TOP_N);

  console.log(`\n🌐 META-ANÁLISIS — ${top.length} teatros relevantes (de ${activeThreads.length} activos), últimos 7 días\n`);

  if (top.length === 0) {
    console.log("   Sin teatros con análisis reciente — no hay meta-análisis que producir.");
    return { topCount: 0, linksCount: 0, metaId: null };
  }

  /*
   * PASO 2: links entre los teatros del top.
   */
  const ids = top.map((t) => t.id);
  const links = getThreadLinks(ids);
  console.log(`   ${links.length} conexiones entre los teatros del top`);

  /*
   * PASO 3: llamada al modelo (MODEL_SMART + META_PROMPT).
   */
  const result = await runMetaAnalysisLLM({
    threads: top.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      verdict: t.verdict,
      countries: t.countries,
      actors: t.actors,
      domains: t.domains,
      tensionLevel: t.tensionLevel,
    })),
    links,
  });

  /*
   * PASO 4: guardar.
   */
  const now = new Date().toISOString();
  const inserted = db
    .insert(metaAnalyses)
    .values({
      periodStart: cutoff,
      periodEnd: now,
      systemReading: result.systemReading,
      blocFormation: result.blocFormation,
      crossPatterns: result.crossPatterns,
      contradictions: result.contradictions,
      predictionStatement: result.predictionStatement,
      predictionCondition: result.predictionCondition,
      predictionFalsification: result.predictionFalsification,
      predictionReviewDate: result.predictionReviewDate,
      verdict: result.verdict,
      threadIds: JSON.stringify(ids),
      createdAt: now,
    })
    .returning({ id: metaAnalyses.id })
    .get();

  if (!result.predictionReviewDate) {
    console.log("   ⚠️ predictionReviewDate null — la predicción no tiene fecha de revisión válida (no verificable).");
  }

  /*
   * Registrar la predicción sistémica en `predictions`.
   * En el META-ANÁLISIS el red-team se ejecuta SIEMPRE (sin filtro condicional):
   * las predicciones sistémicas son de alto impacto y merecen refutación.
   */
  try {
    const { runRedTeam } = await import("./redteam");
    const { registerPredictionFromMeta } = await import("./predictions");

    let confidence: "alta" | "media" | "baja" = "media";
    let rebuttal: string | null = null;
    let statementToRegister = result.predictionStatement;

    try {
      const redTeam = await runRedTeam({
        statement: result.predictionStatement,
        reasoning: `${result.systemReading}\n\nVeredicto: ${result.verdict}`,
        verification: "Predicción sistémica sobre el conjunto de teatros — verificación global (siempre sometida a refutación).",
        context: `Período: ${cutoff} a ${now}\nTeatros del meta-análisis: ${ids.join(", ")}`,
      });

      if (redTeam.verdict === "sostiene") {
        confidence = "alta";
        rebuttal = redTeam.rebuttal;
      } else if (redTeam.verdict === "debilita") {
        confidence = "media";
        rebuttal = redTeam.rebuttal;
        if (redTeam.suggestedRevision?.trim()) {
          statementToRegister = redTeam.suggestedRevision.trim();
        }
      } else {
        // refuta: no registramos predicción sistémica
        console.log("   🚫 Predicción sistémica REFUTADA — no se registra.");
        statementToRegister = "";
      }
      console.log(`   ⚖️ Red-team (meta): ${redTeam.verdict}`);
    } catch (err) {
      console.log(`   ⚠️ Red-team (meta) falló: ${err}`);
    }

    if (statementToRegister) {
      registerPredictionFromMeta({
        metaId: inserted.id,
        threadIds: ids,
        statement: statementToRegister,
        condition: result.predictionCondition,
        falsification: result.predictionFalsification,
        reviewDate: result.predictionReviewDate,
        createdAt: now,
        confidence,
        rebuttal,
      });
    }
  } catch (err) {
    console.error("   ⚠️ No se pudo registrar la predicción sistémica:", err);
  }

  console.log(`\n✅ META-ANÁLISIS COMPLETADO — id ${inserted.id}`);
  console.log(`   Veredicto: ${result.verdict.slice(0, 120)}`);

  return { topCount: top.length, linksCount: links.length, metaId: inserted.id };
}
