import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { articles, sources } from "@/lib/db/schema";
import { analyzeThread } from "@/lib/deepseek";
import { desc, eq } from "drizzle-orm";

/*
 * POST /api/test-analysis
 *
 * Endpoint de prueba que:
 *   1. Toma los 10 artículos más recientes de la BD.
 *   2. Los enriquece con el nombre de la fuente y su bias (JOIN con sources).
 *   3. Llama a analyzeThread con threadState=null (primer análisis)
 *      y threadTitle="Prueba general".
 *   4. Devuelve el resultado del análisis en JSON.
 *
 * Esto permite verificar que:
 *   - DeepSeek responde correctamente.
 *   - El system prompt produce el formato esperado.
 *   - La integración OpenAI SDK → DeepSeek API funciona.
 */
export async function POST() {
  try {
    /*
     * SELECT de los 10 artículos más recientes (por fetchedAt descendente).
     * Hacemos un INNER JOIN manual con sources para obtener name y bias
     * porque Drizzle con better-sqlite3 no hace join tipado automático
     * en modo "raw" query.
     */
    const allArticles = db
      .select({
        title: articles.title,
        content: articles.content,
        url: articles.url,
        sourceName: sources.name,
        bias: sources.bias,
      })
      .from(articles)
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .orderBy(desc(articles.fetchedAt))
      .limit(10)
      .all();

    if (allArticles.length === 0) {
      return NextResponse.json(
        { error: "No hay artículos en la BD. Ejecuta /api/ingest primero." },
        { status: 400 }
      );
    }

    const input = {
      threadTitle: "Prueba general",
      threadState: null,
      articles: allArticles,
    };

    const result = await analyzeThread(input);

    return NextResponse.json({
      ok: true,
      articlesAnalyzed: allArticles.length,
      analysis: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
