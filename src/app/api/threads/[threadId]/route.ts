import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, analyses, articles, articleThreads, sources } from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getThreadPerspectiveCoverage } from "@/lib/threads";

/*
 * GET /api/threads/[threadId]
 *
 * Devuelve los datos completos de un teatro para la página de lectura:
 *   - thread: id, title, description, state
 *   - latestAnalysis: el análisis más reciente con todos sus campos
 *   - perspectiveCoverage: desglose de perspectivas con conteo
 *   - articleCount: total de artículos del hilo
 *
 * Responde 404 si el thread no existe o no tiene análisis.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const id = Number(threadId);
  if (isNaN(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const thread = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!thread) return NextResponse.json({ error: "Teatro no encontrado" }, { status: 404 });

  const latest = db
    .select()
    .from(analyses)
    .where(eq(analyses.threadId, id))
    .orderBy(desc(analyses.analysisDate))
    .limit(1)
    .get();

  if (!latest) return NextResponse.json({ error: "Sin análisis" }, { status: 404 });

  const coverage = getThreadPerspectiveCoverage(id);

  /*
   * Artículos del hilo (con imagen y fuente) para la sección de fuentes
   * y la imagen destacada. Hasta 20, más recientes primero.
   */
  const threadArticles = db
    .select({
      id: articles.id,
      title: articles.title,
      url: articles.url,
      imageUrl: articles.imageUrl,
      sourceName: sources.name,
      bias: sources.bias,
    })
    .from(articleThreads)
    .innerJoin(articles, eq(articleThreads.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(eq(articleThreads.threadId, id))
    .orderBy(desc(articles.fetchedAt))
    .limit(20)
    .all();

  return NextResponse.json({
    thread: {
      id: thread.id,
      title: thread.title,
      description: thread.description,
      state: thread.state,
    },
    latestAnalysis: latest,
    perspectiveCoverage: coverage,
    articleCount: coverage.totalArticles,
    articles: threadArticles,
  });
}
