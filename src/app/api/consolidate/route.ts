import { NextResponse } from "next/server";
import { consolidateThreads } from "@/lib/consolidate";

/*
 * POST /api/consolidate
 *
 * Ejecuta la consolidación de hilos duplicados. Identifica hilos que son
 * semánticamente el mismo tema (títulos distintos, mismo conflicto) y los
 * fusiona en un hilo canónico.
 *
 * Devuelve:
 *   - groupsProcessed: cuántos grupos de duplicados se detectaron
 *   - details: para cada grupo, cuál es el canónico y cuáles se fusionaron
 *
 * Los hilos duplicados se DESACTIVAN (active=false), no se borran. Si la
 * fusión fue incorrecta, un operador puede reactivarlos manualmente.
 */
export async function POST() {
  try {
    const result = await consolidateThreads();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
