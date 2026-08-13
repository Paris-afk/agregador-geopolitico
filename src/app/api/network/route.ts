import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { threads, threadLinks, analyses, articleThreads, articles } from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";

/*
 * GET /api/network
 *
 * Devuelve nodos y aristas del grafo de teatros, ya preparados para d3-force.
 *
 * NODOS: teatros activos con al menos una conexión. Tamaño según nº de
 * artículos; color según el dominio PRINCIPAL (el primero de su lista de
 * dominios, vocabulario cerrado).
 *
 * ARISTAS: los thread_links. Grosor según strength (1-3). Estilo según
 * linkType. timesConfirmed >= 2 → conexión ESTABLE (más opaca).
 *
 * Respuesta:
 * {
 *   "nodes": [ { id, title, verdict, domains[], tensionLevel, articleCount, primaryDomain } ],
 *   "edges": [ { source, target, linkType, strength, rationale, timesConfirmed, stable } ]
 * }
 */

function parseDomains(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function GET() {
  // Teatros activos con sus artículos (para tamaño) y veredicto
  const allThreads = db
    .select()
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  const threadIds = allThreads.map((t) => t.id);

  // Conteo de artículos por teatro
  const articleCounts = new Map<number, number>();
  if (threadIds.length > 0) {
    const rows = db
      .select({
        threadId: articleThreads.threadId,
        count: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(articleThreads)
      .where(sql`${articleThreads.threadId} IN (${sql.join(threadIds.map((id) => sql`${id}`), sql`, `)})`)
      .groupBy(articleThreads.threadId)
      .all();
    for (const r of rows) articleCounts.set(r.threadId, r.count);
  }

  // Último veredicto por teatro
  const verdictMap = new Map<number, string>();
  for (const t of allThreads) {
    const latest = db
      .select({ verdict: analyses.verdict })
      .from(analyses)
      .where(eq(analyses.threadId, t.id))
      .orderBy(desc(analyses.analysisDate))
      .limit(1)
      .get();
    if (latest) verdictMap.set(t.id, latest.verdict);
  }

  // Todos los links
  const links = db.select().from(threadLinks).all();

  const linkSet = new Set<number>();
  for (const l of links) {
    linkSet.add(l.threadA);
    linkSet.add(l.threadB);
  }

  const nodes = allThreads
    .filter((t) => linkSet.has(t.id))
    .map((t) => {
      const domains = parseDomains(t.domains);
      return {
        id: t.id,
        title: t.title,
        verdict: verdictMap.get(t.id) ?? null,
        domains,
        primaryDomain: domains[0] ?? null,
        tensionLevel: t.tensionLevel ?? null,
        articleCount: articleCounts.get(t.id) ?? 0,
      };
    });

  const edges = links.map((l) => ({
    source: l.threadA,
    target: l.threadB,
    linkType: l.linkType,
    strength: l.strength,
    rationale: l.rationale,
    timesConfirmed: l.timesConfirmed ?? 1,
    stable: (l.timesConfirmed ?? 1) >= 2,
  }));

  return NextResponse.json({ nodes, edges });
}
