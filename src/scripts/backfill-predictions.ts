#!/usr/bin/env tsx

/*
 * src/scripts/backfill-predictions.ts — Registra predicciones históricas.
 *
 * - meta_analyses: sus predicciones ya están estructuradas (statement,
 *   condition, falsification, reviewDate) → se registran con su status
 *   correcto (pending si la fecha es futura, unverifiable si no).
 * - analyses (texto libre): ~350 predicciones del formato antiguo
 *   (empaquetadas, fechas poco fiables) → se registran como "unverifiable"
 *   SIN llamar al modelo. No contaminan el track record.
 *
 * Modo dry-run por defecto. Con PREDICTIONS_BACKFILL_APPLY=1 aplica.
 */

import { config } from "dotenv";
import { existsSync } from "fs";

const envPath = ".env.local";
if (!existsSync(envPath)) { console.error("❌ No se encontró .env.local"); process.exit(1); }
config({ path: envPath });

async function main() {
  const { db } = await import("../lib/db/index");
  const { metaAnalyses, analyses, predictions } = await import("../lib/db/schema");
  const { eq } = await import("drizzle-orm");

  const apply = process.env.PREDICTIONS_BACKFILL_APPLY === "1";

  console.log("═".repeat(60));
  console.log("  BACKFILL DE PREDICCIONES — historial");
  console.log(`  Modo: ${apply ? "APLICAR" : "DRY-RUN (no modifica nada)"}`);
  console.log("═".repeat(60));

  const today = new Date();

  let metaCount = 0;
  let analysisCount = 0;

  /*
   * PASO 1: predicciones de meta_analyses (estructuradas).
   */
  console.log("\n🌐 META-ANÁLISIS con predicciones:\n");
  const metas = db.select().from(metaAnalyses).all();
  for (const m of metas) {
    if (!m.predictionStatement) continue;
    const valid = m.predictionReviewDate && !isNaN(new Date(m.predictionReviewDate).getTime()) && new Date(m.predictionReviewDate).getTime() > today.getTime();
    const status = valid ? "pending" : "unverifiable";
    console.log(`   [meta ${m.id}] "${m.predictionStatement.slice(0, 60)}" → ${status}`);
    metaCount++;

    if (apply) {
      // evitar duplicados
      const exists = db.select().from(predictions).where(eq(predictions.sourceType, "meta")).all().filter((p) => p.sourceId === m.id).length;
      if (!exists) {
        db.insert(predictions).values({
          sourceType: "meta",
          sourceId: m.id,
          threadId: null,
          statement: m.predictionStatement,
          condition: m.predictionCondition,
          falsificationCondition: m.predictionFalsification,
          reviewDate: m.predictionReviewDate,
          status,
          createdAt: m.createdAt,
        }).run();
      }
    }
  }

  /*
   * PASO 2: predicciones de analyses (texto libre, formato antiguo).
   * Se registran como "unverifiable" SIN llamar al modelo.
   */
  console.log("\n📄 ANÁLISIS de teatro con predicción en texto libre:\n");
  const anals = db.select().from(analyses).all();
  for (const a of anals) {
    if (!a.prediction) continue;
    console.log(`   [analysis ${a.id}] "${a.prediction.slice(0, 60)}" → unverifiable (formato antiguo)`);
    analysisCount++;

    if (apply) {
      const exists = db.select().from(predictions).where(eq(predictions.sourceType, "thread")).all().filter((p) => p.sourceId === a.id).length;
      if (!exists) {
        db.insert(predictions).values({
          sourceType: "thread",
          sourceId: a.id,
          threadId: a.threadId,
          statement: a.prediction,
          condition: null,
          falsificationCondition: null,
          reviewDate: null,
          status: "unverifiable",
          createdAt: a.createdAt,
        }).run();
      }
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  RESULTADO — ${metaCount} sistémicas, ${analysisCount} de teatro (formato antiguo)`);
  console.log(`  ${apply ? "Aplicado." : "Dry-run: nada modificado. Usa PREDICTIONS_BACKFILL_APPLY=1 para aplicar."}`);
  console.log("═".repeat(60) + "\n");
  process.exit(0);
}

main();
