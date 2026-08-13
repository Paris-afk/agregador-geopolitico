import { db } from "./db/index";
import { threads, threadLinks } from "./db/schema";
import { eq, sql } from "drizzle-orm";
import { getThreadPerspectiveCoverage } from "./threads";
import { classifyLink } from "./deepseek";

/*
 * ============================================================================
 * DETECCIÓN DE CONEXIONES ENTRE TEATROS (la "neurona")
 * ============================================================================
 *
 * Reutiliza la lógica de señal IDF del pre-filtrado de consolidación:
 * dominios compartidos + entidades raras ponderadas por frecuencia inversa.
 * PERO el resultado aquí NO es una fusión: es un LINK (relación material entre
 * dos teatros distintos).
 *
 * Umbral más permisivo (0.4 vs 1.0 de fusión): aquí queremos RELACIONES, no
 * identidad. Cada par que pasa el umbral se envía al modelo (MODEL_FAST) que
 * determina el linkType y escribe el rationale en términos materiales. Puede
 * rechazar la conexión si el solapamiento es casual.
 *
 * Salvaguarda: máximo LINK_MAX_PAIRS (80) pares por corrida, ordenados por
 * peso descendente.
 */

const LINK_THRESHOLD = 0.4;
const HUB_RATIO = 0.25;
const LINK_MAX_PAIRS = 80;

const LINK_TYPES = [
  "cadena_material",
  "mismo_bloque",
  "presion_coordinada",
  "competencia_recurso",
  "distraccion",
  "motor_interno",
] as const;

function parseEntities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function detectThreadLinks(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<{
  candidates: number;
  evaluated: number;
  confirmed: number;
  rejected: number;
}> {
  const dryRun = opts?.dryRun ?? false;
  const maxPairs = opts?.limit ?? LINK_MAX_PAIRS;

  const rawThreads = db.select().from(threads).where(eq(threads.active, true)).all();
  if (rawThreads.length < 2) {
    return { candidates: 0, evaluated: 0, confirmed: 0, rejected: 0 };
  }

  const all = rawThreads.map((t) => {
    const cov = getThreadPerspectiveCoverage(t.id);
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      countries: parseEntities(t.countries),
      actors: parseEntities(t.actors),
      domains: parseEntities(t.domains),
      perspectiveCount: cov.perspectives.length,
      articleCount: cov.totalArticles,
    };
  });

  const total = all.length;
  const hubCutoff = total * HUB_RATIO;

  // Frecuencias para IDF
  const countryFreq = new Map<string, number>();
  const actorFreq = new Map<string, number>();
  for (const t of all) {
    for (const c of new Set(t.countries)) countryFreq.set(c, (countryFreq.get(c) ?? 0) + 1);
    for (const a of new Set(t.actors)) actorFreq.set(a, (actorFreq.get(a) ?? 0) + 1);
  }
  const countryHub = new Set([...countryFreq.entries()].filter(([, n]) => n > hubCutoff).map(([c]) => c));
  const actorHub = new Set([...actorFreq.entries()].filter(([, n]) => n > hubCutoff).map(([a]) => a));

  /*
   * Señal entre dos threads (misma lógica que consolidación).
   */
  function signalBetween(a: (typeof all)[number], b: (typeof all)[number]) {
    const sharedDomains = a.domains.filter((d) => b.domains.includes(d));
    if (sharedDomains.length < 1) return null;
    const rareCountries = a.countries.filter((c) => b.countries.includes(c) && !countryHub.has(c));
    const rareActors = a.actors.filter((x) => b.actors.includes(x) && !actorHub.has(x));
    const weight =
      rareCountries.reduce((s, c) => s + 1 / (countryFreq.get(c) ?? 1), 0) +
      rareActors.reduce((s, x) => s + 1 / (actorFreq.get(x) ?? 1), 0);
    return { sharedDomains, rareCountries, rareActors, weight };
  }

  /*
   * Todos los pares que pasan el umbral, ordenados por peso desc, limitados.
   */
  const pairs: Array<{ a: number; b: number; weight: number; info: NonNullable<ReturnType<typeof signalBetween>> }> = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const s = signalBetween(all[i], all[j]);
      if (s && s.weight >= LINK_THRESHOLD) {
        pairs.push({ a: all[i].id, b: all[j].id, weight: s.weight, info: s });
      }
    }
  }
  pairs.sort((x, y) => y.weight - x.weight);
  const selected = pairs.slice(0, maxPairs);

  console.log(`\n🔗 DETECCIÓN DE CONEXIONES — ${pairs.length} pares sobre umbral ${LINK_THRESHOLD}, evaluando ${selected.length} (máx ${maxPairs})\n`);

  const idToThread = new Map(all.map((t) => [t.id, t]));
  let confirmed = 0;
  let rejected = 0;

  for (const p of selected) {
    const a = idToThread.get(p.a)!;
    const b = idToThread.get(p.b)!;

    console.log(`   Par [${a.id},${b.id}] peso=${p.weight.toFixed(2)} | dominios:${p.info.sharedDomains.join(",")} | países raros:${p.info.rareCountries.join(",") || "-"} | actores raros:${p.info.rareActors.join(",") || "-"}`);

    let classification;
    try {
      classification = await classifyLink({
        threadA: { id: a.id, title: a.title, state: a.state },
        threadB: { id: b.id, title: b.title, state: b.state },
        sharedDomains: p.info.sharedDomains,
        rareCountries: p.info.rareCountries,
        rareActors: p.info.rareActors,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      ❌ Link [${a.id},${b.id}] falló en el modelo: ${msg}`);
      continue;
    }

    if (!classification.connected || !classification.linkType) {
      console.log(`      ✗ SIN CONEXIÓN — ${a.title.slice(0, 40)} | ${b.title.slice(0, 40)}`);
      rejected++;
      continue;
    }

    console.log(`      ✓ ${classification.linkType} (${classification.strength}/3) — ${classification.rationale?.slice(0, 90)}`);

    if (!dryRun) {
      const now = new Date().toISOString();
      /*
       * UPSERT de estabilidad: si el par ya existe, actualizamos (timesConfirmed++
       * y lastSeenAt). Si no, lo insertamos con timesConfirmed=1.
       * Evita duplicados y permite marcar enlaces estables (>=2 confirmaciones).
       */
      const existing = db
        .select()
        .from(threadLinks)
        .where(
          sql`(${threadLinks.threadA} = ${a.id} AND ${threadLinks.threadB} = ${b.id}) OR (${threadLinks.threadA} = ${b.id} AND ${threadLinks.threadB} = ${a.id})`
        )
        .get();

      if (existing) {
        db.update(threadLinks)
          .set({
            linkType: classification.linkType,
            rationale: classification.rationale ?? existing.rationale,
            strength: classification.strength ?? existing.strength,
            timesConfirmed: existing.timesConfirmed + 1,
            lastSeenAt: now,
            detectedAt: now,
          })
          .where(eq(threadLinks.id, existing.id))
          .run();
      } else {
        db.insert(threadLinks)
          .values({
            threadA: a.id,
            threadB: b.id,
            linkType: classification.linkType,
            rationale: classification.rationale ?? "",
            strength: classification.strength ?? 1,
            detectedAt: now,
            timesConfirmed: 1,
            lastSeenAt: now,
          })
          .run();
      }
    }
    confirmed++;
  }

  return { candidates: pairs.length, evaluated: selected.length, confirmed, rejected };
}

/*
 * getThreadLinks — Recupera los links que involucran a un set de threadIds
 * (para el input del meta-análisis).
 */
export function getThreadLinks(threadIds: number[]): Array<{
  threadA: number;
  threadB: number;
  linkType: string;
  rationale: string;
  strength: number;
}> {
  if (threadIds.length === 0) return [];
  return db
    .select({
      threadA: threadLinks.threadA,
      threadB: threadLinks.threadB,
      linkType: threadLinks.linkType,
      rationale: threadLinks.rationale,
      strength: threadLinks.strength,
    })
    .from(threadLinks)
    .where(
      sql`${threadLinks.threadA} IN (${sql.join(threadIds.map((id) => sql`${id}`), sql`, `)}) OR ${threadLinks.threadB} IN (${sql.join(threadIds.map((id) => sql`${id}`), sql`, `)})`
    )
    .all();
}
