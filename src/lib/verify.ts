import { db } from "./db/index";
import { articles, sources, articleThreads, threadLinks } from "./db/schema";
import { eq, sql } from "drizzle-orm";

/*
 * ============================================================================
 * VERIFICACIÓN FACTUAL — PASO 2 del ciclo de refutación.
 * ============================================================================
 *
 * Antes de refutar una predicción, comprobamos los hechos contra la propia
 * base de datos:
 *   1. Extraemos las afirmaciones fácticas clave del predictionStatement y
 *      del summary (hechos concretos, no interpretaciones).
 *   2. Para cada una, buscamos corroboración en artículos de OTRAS
 *      perspectivas (bias distinto) que mencionen el mismo hecho, en este
 *      teatro o en teatros conectados vía thread_links.
 *   3. Devolvemos, por afirmación: en cuántas perspectivas distintas aparece,
 *      cuáles, y si hay artículos que la confirmen o contradigan.
 *
 * El resultado alimenta la llamada del abogado del diablo (redteam.ts) para
 * que el refutador sepa si la predicción descansa en una sola voz.
 */

type VerificationResult = {
  claims: Array<{
    claim: string;
    perspectiveCount: number;
    perspectives: string[];
    corroboratingArticles: number;
  }>;
  maxPerspectives: number;
  isSingleSource: boolean;
  total: string;
};

/*
 * extractClaims — Divide el texto en afirmaciones fácticas por frases
 * terminadas (heurística simple: separar por ". " y ".\n").
 * Devuelve hasta 5 afirmaciones con más de 40 caracteres.
 */
export function extractClaims(...texts: (string | null | undefined)[]): string[] {
  const combined = texts.filter((t) => t).join(". ");
  const sentences = combined
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && !s.toLowerCase().includes("predicción") && !s.toLowerCase().includes("se considerará falsada"));
  return sentences.slice(0, 5);
}

/*
 * keywordSet — Convierte una frase en palabras clave (las 3-6 palabras más
 * significativas: ignora stopwords y palabras cortas).
 */
const STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a", "en", "y", "o", "que", "con", "por", "para", "se", "su", "sus", "como", "más", "mas", "entre", "sobre", "hacia", "desde", "hasta", "es", "son", "está", "están", "tiene", "tienen", "hay", "fue", "ser", "cual", "esta", "este", "esto", "ya", "no", "sí", "sin", "tras", "durante", "contra", "ante", "según",
]);

function keywordSet(text: string): string[] {
  const words = text.toLowerCase().replace(/[^\w\sáéíóúñü]/g, " ").split(/\s+/);
  return [...new Set(words.filter((w) => w.length > 3 && !STOPWORDS.has(w)))].slice(0, 6);
}

/*
 * verifyPredictionFacts — Verifica las afirmaciones de una predicción contra
 * la base de datos.
 *
 * Para cada afirmación, busca artículos en este teatro Y en los teatros
 * conectados que contengan al menos 2 de las palabras clave en title/content,
 * agrupados por perspectiva (bias) distinta.
 */
export function verifyPredictionFacts(input: {
  statement: string;
  summary: string;
  threadId: number;
  contextThreadIds: number[];
}): VerificationResult {
  const claims = extractClaims(input.statement, input.summary);

  // IDs de teatro a buscar: el actual + los conectados
  const targetThreadIds = [input.threadId, ...input.contextThreadIds.filter((id) => id !== input.threadId)];

  // Mapa de afirmación → { perspectiva → cuenta }
  const claimDetails = claims.map((claim) => {
    const keywords = keywordSet(claim);
    if (keywords.length === 0) {
      return { claim, perspectiveCount: 0, perspectives: [], corroboratingArticles: 0 };
    }

    // Buscar artículos de los teatros objetivo que contengan ≥2 keywords
    const rows = db
      .select({
        bias: sources.bias,
        title: articles.title,
      })
      .from(articleThreads)
      .innerJoin(articles, eq(articleThreads.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(
        sql`${articleThreads.threadId} IN (${sql.join(targetThreadIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .all();

    const byPerspective = new Map<string, number>();
    let matches = 0;
    for (const r of rows) {
      const hitCount = keywords.filter((kw) => {
        const titleLower = r.title.toLowerCase();
        return titleLower.includes(kw);
      }).length;
      if (hitCount >= 2) {
        matches++;
        byPerspective.set(r.bias, (byPerspective.get(r.bias) ?? 0) + 1);
      }
    }

    return {
      claim,
      perspectiveCount: byPerspective.size,
      perspectives: [...byPerspective.keys()],
      corroboratingArticles: matches,
    };
  });

  const summary = claimDetails.length
    ? claimDetails
        .map(
          (c) =>
            `- "${c.claim.slice(0, 120)}" → corroborado en ${c.perspectiveCount} perspectiva(s) [${c.perspectives.join(", ") || "ninguna"}] (${c.corroboratingArticles} artículos)`
        )
        .join("\n")
    : "No se pudieron extraer afirmaciones concretas.";

  const maxPerspectives = claimDetails.length ? Math.max(...claimDetails.map((c) => c.perspectiveCount)) : 0;
  const isSingleSource = maxPerspectives <= 1;

  return {
    claims: claimDetails,
    maxPerspectives,
    isSingleSource,
    total: summary,
  };
}

/*
 * getContextThreadIds — Devuelve los ids de los teatros conectados al actual
 * vía thread_links (para ampliar la búsqueda de corroboración).
 */
export function getContextThreadIds(threadId: number): number[] {
  const links = db
    .select({ threadA: threadLinks.threadA, threadB: threadLinks.threadB })
    .from(threadLinks)
    .where(sql`${threadLinks.threadA} = ${threadId} OR ${threadLinks.threadB} = ${threadId}`)
    .all();
  return links.map((l) => (l.threadA === threadId ? l.threadB : l.threadA));
}
