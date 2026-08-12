import { NextResponse } from "next/server";
import { detectThreadLinks } from "@/lib/links";
import { runMetaAnalysis } from "@/lib/meta";
import { db } from "@/lib/db/index";
import { metaAnalyses } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

/*
 * GET /api/meta — Devuelve el último meta-análisis guardado.
 */
export async function GET() {
  const latest = db.select().from(metaAnalyses).orderBy(desc(metaAnalyses.createdAt)).limit(1).get();
  if (!latest) return NextResponse.json({ meta: null });
  return NextResponse.json({ meta: latest });
}

/*
 * POST /api/meta
 *
 * Dispara el meta-análisis completo:
 *   1. Detecta conexiones entre teatros (thread_links).
 *   2. Corre el meta-análisis global (meta_analyses).
 *
 * Devuelve el resumen de ambos pasos.
 */
export async function POST() {
  try {
    const linksResult = await detectThreadLinks();
    const metaResult = await runMetaAnalysis();

    return NextResponse.json({
      ok: true,
      links: linksResult,
      meta: metaResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
