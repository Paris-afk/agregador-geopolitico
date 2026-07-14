import { db } from "./db/index";
import { articleThreads, articles, sources } from "./db/schema";
import { eq, sql } from "drizzle-orm";

/*
 * getThreadPerspectiveCoverage — Analiza cuántas perspectivas distintas
 * cubre un hilo y cuántos artículos hay de cada una.
 *
 * Devuelve un objeto con:
 *   - totalArticles: número total de artículos vinculados al hilo
 *   - perspectives: array de { bias, count } — desglose por perspectiva
 *   - isTriangulable: true si hay >= 2 perspectivas distintas (condición
 *     mínima para triangular narrativas). Un hilo con una sola perspectiva
 *     está "cojo": no podemos contrastar narrativas porque todos los
 *     artículos vienen del mismo sesgo.
 *
 * La consulta hace:
 *   article_threads → articles (INNER JOIN) → sources (INNER JOIN)
 *   Filtra por threadId, agrupa por bias, cuenta artículos.
 *
 * Usamos sql<string> para castear sources.bias y que Drizzle infiera el
 * tipo correctamente en el GROUP BY.
 */
export function getThreadPerspectiveCoverage(threadId: number): {
  totalArticles: number;
  perspectives: Array<{ bias: string; count: number }>;
  isTriangulable: boolean;
} {
  const rows = db
    .select({
      bias: sql<string>`${sources.bias}`,
      count: sql<number>`COUNT(${articles.id})`.mapWith(Number),
    })
    .from(articleThreads)
    .innerJoin(articles, eq(articleThreads.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(eq(articleThreads.threadId, threadId))
    .groupBy(sql`${sources.bias}`)
    .all();

  const totalArticles = rows.reduce((sum, r) => sum + r.count, 0);
  const isTriangulable = rows.length >= 2;

  return {
    totalArticles,
    perspectives: rows,
    isTriangulable,
  };
}
