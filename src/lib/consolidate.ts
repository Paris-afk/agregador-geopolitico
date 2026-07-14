import { db } from "./db/index";
import { threads, articleThreads, events, analyses } from "./db/schema";
import { eq, inArray } from "drizzle-orm";
import { findDuplicateThreads } from "./deepseek";
import type { MergeGroup } from "./deepseek";

/*
 * consolidateThreads — Orquesta la fusión de hilos semánticamente duplicados.
 *
 * Flujo:
 *   1. Carga todos los threads activos (id, title, description).
 *   2. Se los pasa a findDuplicateThreads() (DeepSeek, sin thinking, temp 0.2)
 *      que devuelve grupos de hilos a fusionar.
 *   3. Para cada MergeGroup:
 *      a) Reasigna los article_threads de los duplicados al canónico,
 *         usando onConflictDoNothing por si un artículo ya estaba vinculado
 *         a ambos hilos (PK compuesta evita el duplicado).
 *      b) Reasigna los events de los duplicados al canónico (UPDATE threadId).
 *      c) Reasigna los analyses de los duplicados al canónico (UPDATE threadId).
 *      d) Marca los duplicados como active=false.
 *         NO LOS BORRAMOS: si la fusión fue incorrecta, un operador puede
 *         reactivar el hilo y deshacer manualmente. Borrar sería irreversible.
 *   4. Devuelve un resumen de qué hilos se fusionaron en cuáles.
 *
 * Por qué active=false y no DELETE:
 *   - La fusión automática puede equivocarse (DeepSeek no es infalible).
 *   - Si un hilo se desactiva por error, un humano puede reactivarlo y
 *     reasignar sus artículos/events/analyses de vuelta.
 *   - Si se borrara, perderíamos el historial de ids y sería mucho más
 *     difícil recuperar la información.
 *   - En analítica, preservar datos es siempre preferible a destruirlos.
 *
 * Por qué la consolidación es un paso SEPARADO de la clasificación:
 *   - classifyUnassignedArticles mira ARTÍCULOS y decide a qué hilo van.
 *   - consolidateThreads mira HILOS y detecta sinónimos entre ellos.
 *   - Son dos tipos de razonamiento distintos. Ponerlos en un solo prompt
 *     obligaría al modelo a hacer dos tareas diferentes simultáneamente,
 *     degradando la calidad de ambas.
 *   - Además, la consolidación se ejecuta con menos frecuencia (tras crear
 *     varios hilos nuevos), así que mantenerlos separados ahorra tokens.
 */
export async function consolidateThreads(): Promise<{
  groupsProcessed: number;
  details: Array<{ canonical: number; canonicalTitle: string; merged: number[] }>;
}> {
  const allThreads = db
    .select({
      id: threads.id,
      title: threads.title,
      description: threads.description,
    })
    .from(threads)
    .where(eq(threads.active, true))
    .all();

  if (allThreads.length < 2) {
    return { groupsProcessed: 0, details: [] };
  }

  const { mergeGroups } = await findDuplicateThreads({ threads: allThreads });

  if (mergeGroups.length === 0) {
    return { groupsProcessed: 0, details: [] };
  }

  /*
   * Creamos un mapa id → título para el resumen final.
   */
  const titleMap = new Map(allThreads.map((t) => [t.id, t.title]));

  const details: Array<{ canonical: number; canonicalTitle: string; merged: number[] }> = [];

  for (const group of mergeGroups) {
    const { canonical, duplicates } = group;

    if (duplicates.length === 0) continue;

    /*
     * Si DeepSeek sugirió un título mejor para el teatro estratégico
     * completo, actualizamos el título del hilo canónico.
     */
    if (group.suggestedTitle) {
      db.update(threads)
        .set({ title: group.suggestedTitle })
        .where(eq(threads.id, canonical))
        .run();
    }

    /*
     * Reasignar article_threads: mover todos los vínculos de los duplicados
     * al hilo canónico. onConflictDoNothing maneja el caso donde un artículo
     * ya estaba vinculado a ambos hilos.
     */
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

    /*
     * Reasignar events y analyses: UPDATE threadId de los duplicados al
     * canónico. Esto es directo porque son FK simples.
     */
    for (const dupId of duplicates) {
      db.update(events)
        .set({ threadId: canonical })
        .where(eq(events.threadId, dupId))
        .run();

      db.update(analyses)
        .set({ threadId: canonical })
        .where(eq(analyses.threadId, dupId))
        .run();
    }

    /*
     * Desactivar los duplicados (NO borrar).
     */
    db.update(threads)
      .set({ active: false })
      .where(inArray(threads.id, duplicates))
      .run();

  details.push({
      canonical,
      canonicalTitle: group.suggestedTitle ?? titleMap.get(canonical) ?? "(desconocido)",
      merged: duplicates,
    });
  }

  return {
    groupsProcessed: mergeGroups.length,
    details,
  };
}
