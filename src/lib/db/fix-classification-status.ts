import { db } from "./index";
import { articles, articleThreads } from "./schema";
import { eq, sql } from "drizzle-orm";

/*
 * fix-classification-status — Corrección de datos para artículos
 * clasificados antes de que existiera el campo classificationStatus.
 *
 * BACKFILL:
 *   - Artículos que YA están en article_threads (vinculados a un hilo) →
 *     los marcamos como "classified" porque ya fueron procesados.
 *   - El resto se quedan como "pending" (incluyendo los que DeepSeek
 *     había marcado como "ignore" antes del bug).
 *
 * Esto se ejecuta UNA SOLA VEZ como paso de migración de datos:
 *   npm run db:fix-status
 *
 * Después de ejecutarlo, la clasificación puede reanudarse normalmente:
 * los ya clasificados se saltan, los pending se reprocesan limpio.
 */
async function fixClassificationStatus() {
  console.log("🔧 Corrigiendo classificationStatus de artículos existentes...\n");

  /*
   * Paso 1: Marcar como "classified" todos los artículos que YA tienen
   * al menos un vínculo en article_threads.
   *
   * Usamos una subconsulta con IN para obtener los articleId distintos
   * de article_threads.
   */
  const classifiedIds = db
    .selectDistinct({ articleId: articleThreads.articleId })
    .from(articleThreads)
    .all()
    .map((r) => r.articleId);

  if (classifiedIds.length > 0) {
    /*
     * SQLite no soporta UPDATE ... WHERE id IN (SELECT ...) con joins
     * complejos, pero podemos hacerlo manualmente. Como el número de ids
     * es manejable (miles, no millones), iteramos.
     *
     * Para optimizar, hacemos los updates en chunks y con una query directa.
     */
    const result = db
      .update(articles)
      .set({ classificationStatus: "classified" })
      .where(
        sql`${articles.id} IN (SELECT DISTINCT ${articleThreads.articleId} FROM ${articleThreads})`
      )
      .run();

    console.log(`   ✅ ${result.changes} artículos marcados como "classified"`);
  } else {
    console.log("   ⏭  No hay artículos en article_threads — nada que marcar");
  }

  /*
   * Paso 2: Reportar cuántos quedan en cada estado.
   */
  const stats = db
    .select({
      status: sql<string>`${articles.classificationStatus}`,
      count: sql<number>`COUNT(*)`.mapWith(Number),
    })
    .from(articles)
    .groupBy(sql`${articles.classificationStatus}`)
    .all();

  console.log("\n📊 Estado actual de los artículos:");
  for (const row of stats) {
    console.log(`   ${row.status}: ${row.count}`);
  }

  console.log("\n✅ Corrección completada.");
}

fixClassificationStatus().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
