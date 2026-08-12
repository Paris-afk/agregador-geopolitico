import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, analyses } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

/*
 * GET /api/map
 *
 * Devuelve, agregado por país: los teatros que lo implican, su tensionLevel
 * máximo, nº de desviaciones activas y nº de análisis sin leer.
 *
 * Fuente de datos: campos `countries` (JSON array de ISO alpha-2) y
 * `tensionLevel` de la tabla threads, escritos por el analista en cada
 * análisis. También cruza con la tabla analyses para contar desviaciones
 * activas (deviation no nulo y que no diga "no aplica") y no leídos.
 *
 * Respuesta:
 * {
 *   "countries": [
 *     { "code": "GR",
 *       "threads": [ { id, title, tensionLevel } ],
 *       "maxTension": 4,
 *       "activeDeviations": 2,
 *       "unreadAnalyses": 1 }
 *   ]
 * }
 */

function hasActiveDeviation(deviation: string | null): boolean {
  if (!deviation) return false;
  const d = deviation.toLowerCase();
  return !(
    d.includes("no aplica") ||
    d.includes("primer análisis") ||
    d.includes("sin desviaciones") ||
    d.includes("no hay desviación")
  );
}

function parseCountries(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c))
      : [];
  } catch {
    return [];
  }
}

export async function GET() {
  /*
   * Cargar todos los threads activos con sus entidades.
   */
  const allThreads = db
    .select()
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  /*
   * Agregación por país.
   */
  const countryMap = new Map<string, {
    code: string;
    threads: Array<{ id: number; title: string; tensionLevel: number | null }>;
    maxTension: number;
    activeDeviations: number;
    unreadAnalyses: number;
  }>();

  for (const t of allThreads) {
    const codes = parseCountries(t.countries);
    if (codes.length === 0) continue;

    // Último análisis del thread para desviación y estado leído
    const latest = db
      .select()
      .from(analyses)
      .where(eq(analyses.threadId, t.id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();

    const hasDev = latest ? hasActiveDeviation(latest.deviation) : false;
    const unread = latest ? !latest.read : false;

    for (const code of codes) {
      const entry = countryMap.get(code) ?? {
        code,
        threads: [],
        maxTension: 0,
        activeDeviations: 0,
        unreadAnalyses: 0,
      };

      entry.threads.push({
        id: t.id,
        title: t.title,
        tensionLevel: t.tensionLevel ?? null,
      });
      entry.maxTension = Math.max(entry.maxTension, t.tensionLevel ?? 0);
      if (hasDev) entry.activeDeviations++;
      if (unread) entry.unreadAnalyses++;

      countryMap.set(code, entry);
    }
  }

  // Ordenar por tensión máxima descendente
  const countries = Array.from(countryMap.values()).sort((a, b) => b.maxTension - a.maxTension);

  return NextResponse.json({ countries });
}
