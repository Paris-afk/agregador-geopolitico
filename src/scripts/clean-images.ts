#!/usr/bin/env tsx

/*
 * src/scripts/clean-images.ts — Limpia los logos de Google News envenenados
 * y re-extrae imágenes reales.
 *
 * FASE 1 — LIMPIAR:
 *   Recorre artículos con imageUrl no nula y aplica isGarbageImage().
 *   Las que den positivo (logos Google, gstatic, rutas con logo/icon, etc.)
 *   pasan a imageUrl = null.
 *
 * FASE 2 — RE-EXTRAER (opcional, recomendable):
 *   Para artículos con imageUrl null que aún no se intentaron con la lógica
 *   nueva, reintenta la extracción: resolveRealUrl() + og:image + filtro.
 *   Reutiliza las mismas salvaguardas (concurrencia 5, timeout 8s, best-effort).
 *
 * LÍMITE DE SEGURIDAD:
 *   El parámetro MAX_PROCESS (default 300) limita cuántos artículos se
 *   re-procesan por ejecución, para no lanzar miles de peticiones de golpe.
 *   Si hay más pendientes, se muestra en el log y se puede correr varias veces.
 *
 * Uso: npm run script:clean-images   (o tsx src/scripts/clean-images.ts)
 */

import { config } from "dotenv";
import { existsSync } from "fs";

const envPath = ".env.local";
if (!existsSync(envPath)) {
  console.error(`❌ No se encontró ${envPath}.`);
  process.exit(1);
}
config({ path: envPath });

async function main() {
  const { db } = await import("../lib/db/index");
  const { articles } = await import("../lib/db/schema");
  const { eq, and, isNull, sql } = await import("drizzle-orm");
  const { isGarbageImage, resolveRealUrl, fetchPageOgImage } = await import("../lib/images");

  const MAX_PROCESS = Number(process.env.CLEAN_IMAGES_LIMIT ?? 300);
  const CONCURRENCY = 5;

  console.log("═".repeat(60));
  console.log("  LIMPIEZA DE IMÁGENES — logos de Google News");
  console.log("  Inicio:", new Date().toISOString());
  console.log(`  Límite de re-proceso: ${MAX_PROCESS} artículos`);
  console.log("═".repeat(60));

  let cleaned = 0;
  let reExtracted = 0;
  let stillNoImage = 0;

  /*
   * FASE 1 — LIMPIAR: artículos con imageUrl que resultan ser basura.
   * Solo revisamos los que tienen imageUrl no nula.
   */
  console.log("\n🧹 FASE 1 — Limpiando logos envenenados...\n");
  const withImage = db
    .select({ id: articles.id, imageUrl: articles.imageUrl, url: articles.url })
    .from(articles)
    .where(sql`${articles.imageUrl} IS NOT NULL`)
    .limit(2000)
    .all();

  for (const a of withImage) {
    if (!a.imageUrl) continue;
    // Sin ancho conocido: pasamos null (el filtro de dominio/ruta cubre logos)
    if (isGarbageImage(a.imageUrl, null)) {
      db.update(articles)
        .set({ imageUrl: null })
        .where(eq(articles.id, a.id))
        .run();
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`✅ ${cleaned} imágenes basura limpiadas (imageUrl → null)`);
  } else {
    console.log("✅ No se encontraron imágenes basura en la fase 1.");
  }

  /*
   * FASE 2 — RE-EXTRAER: artículos que quedaron sin imagen y no se han
   * intentado con la lógica nueva (imageFetchedAt IS NULL).
   */
  console.log("\n🖼  FASE 2 — Re-extrayendo imágenes con la lógica nueva...\n");

  const pending = db
    .select({
      id: articles.id,
      url: articles.url,
      resolvedUrl: articles.resolvedUrl,
    })
    .from(articles)
    .where(
      and(
        isNull(articles.imageUrl),
        isNull(articles.imageFetchedAt)
      )
    )
    .limit(MAX_PROCESS)
    .all();

  if (pending.length === 0) {
    console.log("✅ No hay artículos pendientes de re-procesar.");
  } else {
    const remaining = (
      db
        .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(articles)
        .where(and(isNull(articles.imageUrl), isNull(articles.imageFetchedAt)))
        .get()
    )?.count ?? 0;

    console.log(`Procesando ${pending.length} de ${remaining} pendientes (límite ${MAX_PROCESS})`);
    if (remaining > pending.length) {
      console.log(`⚠️  Quedan ${remaining - pending.length} más — corre el script de nuevo para procesarlos.`);
    }

    const now = new Date().toISOString();
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= pending.length) break;

        const a = pending[idx];
        const { url: realUrl } = await resolveRealUrl(a.url, a.resolvedUrl);
        const result = realUrl ? await fetchPageOgImage(realUrl) : null;

        if (result) {
          db.update(articles)
            .set({
              imageUrl: result.image,
              resolvedUrl: result.resolvedUrl,
              imageFetchedAt: now,
            })
            .where(eq(articles.id, a.id))
            .run();
          reExtracted++;
        } else {
          /*
           * Solo guardamos resolvedUrl si es genuinamente no-Google.
           */
          const safeResolved = realUrl && !realUrl.includes("news.google.com") ? realUrl : null;
          db.update(articles)
            .set({
              ...(safeResolved ? { resolvedUrl: safeResolved } : {}),
              imageFetchedAt: now,
            })
            .where(eq(articles.id, a.id))
            .run();
          stillNoImage++;
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  RESULTADO — ${cleaned} limpiadas, ${reExtracted} re-extraídas con éxito, ${stillNoImage} quedaron sin imagen`);
  console.log("═".repeat(60) + "\n");
  process.exit(0);
}

main();
