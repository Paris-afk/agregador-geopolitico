import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, analyses, articles, articleThreads, sources, threadLinks } from "@/lib/db/schema";
import { eq, desc, or, sql } from "drizzle-orm";
import { askThread } from "@/lib/deepseek";
import type { ConnectedThread } from "@/lib/deepseek";

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

    /*
     * TEATROS CONECTADOS vía thread_links.
     * Toma los links que involucran a este teatro, ordenados por strength
     * desc, y resuelve el otro extremo de cada uno. Máximo 5.
     */
    const links = db
      .select({
        threadA: threadLinks.threadA,
        threadB: threadLinks.threadB,
        linkType: threadLinks.linkType,
        rationale: threadLinks.rationale,
        strength: threadLinks.strength,
      })
      .from(threadLinks)
      .where(
        sql`${threadLinks.threadA} = ${id} OR ${threadLinks.threadB} = ${id}`
      )
      .all()
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);

    const connectedThreads: ConnectedThread[] = [];
    for (const link of links) {
      const otherId = link.threadA === id ? link.threadB : link.threadA;
      const other = db.select().from(threads).where(eq(threads.id, otherId)).get();
      if (!other) continue;

      const otherLatest = db
        .select({ verdict: analyses.verdict, analysisDate: analyses.analysisDate })
        .from(analyses)
        .where(eq(analyses.threadId, otherId))
        .orderBy(desc(analyses.analysisDate))
        .limit(1)
        .get();

      connectedThreads.push({
        id: other.id,
        title: other.title,
        state: other.state ?? null,
        verdict: otherLatest?.verdict ?? null,
        linkType: link.linkType,
        rationale: link.rationale,
        strength: link.strength,
      });
    }

    console.log(
      `   [chat] teatro ${id}: ${connectedThreads.length} teatros conectados incluidos en el contexto (${connectedThreads.map((c) => c.id).join(",") || "ninguno"})`
    );

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
      connectedThreads,
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
