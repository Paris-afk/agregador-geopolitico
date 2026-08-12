import { db } from "./db/index";
import { threads, articleThreads, events, analyses } from "./db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  findDuplicateThreads,
  mergeThreadStates,
  proposeMergedTitle,
  extractEntities,
} from "./deepseek";
import type { ConsolidatorThread } from "./deepseek";
import { getThreadPerspectiveCoverage } from "./threads";

/*
 * ============================================================================
 * CONSOLIDACIÓN AGRESIVA CON ENTIDADES ESTRUCTURALES
 * ============================================================================
 *
 * Mejoras sobre la versión anterior:
 *
 * 1. PRE-FILTRADO ESTRUCTURAL (nuevo): antes de llamar al modelo, calculamos
 *    CANDIDATOS a fusión por solapamiento de entidades. Dos threads son
 *    candidatos si:
 *      - Comparten al menos 1 dominio (vocabulario cerrado)
 *      - Y comparten al menos 2 países O 1 actor no estatal
 *    Esto reduce el espacio de comparación y lo ancla en MATERIA, no en
 *    temática. Se loguean los grupos candidatos.
 *
 * 2. LLAMADA AL MODELO con criterio AGRESIVO: se le pasan SOLO los grupos
 *    candidatos, con título, descripción, state resumido, countries, actors,
 *    domains y tensionLevel. El prompt pide fusionar facetas del mismo juego.
 *
 * 3. FUSIÓN DE STATES (crítico): al fusionar, el thread canónico INTEGRA la
 *    memoria de los absorbidos vía mergeThreadStates() (MODEL_FAST, ~350
 *    palabras). Sin esto se pierde historia acumulada silenciosamente.
 *
 * 4. RECÁLCULO DE ENTIDADES: tras fusionar, se re-extraen countries/actors/
 *    domains/tensionLevel del estado unificado con extractEntities().
 *
 * 5. TÍTULO NUEVO: el modelo propone un título que refleja el teatro
 *    AMPLIADO, no hereda el de un trozo.
 *
 * MODO DRY-RUN OBLIGATORIO: dryRun=true por defecto (no modifica nada).
 * Con dryRun=false aplica (active=false en los absorbidos, NUNCA borra).
 */

function parseEntities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/*
 * Estructura interna: thread con entidades parseadas para el pre-filtro.
 */
type ThreadWithEntities = {
  id: number;
  title: string;
  description: string | null;
  state: string | null;
  countries: string[];
  actors: string[];
  domains: string[];
  tensionLevel: number | null;
  perspectiveCount: number;
  articleCount: number;
};

export type ConsolidateResult = {
  dryRun: boolean;
  candidateGroups: Array<{ ids: number[]; titles: string[] }>;
  groupsProcessed: number;
  details: Array<{
    canonical: number;
    newTitle: string;
    merged: number[];
    mergedState: string | null;
  }>;
};

export async function consolidateThreads(opts?: { dryRun?: boolean }): Promise<ConsolidateResult> {
  const dryRun = opts?.dryRun ?? true;

  /*
   * Cargar todos los threads activos con sus entidades.
   */
  const rawThreads = db
    .select()
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  if (rawThreads.length < 2) {
    return { dryRun, candidateGroups: [], groupsProcessed: 0, details: [] };
  }

  const allThreads: ThreadWithEntities[] = rawThreads.map((t) => {
    const coverage = getThreadPerspectiveCoverage(t.id);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      state: t.state,
      countries: parseEntities(t.countries),
      actors: parseEntities(t.actors),
      domains: parseEntities(t.domains),
      tensionLevel: t.tensionLevel,
      perspectiveCount: coverage.perspectives.length,
      articleCount: coverage.totalArticles,
    };
  });

  /*
   * PASO 1: PRE-FILTRADO ESTRUCTURAL CON PONDERACIÓN IDF.
   *
   * Los países/actores que aparecen en casi todos los threads (hubs) no
   * discriminan: compartir "US" (en 17 threads) no significa nada. La señal
   * de un país compartido es INVERSAMENTE proporcional a su frecuencia
   * (tipo IDF): compartir "KZ" (en 2 threads) es señal fuerte; compartir
   * "US" es señal casi nula.
   *
   *   - Hub cutoff: países/actores en >25% de los threads activos se ignoran
   *     del todo como señal de conexión (siguen siendo dato del teatro).
   *   - Peso: weight = 1 / frecuencia del ente compartido.
   *
   * Dos threads son candidatos si:
   *   - Comparten ≥1 dominio (vocabulario cerrado)
   *   - Y su señal ponderada compartida ≥ CANDIDATE_WEIGHT_THRESHOLD
   *
   * Después, los grupos se construyen DISJUNTOS (cada thread en un grupo
   * como máximo): se ordenan los pares por peso y se van formando grupos
   * de 2-4, sin repetir threads.
   */

  const HUB_RATIO = 0.25;
  const CANDIDATE_WEIGHT_THRESHOLD = 1.0;
  const MAX_GROUP_SIZE = 3;

  const totalThreads = allThreads.length;
  const hubCutoff = totalThreads * HUB_RATIO;

  // Frecuencia de cada país/actor en los threads activos
  const countryFreq = new Map<string, number>();
  const actorFreq = new Map<string, number>();
  for (const t of allThreads) {
    for (const c of new Set(t.countries)) countryFreq.set(c, (countryFreq.get(c) ?? 0) + 1);
    for (const a of new Set(t.actors)) actorFreq.set(a, (actorFreq.get(a) ?? 0) + 1);
  }

  // Hubs: >25% de los threads → no cuentan como señal de conexión
  const countryHub = new Set([...countryFreq.entries()].filter(([, n]) => n > hubCutoff).map(([c]) => c));
  const actorHub = new Set([...actorFreq.entries()].filter(([, n]) => n > hubCutoff).map(([a]) => a));

  console.log(`   [consolidar] ${totalThreads} threads activos | hub cutoff >${Math.round(hubCutoff)} | países-hub: ${[...countryHub].join(",") || "ninguno"}`);

  /*
   * PROTECCIÓN DE TEATROS CONSOLIDADOS.
   * Un thread NO puede ser absorbido (ni participar en una fusión como
   * no-canónico) si es un teatro maduro con identidad propia:
   *   - 5+ perspectivas (bias distintos)
   *   - Más de 150 artículos asociados
   *   - tensionLevel === 5
   * Estos PUEDEN absorber a otros, pero nunca ser absorbidos ni fusionados
   * en un macro-teatro. Si un grupo contiene uno de estos, ese thread debe
   * ser el canónico o el grupo se descarta.
   */
  function isProtectedThread(t: ThreadWithEntities): boolean {
    return t.perspectiveCount >= 5 || t.articleCount > 150 || t.tensionLevel === 5;
  }
  const protectedIds = new Set(allThreads.filter(isProtectedThread).map((t) => t.id));
  if (protectedIds.size > 0) {
    console.log(`   [consolidar] ⚠️ ${protectedIds.size} teatros consolidados protegidos de ser absorbidos: ${[...protectedIds].join(",")}`);
  }

  /*
   * signalBetween — Calcula la señal ponderada entre dos threads.
   * Devuelve null si no comparten dominio, o el objeto de señal con peso.
   */
  function signalBetween(a: ThreadWithEntities, b: ThreadWithEntities) {
    const sharedDomains = a.domains.filter((d) => b.domains.includes(d));
    if (sharedDomains.length < 1) return null;

    const rareCountries = a.countries.filter((c) => b.countries.includes(c) && !countryHub.has(c));
    const rareActors = a.actors.filter((x) => b.actors.includes(x) && !actorHub.has(x));

    // Peso IDF: 1/frecuencia. Los hubs (frecuencia alta) no aportan.
    const weight =
      rareCountries.reduce((s, c) => s + 1 / (countryFreq.get(c) ?? 1), 0) +
      rareActors.reduce((s, x) => s + 1 / (actorFreq.get(x) ?? 1), 0);

    return { sharedDomains, rareCountries, rareActors, weight };
  }

  /*
   * Encontrar TODOS los pares que pasan el umbral, con su señal.
   */
  const edges: Array<{ a: number; b: number; weight: number; info: ReturnType<typeof signalBetween> }> = [];
  for (let i = 0; i < allThreads.length; i++) {
    for (let j = i + 1; j < allThreads.length; j++) {
      const s = signalBetween(allThreads[i], allThreads[j]);
      if (s && s.weight >= CANDIDATE_WEIGHT_THRESHOLD) {
        edges.push({ a: allThreads[i].id, b: allThreads[j].id, weight: s.weight, info: s });
      }
    }
  }

  /*
   * Loguear, para cada par candidato, qué entidades RARAS comparten y su peso.
   */
  const idToThread = new Map(allThreads.map((t) => [t.id, t]));
  console.log(`   [consolidar] ${edges.length} pares candidatos sobre umbral de peso ${CANDIDATE_WEIGHT_THRESHOLD}:`);
  for (const e of edges.sort((x, y) => y.weight - x.weight)) {
    const ta = idToThread.get(e.a)!;
    const tb = idToThread.get(e.b)!;
    console.log(
      `     [${e.a},${e.b}] peso=${e.weight.toFixed(2)} | dominios:${e.info!.sharedDomains.join(",")} | países raros:${e.info!.rareCountries.join(",") || "-"} | actores raros:${e.info!.rareActors.join(",") || "-"}`
    );
    console.log(`        ${ta.title.slice(0, 45)} <<>> ${tb.title.slice(0, 45)}`);
  }

  /*
   * Construcción de grupos DISJUNTOS:
   * Ordenamos los pares por peso desc. Vamos formando grupos de hasta
   * MAX_GROUP_SIZE. Cada thread pertenece a un solo grupo (si ya está en
   * uno, no se añade a otro). Los pares que unirían threads ya asignados
   * se descartan. Así garantizamos disjunción.
   */
  const sortedEdges = [...edges].sort((x, y) => y.weight - x.weight);
  const groups: number[][] = [];
  const memberOf = new Map<number, number>(); // threadId → groupIndex

  for (const e of sortedEdges) {
    const ga = memberOf.get(e.a);
    const gb = memberOf.get(e.b);

    // Ambos ya en grupos → pares incompatibles, descartar
    if (ga !== undefined && gb !== undefined) continue;

    // PROTECCIÓN: un teatro consolidado no puede ser ABSORBIDO. Solo puede
    // ser el ancla (primer elemento) de un grupo. Si está libre y no inicia
    // grupo, no se añade a un grupo existente (quedaría como no-canónico).
    // (Al aplicar, también verificamos que el modelo lo deje como canónico.)
    if (ga !== undefined) {
      // e.b es libre → solo se añade si NO está protegido (no puede ser absorbido)
      if (protectedIds.has(e.b)) continue;
      const g = groups[ga];
      if (g.length < MAX_GROUP_SIZE) {
        g.push(e.b);
        memberOf.set(e.b, ga);
      }
      continue;
    }
    if (gb !== undefined) {
      if (protectedIds.has(e.a)) continue;
      const g = groups[gb];
      if (g.length < MAX_GROUP_SIZE) {
        g.push(e.a);
        memberOf.set(e.a, gb);
      }
      continue;
    }

    // Ambos libres → nuevo grupo (el protegido va primero como ancla)
    if (protectedIds.has(e.b)) {
      groups.push([e.b, e.a]);
      memberOf.set(e.b, groups.length - 1);
      memberOf.set(e.a, groups.length - 1);
    } else {
      const idx = groups.length;
      groups.push([e.a, e.b]);
      memberOf.set(e.a, idx);
      memberOf.set(e.b, idx);
    }
  }

  const candidateGroups: Array<{ ids: number[]; titles: string[] }> = groups.map((g) => ({
    ids: g,
    titles: g.map((id) => idToThread.get(id)!.title),
  }));

  if (candidateGroups.length === 0) {
    console.log("   [consolidar] Sin grupos candidatos por solapamiento estructural.");
    return { dryRun, candidateGroups, groupsProcessed: 0, details: [] };
  }

  console.log(`   [consolidar] ${candidateGroups.length} grupos candidatos detectados:`);
  for (const g of candidateGroups) {
    console.log(`     - [${g.ids.join(", ")}] ${g.titles.join(" | ")}`);
  }

  /*
   * PASO 2: LLAMADA AL MODELO por cada grupo candidato.
   *
   * GARANTÍA DE DISJUNCIÓN AL APLICAR: aunque los grupos candidatos ya son
   * disjuntos, el modelo podría devolver grupos que reutilicen un thread (ej.
   * un thread como canónico en un grupo y como duplicado en otro). Llevamos
   * un registro de threads ya consumidos y descartamos cualquier fusión que
   * los reutilice.
   */
  const consumed = new Set<number>(); // threads ya fusionados (canónico o absorbido)
  const details: Array<{
    canonical: number;
    newTitle: string;
    merged: number[];
    mergedState: string | null;
  }> = [];

  for (const group of candidateGroups) {
    const groupThreads: ConsolidatorThread[] = group.ids.map((id) => {
      const t = idToThread.get(id)!;
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        state: t.state,
        countries: t.countries,
        actors: t.actors,
        domains: t.domains,
        tensionLevel: t.tensionLevel,
      };
    });

    let mergeGroups;
    try {
      mergeGroups = await findDuplicateThreads({ threads: groupThreads });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   [consolidar] Grupo [${group.ids.join(", ")}] FALLÓ al llamar al modelo: ${msg}`);
      continue;
    }

    for (const mg of mergeGroups.mergeGroups) {
      const canonical = mg.canonical;
      const duplicates = mg.duplicates.filter((d) => d !== canonical);
      if (duplicates.length === 0) continue;

      const canonThread = idToThread.get(canonical);
      if (!canonThread) continue;

      /*
       * DISJUNCIÓN: si cualquiera de los threads del grupo de fusión ya fue
       * consumido por otro grupo, descartamos esta fusión (ambiguidad).
       */
      const allInvolved = [canonical, ...duplicates];
      if (allInvolved.some((id) => consumed.has(id))) {
        console.log(`   [consolidar] ⚠️ Fusión ${allInvolved.join(",")} descartada: thread ya asignado a otra fusión`);
        continue;
      }

      /*
       * PROTECCIÓN AL APLICAR: un teatro consolidado (protegido) NO puede ser
       * absorbido. Si el modelo lo dejó como no-canónico, descartamos la fusión.
       * Puede ser canónico (absorbiendo a otros), eso sí está permitido.
       */
      if (duplicates.some((id) => protectedIds.has(id))) {
        const prot = duplicates.filter((id) => protectedIds.has(id));
        console.log(`   [consolidar] ⚠️ Fusión descartada: teatro protegido ${prot.join(",")} sería absorbido (solo puede ser canónico)`);
        continue;
      }

      console.log(`   [consolidar] FUSIONAR ${duplicates.length} en ${canonical} (${canonThread.title})`);

      /*
       * PASO 3: FUSIÓN DE STATES — integrar la memoria de todos los del grupo.
       */
      let mergedState: string | null = null;
      try {
        const allInGroup = [canonical, ...duplicates].map((id) => {
          const t = idToThread.get(id)!;
          return { id: t.id, title: t.title, state: t.state };
        });
        const r = await mergeThreadStates({ threads: allInGroup });
        mergedState = r.mergedState;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`   [consolidar] FUSIÓN DE STATE FALLÓ para ${canonical}: ${msg}`);
      }

      /*
       * PASO 4: TÍTULO NUEVO para el teatro ampliado.
       */
      let newTitle = mg.suggestedTitle ?? canonThread.title;
      try {
        if (mergedState) {
          const proposed = await proposeMergedTitle({
            titles: [canonical, ...duplicates].map((id) => idToThread.get(id)!.title),
            mergedState,
          });
          if (proposed) newTitle = proposed;
        }
      } catch (err) {
        console.error(`   [consolidar] Propuesta de título falló para ${canonical}, usando sugerido.`);
      }

      if (dryRun) {
        console.log(`     (dry-run) Nuevo título: "${newTitle}" | state unificado: ${mergedState ? mergedState.length + " chars" : "N/A"}`);
      details.push({ canonical, newTitle, merged: duplicates, mergedState });
      for (const id of allInvolved) consumed.add(id);
        for (const id of allInvolved) consumed.add(id);
        continue;
      }

      /*
       * PASO 5: APLICAR.
       */
      // Reasignar article_threads de los duplicados al canónico
      for (const dupId of duplicates) {
        const links = db
          .select({ articleId: articleThreads.articleId })
          .from(articleThreads)
          .where(eq(articleThreads.threadId, dupId))
          .all();
        for (const link of links) {
          db.insert(articleThreads)
            .values({ articleId: link.articleId, threadId: canonical })
            .onConflictDoNothing()
            .run();
        }
      }

      // Reasignar events y analyses
      for (const dupId of duplicates) {
        db.update(events).set({ threadId: canonical }).where(eq(events.threadId, dupId)).run();
        db.update(analyses).set({ threadId: canonical }).where(eq(analyses.threadId, dupId)).run();
      }

      // Actualizar el canónico: title, state, updatedAt
      const canonUpdate: Record<string, unknown> = {
        title: newTitle,
        updatedAt: new Date().toISOString(),
      };
      if (mergedState) canonUpdate.state = mergedState;

      /*
       * RECÁLCULO DE ENTIDADES con extractEntities() sobre el state nuevo.
       */
      try {
        const entities = await extractEntities({
          threadTitle: newTitle,
          threadState: mergedState ?? canonThread.state,
          verdict: null,
        });
        canonUpdate.countries = JSON.stringify(entities.countries);
        canonUpdate.actors = JSON.stringify(entities.actors);
        canonUpdate.domains = JSON.stringify(entities.domains);
        canonUpdate.tensionLevel = entities.tensionLevel;
      } catch (err) {
        console.error(`   [consolidar] Recálculo de entidades falló para ${canonical}: ${err}`);
      }

      db.update(threads).set(canonUpdate).where(eq(threads.id, canonical)).run();

      // Desactivar duplicados (NUNCA borrar)
      db.update(threads).set({ active: false }).where(inArray(threads.id, duplicates)).run();

      details.push({ canonical, newTitle, merged: duplicates, mergedState });
    }
  }

  return { dryRun, candidateGroups, groupsProcessed: details.length, details };
}
