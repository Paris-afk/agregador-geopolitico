#!/usr/bin/env tsx

/*
 * src/jobs/analyze-one.ts — Analiza UN hilo concreto (diagnóstico).
 *
 * Uso: npx tsx src/jobs/analyze-one.ts <threadId>
 *
 * Reutiliza la misma lógica de analyzeAllThreads pero limitada a un hilo,
 * para diagnosticar problemas específicos (JSON inválido, idioma, etc.)
 * sin tocar el resto de la base. Muestra la respuesta cruda y finish_reason.
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
  const threadId = Number(process.argv[2]);
  if (!threadId) {
    console.error("❌ Uso: npx tsx src/jobs/analyze-one.ts <threadId>");
    process.exit(1);
  }

  const { db } = await import("../lib/db/index");
  const { threads, articles, sources, articleThreads, analyses } = await import("../lib/db/schema");
  const { eq, desc, sql } = await import("drizzle-orm");
  const { analyzeThread } = await import("../lib/deepseek");
  const { getThreadPerspectiveCoverage } = await import("../lib/threads");
  const { extractTextsForArticles, getFullTextForArticles } = await import("../lib/extract");

  console.log(`\n🎯 ANALIZANDO HILO ${threadId} SOLO\n`);

  const thread = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!thread) {
    console.error("❌ Hilo no encontrado");
    process.exit(1);
  }

  const lastAnalysis = db
    .select({ analysisDate: analyses.analysisDate })
    .from(analyses)
    .where(eq(analyses.threadId, threadId))
    .orderBy(desc(analyses.analysisDate))
    .limit(1)
    .get();

  const isFirstAnalysis = !lastAnalysis;
  const articleFilter = isFirstAnalysis
    ? sql`${eq(articleThreads.threadId, thread.id)}`
    : sql`${eq(articleThreads.threadId, thread.id)} AND ${articles.fetchedAt} > ${lastAnalysis.analysisDate}`;

  const threadArticles = db
    .select({
      id: articles.id,
      sourceName: sources.name,
      bias: sources.bias,
      title: articles.title,
      content: articles.content,
      resolvedUrl: articles.resolvedUrl,
    })
    .from(articleThreads)
    .innerJoin(articles, eq(articleThreads.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(articleFilter)
    .orderBy(desc(articles.publishedAt))
    .limit(40)
    .all();

  console.log(`Hilo: "${thread.title}"`);
  console.log(`Artículos nuevos: ${threadArticles.length}`);
  console.log(`state: ${thread.state ? thread.state.slice(0, 80) + "..." : "null"}`);

  // Extraer fullText de los críticos (2 nuevos más recientes, 3 si primer análisis)
  const MAX_FULL_TEXT = isFirstAnalysis ? 3 : 2;
  const criticalTargets = threadArticles
    .filter((a) => a.resolvedUrl)
    .slice(0, MAX_FULL_TEXT)
    .map((a) => ({ id: a.id, resolvedUrl: a.resolvedUrl }));

  const { expanded, extraChars } = await extractTextsForArticles(criticalTargets);
  const fullTexts = getFullTextForArticles(criticalTargets.map((t) => t.id));

  const analystArticles = threadArticles.map((a) => {
    const ft = fullTexts.get(a.id);
    return {
      sourceName: a.sourceName,
      bias: a.bias,
      title: a.title,
      content: ft ?? a.content,
      hasFullText: !!ft,
    };
  });

  console.log(`Enviando: ${threadArticles.length} artículos (${expanded} con texto completo, +${extraChars} chars)`);

  console.log("\n--- LLAMANDO A DeepSeek (intento completo) ---\n");
  try {
    const result = await analyzeThread({
      threadTitle: thread.title,
      threadState: thread.state ?? null,
      articles: analystArticles,
    });
    console.log("\n✅ ANÁLISIS OK");
    console.log("verdict:", result.verdict.slice(0, 120));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ FALLÓ: ${msg}`);
    console.error("Revisa logs/failed-response-*.json para la respuesta cruda completa.");
  }

  process.exit(0);
}

main();
