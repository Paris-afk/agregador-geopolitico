#!/usr/bin/env tsx

/*
 * src/jobs/daily.ts — Pipeline nocturno DIARIO
 *
 * Programa con cron de macOS: todas las noches a las 3:00 AM
 *
 * IMPORTANTE: usamos imports DINÁMICOS (await import) en vez de estáticos
 * porque config() debe ejecutarse ANTES de que los módulos lean
 * process.env.DEEPSEEK_API_KEY. Los imports estáticos se resuelven en
 * tiempo de compilación (antes de que corra config()), así que los
 * módulos que crean el cliente DeepSeek verían la variable vacía.
 * Con imports dinámicos dentro de main(), garantizamos que config()
 * ya pobló process.env cuando los módulos se cargan.
 *
 * ORDEN DEL PIPELINE Y POR QUÉ ESTE ORDEN:
 *
 *   1. INGESTA → traer artículos nuevos de los feeds RSS.
 *      Sin artículos nuevos, no hay nada que clasificar ni analizar.
 *      Si falla → ABORTAMOS (no tiene sentido seguir).
 *
 *   2. CLASIFICACIÓN (modo DIARIO: createNewThreads=FALSE) →
 *      Asigna los artículos nuevos a hilos EXISTENTES. NO crea hilos
 *      nuevos. Los artículos que no encajan en ningún hilo existente
 *      se quedan como "pending" para el job semanal.
 *      Si falla → CONTINUAMOS (los artículos se acumulan, no se pierden).
 *
 *   3. ANÁLISIS → Ejecuta analyzeAllThreads() que analiza TODOS los hilos
 *      activos con >= 2 perspectivas. Técnicamente no solo los que recibieron
 *      artículos hoy, pero:
 *        - analyzeAllThreads ya tiene salvaguarda MAX_THREADS_PER_RUN=50.
 *        - Cada análisis actualiza el state del hilo (memoria acumulada),
 *          así que re-analizar un hilo sin novedades solo refina el state.
 *        - El costo de Pro+thinking en hilos "tranquilos" es aceptable
 *          como trade-off de simplicidad.
 *      Si falla → CONTINUAMOS (el análisis es incremental, no crítico).
 *
 * POR QUÉ DIARIO vs SEMANAL:
 *   - Diario: ingesta (artículos frescos cada día) + clasificación a hilos
 *     existentes + análisis. El ciclo noticioso es diario; no podemos esperar
 *     una semana para leer las noticias de ayer.
 *   - Semanal: crear hilos NUEVOS para temas recurrentes que no encajaron
 *     en hilos existentes + consolidar duplicados. Crear hilos es una
 *     decisión estructural que no necesita hacerse a diario; una vez por
 *     semana es suficiente para capturar nuevos teatros estratégicos.
 */

import { config } from "dotenv";
import { existsSync } from "fs";

/*
 * Cargar .env.local ANTES de cualquier import que use process.env.
 * El archivo debe existir en la raíz del proyecto.
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
   * por lo que process.env.DEEPSEEK_API_KEY ya está poblada
   * cuando los módulos crean el cliente DeepSeek.
   */
  const { ingestAllSources } = await import("../lib/rss");
  const { classifyUnassignedArticles } = await import("../lib/classify");
  const { analyzeAllThreads } = await import("../lib/analyze");

  const pipelineStarted = Date.now();

  console.log("═".repeat(60));
  console.log("  PIPELINE DIARIO — Ingesta + Clasificación + Análisis");
  console.log("  Inicio:", new Date().toISOString());
  console.log("═".repeat(60));

  /*
   * FASE 1: INGESTA
   */
  console.log("\n📥 FASE 1/4 — INGESTA RSS\n");
  const ingestStart = new Date().toISOString();
  const t1 = Date.now();

  try {
    const result = await ingestAllSources();
    const totalNew = result.reduce((sum, r) => sum + r.newArticles, 0);
    console.log(`\n✅ INGESTA COMPLETADA — ${totalNew} artículos nuevos en ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ INGESTA FALLÓ: ${msg}`);
    console.error("ABORTANDO pipeline — sin ingesta no tiene sentido clasificar ni analizar.");
    process.exit(1);
  }

  /*
   * FASE 1b: IMÁGENES (best-effort, no aborta el pipeline)
   *
   * NIVEL 1 (del feed) ya quedó guardado durante la ingesta.
   * Aquí hacemos NIVEL 2: fetch de la página para og:image en los artículos
   * que el feed no traía imagen. Solo procesamos los nuevos de esta corrida
   * (fetchedAt >= ingestStart). Si falla, logueamos y continuamos.
   */
  console.log("\n🖼  FASE 1b — RECUPERACIÓN DE IMÁGENES (NIVEL 2)\n");
  const t1b = Date.now();

  try {
    const { extractImagesForArticles } = await import("../lib/images");
    const img = await extractImagesForArticles(ingestStart);
    console.log(
      `\n🖼  IMÁGENES — ${img.fromFeed} del feed, ${img.fromPage} por og:image, ${img.failed} sin imagen en ${((Date.now() - t1b) / 1000).toFixed(1)}s`
    );
    console.log(
      `   Google News: ${img.googleResolved} URLs resueltas, ${img.googleUnresolved} sin resolver`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ IMÁGENES FALLÓ (no crítico): ${msg}`);
    console.error("Continuando con la clasificación...");
  }

  /*
   * FASE 2: CLASIFICACIÓN (modo diario: solo hilos existentes)
   */
  console.log("\n📰 FASE 2/4 — CLASIFICACIÓN (modo diario: sin crear hilos nuevos)\n");
  const t2 = Date.now();

  try {
    const result = await classifyUnassignedArticles({ createNewThreads: false });
    console.log(`\n✅ CLASIFICACIÓN COMPLETADA — ${result.totalClassified} artículos a hilos existentes en ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ CLASIFICACIÓN FALLÓ: ${msg}`);
    console.error("Continuando con el análisis (los artículos pendientes se acumulan para el job semanal).");
  }

  /*
   * FASE 3: ANÁLISIS
   */
  console.log("\n🔬 FASE 3/4 — ANÁLISIS GEOPOLÍTICO\n");
  const t3 = Date.now();

  try {
    const result = await analyzeAllThreads({ onlyWithRecentArticles: true });
    console.log(`\n✅ ANÁLISIS COMPLETADO — ${result.analyzed} hilos en ${((Date.now() - t3) / 1000).toFixed(1)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ ANÁLISIS FALLÓ: ${msg}`);
    console.error("El análisis puede re-ejecutarse manualmente sin pérdida de datos.");
  }

  /*
   * FASE 3b: EVALUACIÓN DE PREDICCIONES VENCIDAS
   */
  console.log("\n🎯 FASE 3b — EVALUACIÓN DE PREDICCIONES VENCIDAS\n");
  const t3b = Date.now();

  try {
    const { evaluateDuePredictions } = await import("../lib/predictions");
    const result = await evaluateDuePredictions();
    console.log(`\n✅ PREDICCIONES EVALUADAS — ${result.evaluated} en ${((Date.now() - t3b) / 1000).toFixed(1)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ EVALUACIÓN DE PREDICCIONES FALLÓ: ${msg}`);
    console.error("Puede ejecutarse manualmente: POST /api/predictions/evaluate");
  }

  /*
   * RESUMEN FINAL
   */
  const totalTime = ((Date.now() - pipelineStarted) / 1000).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(`  PIPELINE DIARIO COMPLETADO — ${totalTime}s total`);
  console.log("═".repeat(60) + "\n");
  process.exit(0);
}

main();
