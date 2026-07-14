import { NextResponse } from "next/server";
import { ingestAllSources } from "@/lib/rss";

/*
 * POST /api/ingest
 *
 * Dispara la ingesta de todas las fuentes activas.
 * No recibe body; simplemente ejecuta ingestAllSources() y devuelve el resumen.
 *
 * En producción, este endpoint debería estar protegido por un API key
 * o secret para evitar que cualquiera dispare la ingesta.
 */
export async function POST() {
  try {
    const results = await ingestAllSources();
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
