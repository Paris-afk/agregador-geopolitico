import { NextResponse } from "next/server";
import { classifyUnassignedArticles } from "@/lib/classify";

/*
 * POST /api/classify
 *
 * Ejecuta la clasificación de artículos sin hilo asignado.
 * Procesa un lote de hasta 30 artículos, los envía a DeepSeek para
 * clasificarlos en threads existentes o proponer nuevos, y guarda
 * los vínculos en article_threads.
 *
 * Devuelve un resumen con:
 *   - totalProcessed: artículos del lote
 *   - totalClassified: artículos vinculados a algún hilo
 *   - threadsCreated: hilos nuevos creados por el clasificador
 *   - totalIgnored: artículos marcados como irrelevantes
 *
 * Para clasificar TODOS los artículos pendientes, llama a este endpoint
 * repetidamente (cada llamada procesa un lote). En producción, esto se
 * ejecutaría como un cron job o se encadenaría automáticamente.
 */
export async function POST() {
  try {
    const result = await classifyUnassignedArticles();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
