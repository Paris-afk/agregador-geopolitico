import { NextResponse } from "next/server";
import { analyzeAllThreads } from "@/lib/analyze";

/*
 * POST /api/analyze
 *
 * Ejecuta el análisis geopolítico de todos los hilos activos que tengan
 * al menos 2 perspectivas distintas (condición mínima para triangular).
 *
 * Devuelve un resumen con:
 *   - totalActive: hilos activos en total
 *   - analyzed: hilos analizados exitosamente
 *   - skipped: hilos saltados (<2 perspectivas)
 *   - failed: hilos que fallaron (error DeepSeek, JSON inválido, etc.)
 *   - totalTimeMs: duración total en milisegundos
 *
 * Los análisis se guardan en la tabla "analyses" y el state de cada hilo
 * se actualiza con la nueva síntesis acumulada.
 */
export async function POST() {
  try {
    const result = await analyzeAllThreads();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
