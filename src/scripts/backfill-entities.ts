#!/usr/bin/env tsx

/*
 * src/scripts/backfill-entities.ts — Rellena countries/actors/domains/
 * tensionLevel de los teatros que ya existen pero aún no tienen entidades.
 *
 * BARATO: NO ejecuta un análisis completo. Para cada teatro sin entidades,
 * llama a MODEL_FAST (flash) con una extracción LIGERA que recibe solo:
 *   - título del teatro
 *   - state (memoria comprimida)
 *   - verdict del último análisis
 * y devuelve SOLO los 4 campos de entidades (JSON corto).
 *
 * Reutiliza extractEntities() de deepseek.ts, que a su vez usa la misma
 * normalización que el análisis normal (toCleanStringArray, 1-5).
 *
 * SALVAGUARDAS:
 *   - Límite máximo de teatros por corrida (env BACKFILL_ENTITIES_LIMIT, default 100).
 *   - Concurrencia moderada (5).
 *   - Best-effort: si uno falla, loguea y continúa.
 *   - Si un teatro NO tiene state ni análisis previo, se salta (no hay de
 *     dónde extraer) y se indica en el log.
 *
 * Uso: npm run script:backfill-entities
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
  const { threads, analyses } = await import("../lib/db/schema");
  const { eq, desc } = await import("drizzle-orm");
  const { extractEntities } = await import("../lib/deepseek");
  const { DOMAINS_VOCABULARY } = await import("../lib/prompts");

  const MAX_PROCESS = Number(process.env.BACKFILL_ENTITIES_LIMIT ?? 100);
  const CONCURRENCY = 5;
  const NORMALIZE = process.env.BACKFILL_NORMALIZE === "1";

  console.log("═".repeat(60));
  console.log("  BACKFILL DE ENTIDADES — teatros existentes");
  console.log("  Inicio:", new Date().toISOString());
  console.log(`  Límite: ${MAX_PROCESS} teatros`);
  console.log(`  Modo normalizar: ${NORMALIZE ? "SÍ (reprocesa dominios antiguos)" : "no"}`);
  console.log("═".repeat(60));

  const allowed = new Set<string>(DOMAINS_VOCABULARY);

  /*
   * Candidatos:
   *   - Siempre: threads activos SIN entidades (countries null o array vacío).
   *   - Si NORMALIZE=1: además, threads con domains que contengan valores
   *     fuera del vocabulario cerrado (dominios antiguos de texto libre).
   */
  const candidates = db
    .select({
      id: threads.id,
      title: threads.title,
      state: threads.state,
      countries: threads.countries,
      domains: threads.domains,
    })
    .from(threads)
    .where(eq(threads.active, true))
    .all()
    .filter((t) => {
      // Sin countries → hay que rellenar
      if (!t.countries) return true;
      try {
        const arr = JSON.parse(t.countries);
        if (!Array.isArray(arr) || arr.length === 0) return true;
      } catch {
        return true; // JSON inválido → se rellena
      }

      // Modo normalizar: reprocesar si hay dominios fuera del vocabulario
      if (NORMALIZE && t.domains) {
        try {
          const doms = JSON.parse(t.domains);
          if (Array.isArray(doms) && doms.some((d) => !allowed.has(d))) return true;
        } catch {
          return true;
        }
      }

      return false; // ya tiene entidades válidas
    })
    .slice(0, MAX_PROCESS);

  console.log(`\nCandidatos: ${candidates.length} teatros sin entidades\n`);

  let filled = 0;
  let skippedNoData = 0;
  let failed = 0;

  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) break;

      const t = candidates[idx];

      /*
       * Último análisis para obtener el verdict.
       */
      const latest = db
        .select({ verdict: analyses.verdict })
        .from(analyses)
        .where(eq(analyses.threadId, t.id))
        .orderBy(desc(analyses.analysisDate))
        .limit(1)
        .get();

      /*
       * Si no hay state ni verdict, no hay de dónde extraer entidades.
       */
      if (!t.state && !latest?.verdict) {
        console.log(`   ⏭  [${t.id}] "${t.title}" — sin state ni análisis previo, saltado`);
        skippedNoData++;
        continue;
      }

      try {
        const result = await extractEntities({
          threadTitle: t.title,
          threadState: t.state ?? null,
          verdict: latest?.verdict ?? null,
        });

        db.update(threads)
          .set({
            countries: JSON.stringify(result.countries),
            actors: JSON.stringify(result.actors),
            domains: JSON.stringify(result.domains),
            tensionLevel: result.tensionLevel,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(threads.id, t.id))
          .run();

        console.log(
          `   ✅ [${t.id}] "${t.title}" — ${result.countries.join(",") || "(sin países)"} | tensión ${result.tensionLevel} | ${result.domains.length} dominios`
        );
        filled++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`   ❌ [${t.id}] "${t.title}" FALLÓ: ${msg}`);
        failed++;
      }
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log("\n" + "═".repeat(60));
  console.log(`  RESULTADO — ${filled} rellenados, ${skippedNoData} saltados por falta de datos, ${failed} fallidos`);
  console.log("═".repeat(60) + "\n");
  process.exit(0);
}

main();
