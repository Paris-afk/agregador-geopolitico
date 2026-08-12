import { db } from "./db/index";
import { threads, articles, analyses, articleThreads } from "./db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getThreadPerspectiveCoverage } from "./threads";

/*
 * ============================================================================
 * PODA DEL MAPA DE TEATROS
 * ============================================================================
 *
 * Un "teatro estratégico" con 1-2 artículos y ningún análisis no es un teatro:
 * es una noticia suelta. El job semanal crea threads por temas recurrentes,
 * pero muchos nunca acumulan masa crítica y ensucian el mapa.
 *
 * CRITERIOS DE DESACTIVACIÓN (active=false, NUNCA borrar — reversible):
 *   1. < 3 artículos Y creado hace > 7 días  (no logró acumular material).
 *   2. 1 sola perspectiva (bias) Y > 7 días   (sin triangulación posible).
 *   3. Sin artículos nuevos en los últimos 21 días (teatro muerto).
 *   4. Sin ningún análisis Y creado hace > 14 días.
 *
 * NUNCA se desactivan:
 *   - origin = "manual" (creados a mano deliberadamente).
 *   - Desviación activa detectada (señal de alto valor).
 *   - tensionLevel >= 4 (conflicto activo).
 *
 * MODO DRY-RUN OBLIGATORIO: por defecto dryRun=true, no modifica nada, solo
 * lista qué desactivaría y por qué criterio. Con dryRun=false aplica.
 */

export type PruneReason =
  | "menos de 3 artículos (>7 días)"
  | "1 sola perspectiva (>7 días)"
  | "sin artículos en 21 días"
  | "sin análisis (>14 días)";

export type PruneCandidate = {
  id: number;
  title: string;
  articleCount: number;
  perspectives: number;
  daysSinceLastArticle: number | null;
  analysisCount: number;
  createdAt: string;
  reason: PruneReason;
};

export type PruneResult = {
  dryRun: boolean;
  candidates: PruneCandidate[];
  byReason: Record<PruneReason, number>;
  protectedCount: number;
  remainingActive: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
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

/*
 * pruneThreads — Evalúa todos los threads activos contra los criterios de
 * poda. En dry-run no modifica nada. En modo aplicar, pone active=false a
 * los candidatos (nunca borra).
 */
export function pruneThreads(opts?: { dryRun?: boolean }): PruneResult {
  const dryRun = opts?.dryRun ?? true;

  const allActive = db.select().from(threads).where(eq(threads.active, true)).all();

  const candidates: PruneCandidate[] = [];
  const byReason: Record<PruneReason, number> = {
    "menos de 3 artículos (>7 días)": 0,
    "1 sola perspectiva (>7 días)": 0,
    "sin artículos en 21 días": 0,
    "sin análisis (>14 días)": 0,
  };
  let protectedCount = 0;

  for (const t of allActive) {
    /*
     * PROTEGIDOS: manual, tensión alta, desviación activa.
     */
    if (t.origin === "manual") {
      protectedCount++;
      continue;
    }
    if ((t.tensionLevel ?? 0) >= 4) {
      protectedCount++;
      continue;
    }

    const coverage = getThreadPerspectiveCoverage(t.id);

    /*
     * Último artículo del thread (más reciente por fetchedAt).
     */
    const lastArticle = db
      .select({ fetchedAt: articles.fetchedAt })
      .from(articleThreads)
      .innerJoin(articles, eq(articleThreads.articleId, articles.id))
      .where(eq(articleThreads.threadId, t.id))
      .orderBy(desc(articles.fetchedAt))
      .limit(1)
      .get();

    /*
     * Nº de análisis del thread.
     */
    const analysisCount =
      db
        .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(analyses)
        .where(eq(analyses.threadId, t.id))
        .get()?.count ?? 0;

    /*
     * Desviación activa en el último análisis (señal de alto valor).
     */
    const latestAnalysis = db
      .select({ deviation: analyses.deviation })
      .from(analyses)
      .where(eq(analyses.threadId, t.id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();

    if (latestAnalysis && hasActiveDeviation(latestAnalysis.deviation)) {
      protectedCount++;
      continue;
    }

    const createdDays = daysAgo(t.createdAt) ?? 0;
    const lastArticleDays = daysAgo(lastArticle?.fetchedAt ?? null);

    let reason: PruneReason | null = null;

    // Criterio 1: <3 artículos y >7 días
    if (coverage.totalArticles < 3 && createdDays > 7) {
      reason = "menos de 3 artículos (>7 días)";
    }
    // Criterio 2: 1 perspectiva y >7 días
    else if (coverage.perspectives.length === 1 && createdDays > 7) {
      reason = "1 sola perspectiva (>7 días)";
    }
    // Criterio 3: sin artículos nuevos en 21 días
    else if (lastArticleDays !== null && lastArticleDays > 21) {
      reason = "sin artículos en 21 días";
    }
    // Criterio 4: sin análisis y >14 días
    else if (analysisCount === 0 && createdDays > 14) {
      reason = "sin análisis (>14 días)";
    }

    if (reason) {
      candidates.push({
        id: t.id,
        title: t.title,
        articleCount: coverage.totalArticles,
        perspectives: coverage.perspectives.length,
        daysSinceLastArticle: lastArticleDays,
        analysisCount,
        createdAt: t.createdAt,
        reason,
      });
      byReason[reason]++;

      // En modo aplicar: desactivar (reversible, nunca borrar)
      if (!dryRun) {
        db.update(threads)
          .set({ active: false, updatedAt: new Date().toISOString() })
          .where(eq(threads.id, t.id))
          .run();
      }
    }
  }

  return {
    dryRun,
    candidates,
    byReason,
    protectedCount,
    remainingActive: allActive.length - candidates.length,
  };
}
