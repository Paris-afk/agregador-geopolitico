import { NextResponse } from "next/server";
import { evaluateDuePredictions } from "@/lib/predictions";

/*
 * POST /api/predictions/evaluate
 *
 * Evalúa las predicciones vencidas (pending con reviewDate <= hoy).
 * Límite por corrida: 20. Best-effort.
 */
export async function POST() {
  try {
    const result = await evaluateDuePredictions();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
