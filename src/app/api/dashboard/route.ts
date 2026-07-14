import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, analyses, articles, articleThreads } from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getThreadPerspectiveCoverage } from "@/lib/threads";

/*
 * GET /api/dashboard
 *
 * Devuelve los datos para la portada del boletín geopolítico.
 * NO llama a DeepSeek — solo LEE de la BD.
 *
 * Por cada thread activo que tenga al menos un análisis, calculamos:
 *
 * SCORE DE RELEVANCIA (los "calientes" primero):
 *   score = (newArticlesToday × 3)  — actividad reciente es la señal más fuerte
 *         + (perspectivas × 2)      — más perspectivas = mejor triangulación
 *         + (hasDeviation ? 10 : 0) — desviación es señal de inteligencia premium
 *         + (!read ? 5 : 0)         — no leído merece atención
 *
 * La fórmula prioriza lo ACCIONABLE: una desviación detectada (un actor
 * rompiendo su patrón) es la señal más valiosa y recibe el mayor peso (10).
 * Los artículos nuevos hoy son el segundo factor (3×), porque indican que
 * el teatro está activo AHORA. Las perspectivas (2×) premian la calidad de
 * la cobertura. No leído (5) asegura que lo pendiente suba en el ranking.
 */

function scoreRow(item: DashboardRow): number {
  const dev = hasDeviation(item.latestAnalysis.deviation);
  const unread = !item.latestAnalysis.read;
  return (
    item.newArticlesToday * 3 +
    item.perspectiveCoverage.perspectives.length * 2 +
    (dev ? 10 : 0) +
    (unread ? 5 : 0)
  );
}

function hasDeviation(deviation: string | null): boolean {
  if (!deviation) return false;
  const d = deviation.toLowerCase();
  return !(
    d.includes("no aplica") ||
    d.includes("primer análisis") ||
    d.includes("sin desviaciones") ||
    d.includes("no hay desviación")
  );
}

type DashboardRow = {
  thread: { id: number; title: string; description: string | null; state: string | null };
  latestAnalysis: typeof analyses.$inferSelect;
  perspectiveCoverage: ReturnType<typeof getThreadPerspectiveCoverage>;
  newArticlesToday: number;
};

export async function GET() {
  /*
   * Cargar todos los threads activos.
   */
  const allThreads = db
    .select()
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  if (allThreads.length === 0) {
    return NextResponse.json({ rows: [], unreadCount: 0 });
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);

  const rows: DashboardRow[] = [];

  for (const thread of allThreads) {
    /*
     * Último análisis del thread (más reciente por analysisDate).
     */
    const latest = db
      .select()
      .from(analyses)
      .where(eq(analyses.threadId, thread.id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();

    if (!latest) continue;

    const coverage = getThreadPerspectiveCoverage(thread.id);

    /*
     * Artículos publicados hoy para este thread.
     * publishedAt es ISO 8601, así que LIKE 'YYYY-MM-DD%' captura el día.
     */
    const todayCount = db
      .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(articleThreads)
      .innerJoin(articles, eq(articleThreads.articleId, articles.id))
      .where(
        sql`${eq(articleThreads.threadId, thread.id)} AND ${articles.publishedAt} LIKE ${todayPrefix + "%"}`
      )
      .get()?.count ?? 0;

    rows.push({
      thread: {
        id: thread.id,
        title: thread.title,
        description: thread.description,
        state: thread.state,
      },
      latestAnalysis: latest,
      perspectiveCoverage: coverage,
      newArticlesToday: todayCount,
    });
  }

  /*
   * Ordenar por score descendente (más relevantes primero).
   */
  rows.sort((a, b) => scoreRow(b) - scoreRow(a));

  /*
   * Contador global de análisis no leídos.
   */
  const unreadCount = rows.filter((r) => !r.latestAnalysis.read).length;

  return NextResponse.json({ rows, unreadCount });
}
