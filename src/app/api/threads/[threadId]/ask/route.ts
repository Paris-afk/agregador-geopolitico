import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, analyses, articles, articleThreads, sources } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { askThread } from "@/lib/deepseek";

/*
 * POST /api/threads/[threadId]/ask
 *
 * Pregunta al analista sobre un teatro concreto, con todo su contexto cargado:
 *   - title y state del teatro (memoria acumulada)
 *   - último análisis completo
 *   - ~10 artículos más recientes (título + fuente + bias) como evidencia
 *   - historial de la conversación (para preguntas de seguimiento)
 *
 * Body: { question: string, history: Array<{ role, content }> }
 * Devuelve: { answer, tokensUsed }
 *
 * Loguea el coste aproximado (tokens) de cada pregunta en la terminal del
 * servidor para monitorizar gasto.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  try {
    const { threadId } = await params;
    const id = Number(threadId);
    if (isNaN(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = await request.json();
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!question) {
      return NextResponse.json({ error: "question es requerido" }, { status: 400 });
    }

    /*
     * Contexto: teatro + memoria acumulada.
     */
    const thread = db.select().from(threads).where(eq(threads.id, id)).get();
    if (!thread) return NextResponse.json({ error: "Teatro no encontrado" }, { status: 404 });

    /*
     * Último análisis completo del teatro.
     */
    const latest = db
      .select()
      .from(analyses)
      .where(eq(analyses.threadId, id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();

    /*
     * ~10 artículos más recientes del hilo (título + fuente + bias).
     */
    const recentArticles = db
      .select({
        title: articles.title,
        sourceName: sources.name,
        bias: sources.bias,
      })
      .from(articleThreads)
      .innerJoin(articles, eq(articleThreads.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(eq(articleThreads.threadId, id))
      .orderBy(desc(articles.fetchedAt))
      .limit(10)
      .all();

    const result = await askThread({
      threadTitle: thread.title,
      threadState: thread.state ?? null,
      analysis: latest
        ? {
            summary: latest.summary,
            cuiBono: latest.cuiBono,
            saidVsDone: latest.saidVsDone,
            deviation: latest.deviation,
            prediction: latest.prediction,
            verdict: latest.verdict,
          }
        : null,
      articles: recentArticles,
      question,
      history,
    });

    console.log(
      `💬 CHAT [teatro ${id}] — pregunta (${result.tokensUsed} tokens): ${question.slice(0, 80)}`
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
