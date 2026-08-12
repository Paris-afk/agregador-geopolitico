import { extractFromHtml } from "@extractus/article-extractor";
import { db } from "./db/index";
import { articles } from "./db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

/*
 * ============================================================================
 * SCRAPING QUIRÚRGICO — Texto completo de artículos clave.
 * ============================================================================
 *
 * NO es extracción masiva. Solo se extrae el texto completo de los artículos
 * que el analista necesita (los 2 nuevos más recientes de cada hilo, o los 3
 * primeros de un hilo sin state previo). El resto entra con título+snippet.
 *
 * Usamos la resolvedUrl que ya guardamos en la fase de imágenes (incluye los
 * redirects de Google News resueltos). Si resolvedUrl es null o sigue siendo
 * de news.google.com, NO intentamos extraer — marcamos fullTextFetchedAt y
 * seguimos (el scraper se quedaría en la página intermedia de Google).
 *
 * Salvaguardas (mismas que images.ts):
 *   - Timeout 8s por petición.
 *   - User-Agent de navegador.
 *   - Best-effort: un fallo marca fullTextFetchedAt y continúa.
 *   - Truncamos a ~8000 caracteres para no inflar los tokens.
 */

const TIMEOUT_MS = 8_000;
const MAX_TEXT_CHARS = 8_000;

/*
 * extractFullText — Extrae el texto limpio de un artículo desde resolvedUrl.
 * Devuelve el texto truncado, o null si falla / no hay URL válida.
 */
async function extractFullText(resolvedUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    /*
     * fetch() propio para tener timeout (8s) y User-Agent de navegador.
     * Pasamos el resultado como HTML a extractFromHtml para extraer el
     * cuerpo limpio sin descargar la página dos veces.
     */
    const res = await fetch(resolvedUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
    });
    if (!res.ok) return null;

    const html = await res.text();
    if (html.length < 200) return null;

    const result = await extractFromHtml(html, resolvedUrl);
    const text = result?.content ? result.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

    if (text.length < 80) return null; // demasiado corto = extracción falló

    return text.slice(0, MAX_TEXT_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/*
 * extractTextsForArticles — Dado un array de { id, resolvedUrl }, extrae el
 * texto completo de cada uno (concurrencia limitada, best-effort) y lo guarda
 * en fullText. Marca fullTextFetchedAt en todos los intentados.
 *
 * Devuelve cuántos caracteres extra se enviarán al analista (para el log de
 * coste) y cuántos artículos se ampliaron.
 */
export async function extractTextsForArticles(
  targets: Array<{ id: number; resolvedUrl: string | null }>
): Promise<{ expanded: number; extraChars: number }> {
  const now = new Date().toISOString();
  const CONCURRENCY = 5;
  let cursor = 0;
  let expanded = 0;
  let extraChars = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) break;

      const target = targets[idx];

      /*
       * Sin resolvedUrl o sigue siendo Google News → no intentamos.
       * El scraper se quedaría en la página intermedia de Google.
       * Marcamos fullTextFetchedAt para no reintentarlo.
       */
      if (!target.resolvedUrl || target.resolvedUrl.includes("news.google.com")) {
        db.update(articles)
          .set({ fullTextFetchedAt: now })
          .where(eq(articles.id, target.id))
          .run();
        continue;
      }

      const text = await extractFullText(target.resolvedUrl);

      if (text) {
        db.update(articles)
          .set({ fullText: text, fullTextFetchedAt: now })
          .where(eq(articles.id, target.id))
          .run();
        expanded++;
        extraChars += text.length;
      } else {
        db.update(articles)
          .set({ fullTextFetchedAt: now })
          .where(eq(articles.id, target.id))
          .run();
      }
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  return { expanded, extraChars };
}

/*
 * getFullTextForArticles — Recupera los fullText ya guardados en BD para un
 * set de articleIds, para inyectarlos en el input del analista.
 */
export function getFullTextForArticles(articleIds: number[]): Map<number, string> {
  if (articleIds.length === 0) return new Map();
  const map = new Map<number, string>();
  const rows = db
    .select({ id: articles.id, fullText: articles.fullText })
    .from(articles)
    .where(
      sql`${articles.id} IN (${sql.join(articleIds.map((id) => sql`${id}`), sql`, `)}) AND ${articles.fullText} IS NOT NULL`
    )
    .all();
  for (const r of rows) {
    if (r.fullText) map.set(r.id, r.fullText);
  }
  return map;
}
