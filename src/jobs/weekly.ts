#!/usr/bin/env tsx

/*
 * src/jobs/weekly.ts — Pipeline SEMANAL
 *
 * Programa con cron de macOS: una vez por semana (domingo 4:00 AM)
 *
 * IMPORTANTE: usamos imports DINÁMICOS por la misma razón que daily.ts:
 * config() debe ejecutarse ANTES de que los módulos lean
 * process.env.DEEPSEEK_API_KEY al ser importados.
 *
 * ORDEN DEL PIPELINE Y POR QUÉ ESTE ORDEN:
 *
 *   1. CLASIFICACIÓN (modo COMPLETO: createNewThreads=TRUE) →
 *      Procesa los artículos "pending" acumulados durante la semana
 *      (los que no encajaron en hilos existentes durante los jobs diarios).
 *      Crea hilos NUEVOS para temas recurrentes que merecen su propio
 *      teatro estratégico. Si falla → ABORTAMOS (no tiene sentido
 *      consolidar hilos que no se crearon).
 *
 *   2. CONSOLIDACIÓN → Fusiona hilos duplicados que hayan surgido de
 *      la clasificación semanal (o de creaciones manuales durante la
 *      semana). Si falla → solo logueamos (los duplicados no son
 *      críticos, se pueden fusionar la próxima semana).
 */

import { config } from "dotenv";
import { existsSync } from "fs";

/*
 * Cargar .env.local ANTES de cualquier import que use process.env.
 */
const envPath = ".env.local";
if (!existsSync(envPath)) {
  console.error(`❌ No se encontró ${envPath}. El script necesita DEEPSEEK_API_KEY.`);
  process.exit(1);
}

config({ path: envPath });

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("❌ Falta DEEPSEEK_API_KEY en .env.local");
  console.error("   Añade la clave al archivo .env.local y vuelve a intentar.");
  process.exit(1);
}

async function main() {
  /*
   * Imports DINÁMICOS: se ejecutan DESPUÉS de config(),
   * por lo que process.env.DEEPSEEK_API_KEY ya está poblada.
   */
  const { classifyUnassignedArticles } = await import("../lib/classify");
  const { consolidateThreads } = await import("../lib/consolidate");

  const pipelineStarted = Date.now();

  console.log("═".repeat(60));
  console.log("  PIPELINE SEMANAL — Clasificación + Consolidación + Poda + Meta");
  console.log("  Inicio:", new Date().toISOString());
  console.log("═".repeat(60));

  /*
   * FASE 1: CLASIFICACIÓN COMPLETA (crea hilos nuevos)
   */
  console.log("\n📰 FASE 1/4 — CLASIFICACIÓN COMPLETA (creando hilos nuevos)\n");
  const t1 = Date.now();

  try {
    const result = await classifyUnassignedArticles({ createNewThreads: true });
    console.log(`\n✅ CLASIFICACIÓN COMPLETADA — ${result.totalClassified} artículos, ${result.threadsCreated} hilos nuevos en ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ CLASIFICACIÓN FALLÓ: ${msg}`);
    console.error("ABORTANDO pipeline — sin clasificación no tiene sentido consolidar.");
    process.exit(1);
  }

  /*
   * FASE 2: CONSOLIDACIÓN
   */
  console.log("\n🔗 FASE 2/4 — CONSOLIDACIÓN DE HILOS DUPLICADOS\n");
  const t2 = Date.now();

  try {
    const result = await consolidateThreads({ dryRun: false });
    if (result.groupsProcessed === 0) {
      console.log("\n✅ CONSOLIDACIÓN — No se encontraron grupos a fusionar.");
    } else {
      console.log(`\n✅ CONSOLIDACIÓN COMPLETADA — ${result.groupsProcessed} grupos fusionados en ${((Date.now() - t2) / 1000).toFixed(1)}s`);
      for (const d of result.details) {
        console.log(`   "${d.newTitle}" absorbió ${d.merged.length} hilos (ids: ${d.merged.join(", ")})`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ CONSOLIDACIÓN FALLÓ: ${msg}`);
    console.error("Los duplicados pueden fusionarse la próxima semana.");
  }

  /*
   * FASE 3: PODA DEL MAPA (modo aplicar)
   */
  console.log("\n✂️  FASE 3/4 — PODA DE TEATROS SIN SUSTANCIA\n");
  const t3 = Date.now();

  try {
    const { pruneThreads } = await import("../lib/prune");
    const result = pruneThreads({ dryRun: false });
    if (result.candidates.length === 0) {
      console.log("\n✅ PODA — No hay teatros que desactivar.");
    } else {
      console.log(`\n✅ PODA COMPLETADA — ${result.candidates.length} teatros desactivados en ${((Date.now() - t3) / 1000).toFixed(1)}s`);
      for (const [reason, count] of Object.entries(result.byReason)) {
        if (count > 0) console.log(`   ${reason}: ${count}`);
      }
      console.log(`   Quedan ${result.remainingActive} threads activos.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ PODA FALLÓ: ${msg}`);
    console.error("La poda puede ejecutarse manualmente: npm run script:prune-threads");
  }

  /*
   * FASE 4: CONEXIONES + META-ANÁLISIS (la "neurona")
   */
  console.log("\n🌐 FASE 4/4 — CONEXIONES ENTRE TEATROS Y META-ANÁLISIS\n");
  const t4 = Date.now();

  try {
    const { detectThreadLinks } = await import("../lib/links");
    const linkResult = await detectThreadLinks();
    console.log(`\n✅ CONEXIONES — ${linkResult.confirmed} confirmadas, ${linkResult.rejected} rechazadas en ${((Date.now() - t4) / 1000).toFixed(1)}s`);

    const { runMetaAnalysis } = await import("../lib/meta");
    const metaResult = await runMetaAnalysis();
    if (metaResult.metaId) {
      console.log(`✅ META-ANÁLISIS guardado (id ${metaResult.metaId})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ META-ANÁLISIS FALLÓ: ${msg}`);
    console.error("Puede ejecutarse manualmente: POST /api/meta");
  }

  /*
   * RESUMEN FINAL
   */
  const totalTime = ((Date.now() - pipelineStarted) / 1000).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(`  PIPELINE SEMANAL COMPLETADO — ${totalTime}s total`);
  console.log("═".repeat(60) + "\n");
  process.exit(0);
}

main();
