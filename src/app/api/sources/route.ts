import { NextRequest, NextResponse } from "next/server";
import { getAllSources, createSource } from "@/lib/sources";

/*
 * GET /api/sources
 * Devuelve todas las fuentes registradas en JSON.
 * Sin parámetros, sin paginación por ahora (el volumen de fuentes es pequeño).
 */
export async function GET() {
  try {
    const all = getAllSources();
    return NextResponse.json(all);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/*
 * POST /api/sources
 * Crea una fuente nueva.
 * Body esperado: { name: string, rssUrl: string, bias: BiasValue }
 *
 * La validación (campos requeridos + bias permitido) ocurre dentro de
 * createSource(), que lanza Error si algo falla. Esos errores se traducen
 * a 400 Bad Request automáticamente aquí.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const source = createSource(body);
    return NextResponse.json(source, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    // Errores de validación → 400; el resto → 500
    const status = message.includes("requerido") || message.includes("inválido") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
