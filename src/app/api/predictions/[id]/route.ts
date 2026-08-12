import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { predictions, articles, sources, threads, analyses, metaAnalyses } from "@/lib/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

/*
 * GET /api/predictions/[id]
 *
 * Devuelve una predicción con todo su contexto:
 *   - prediction: la fila completa
 *   - thread: teatro de origen (si es de teatro)
 *   - sourceAnalysis: el análisis que la generó (si es de teatro)
 *   - sourceMeta: el meta-análisis que la generó (si es sistémica)
 *   - evidenceArticles: artículos usados como evidencia (con url original)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = Number(id);
  if (isNaN(idNum)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const p = db.select().from(predictions).where(eq(predictions.id, idNum)).get();
  if (!p) return NextResponse.json({ error: "Predicción no encontrada" }, { status: 404 });

  // Teatro de origen
  const thread = p.threadId ? db.select().from(threads).where(eq(threads.id, p.threadId)).get() : null;

  // Análisis que la generó (si de teatro) o meta-análisis (si sistémica)
  let sourceAnalysis = null;
  let sourceMeta = null;
  if (p.sourceType === "thread") {
    sourceAnalysis = db.select().from(analyses).where(eq(analyses.id, p.sourceId)).get();
  } else {
    sourceMeta = db.select().from(metaAnalyses).where(eq(metaAnalyses.id, p.sourceId)).get();
  }

  // Artículos de evidencia
  let evidenceArticles: Array<{ id: number; title: string; url: string | null; sourceName: string | null }> = [];
  if (p.evidenceArticleIds) {
    try {
      const ids = JSON.parse(p.evidenceArticleIds) as number[];
      if (Array.isArray(ids) && ids.length > 0) {
        evidenceArticles = db
          .select({
            id: articles.id,
            title: articles.title,
            url: articles.url,
            sourceName: sources.name,
          })
          .from(articles)
          .innerJoin(sources, eq(articles.sourceId, sources.id))
          .where(inArray(articles.id, ids))
          .all();
      }
    } catch {
      evidenceArticles = [];
    }
  }

  return NextResponse.json({
    prediction: p,
    thread,
    sourceAnalysis,
    sourceMeta,
    evidenceArticles,
  });
}
