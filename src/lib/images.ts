import { db } from "./db/index";
import { articles, sources } from "./db/schema";
import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";

/*
 * ============================================================================
 * RECUPERACIÓN DE IMÁGENES PARA ARTÍCULOS
 * ============================================================================
 *
 * Dos niveles de extracción:
 *
 * NIVEL 1 (gratis, sin red extra) — lo hace rss.ts durante la ingesta:
 *   Muchos feeds RSS ya traen la imagen en <enclosure>, <media:content> o
 *   <media:thumbnail>. rss.ts los captura con customFields y los guarda
 *   directamente en imageUrl. Sin peticiones adicionales.
 *
 * NIVEL 2 (fetch de la página) — este módulo:
 *   Si el feed no trajo imagen, descargamos la página del artículo y
 *   extraemos el meta tag og:image (con twitter:image como alternativa).
 *
 * DIAGNÓSTICO DE BUGS (corrida 20:04 y 20:53):
 *
 * BUG 1 — Falso positivo de resolución:
 *   fetchGoogleNewsOutbound() devolvía la URL de Google News (el data-attr
 *   data-n-au es relativo y resuelve a news.google.com), y resolveRealUrl()
 *   la retornaba sin comprobación final. Además, el worker guardaba
 *   resolvedUrl = realUrl aunque fuera de Google (el filtro bloqueaba el
 *   logo de la imagen, pero la URL envenenada se escribía igual).
 *   FIX: resolveRealUrl() y fetchGoogleNewsOutbound() NUNCA devuelven una
 *   URL de news.google.com. El worker solo guarda resolvedUrl si la URL
 *   real es genuinamente no-Google. El contador refleja la realidad.
 *
 * BUG 2 — Fase de 0,4s sin peticiones:
 *   Google devolvió 429/403 al instante (rate-limit tras las ~300 peticiones
 *   de clean-images), así que fetchGoogleNewsOutbound() fallaba rápido y
 *   devolvía null. Se marcaba imageFetchedAt sin resolver nada.
 *   FIX: logging por artículo con el código HTTP exacto para detectar
 *   rate-limiting frente a errores de código.
 *
 * REGLA DE ORO: es preferible NO tener imagen a guardar un logo de Google
 * o una URL envenenada. No queremos más "éxitos" que no lo son.
 */

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const MIN_IMAGE_WIDTH = 400;

const GOOGLE_NEWS_HOST = "news.google.com";

export function isGoogleNewsUrl(u: string): boolean {
  try {
    return new URL(u).hostname === GOOGLE_NEWS_HOST;
  } catch {
    return u.includes("news.google.com");
  }
}

/*
 * decodeGoogleNewsUrl — Intenta decodificar el identificador base64 de una
 * URL news.google.com/rss/articles/CBMi... para extraer la URL original.
 *
 * OJO (diag): en el formato actual de Google News, el payload decodificado
 * NO contiene "http" en claro (verificado: 175 bytes sin "http"). Esta
 * estrategia suele fallar con el formato nuevo. Se intenta pero no se
 * asume éxito.
 */
function decodeGoogleNewsUrl(url: string): string | null {
  const m = url.match(/\/articles\/([A-Za-z0-9_-]+)/);
  if (!m) return null;

  let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return null;
  }

  const text = Buffer.from(bytes).toString("latin1");
  const start = text.indexOf("http");
  if (start === -1) return null;

  const candidate = text.slice(start).match(/^https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%%]+/);
  if (!candidate) return null;

  const real = candidate[0];
  if (isGoogleNewsUrl(real)) return null;
  return real;
}

/*
 * fetchGoogleNewsOutbound — Estrategia (c): descarga la página intermedia
 * de Google News y extrae el enlace de salida al artículo real.
 *
 * Devuelve { url, httpStatus } para logging. NUNCA devuelve una URL de
 * news.google.com: si el data-attr resuelve a Google, se descarta.
 */
async function fetchGoogleNewsOutbound(
  googleUrl: string
): Promise<{ url: string | null; httpStatus: number | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(googleUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      // Ej: 429 Too Many Requests (rate-limit), 403 Forbidden
      return { url: null, httpStatus: res.status };
    }

    const html = await res.text();

    // <a href="https://real...">
    const anchor = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
    if (anchor?.[1] && !isGoogleNewsUrl(anchor[1])) {
      return { url: anchor[1], httpStatus: res.status };
    }

    // data-attributes de salida — OJO: suelen ser RELATIVOS (resuelven a
    // news.google.com). Solo los aceptamos si el resultado NO es Google.
    const dataAttr = html.match(/data-(?:n-au|ct-url|url)=["']([^"']+)["']/i)?.[1];
    if (dataAttr) {
      try {
        const absolute = new URL(dataAttr, googleUrl).toString();
        if (!isGoogleNewsUrl(absolute)) return { url: absolute, httpStatus: res.status };
      } catch {
        return { url: null, httpStatus: res.status };
      }
    }

    return { url: null, httpStatus: res.status };
  } catch {
    // Timeout (AbortError) u error de red — res no disponible
    return { url: null, httpStatus: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

/*
 * resolveRealUrl — Devuelve la URL real del artículo a partir de la URL de
 * Google News, con un trace de qué se intentó (para logging honesto).
 *
 * Orden:
 *   a) resolvedUrl ya conocida (del feed, capturada por rss.ts).
 *   b) Si la URL no es Google, es la URL real directamente.
 *   c) Decodificar el base64 de la URL de Google News.
 *   d) Descargar la página intermedia y buscar el enlace de salida.
 *
 * REGLA DURA: el resultado NUNCA puede ser una URL de news.google.com.
 * Si tras todas las estrategias sigue siendo Google o no hay resultado,
 * devuelve { url: null, ... } — se cuenta como SIN RESOLVER.
 */
export async function resolveRealUrl(
  articleUrl: string,
  knownResolved: string | null
): Promise<{ url: string | null; trace: string[]; httpStatus: number | null }> {
  const trace: string[] = [];

  // a) Ya resuelta (gratis, capturada en ingesta)
  if (knownResolved) {
    if (isGoogleNewsUrl(knownResolved)) {
      trace.push("knownResolved=DESCARTADA(es Google)");
    } else {
      trace.push("knownResolved=usada");
      return { url: knownResolved, trace, httpStatus: null };
    }
  } else {
    trace.push("knownResolved=null");
  }

  // b) URL no-Google = directa
  if (!isGoogleNewsUrl(articleUrl)) {
    trace.push("url=directa(no Google)");
    return { url: articleUrl, trace, httpStatus: null };
  }
  trace.push("url=Google News");

  // c) Decodificar base64
  const decoded = decodeGoogleNewsUrl(articleUrl);
  if (decoded) {
    trace.push("decode=OK");
    return { url: decoded, trace, httpStatus: null };
  }
  trace.push("decode=sin-URL-en-payload");

  // d) Descargar página intermedia
  trace.push("fetch-page=...");
  const outbound = await fetchGoogleNewsOutbound(articleUrl);
  if (outbound.url) {
    trace.push(`fetch-page=OK(http ${outbound.httpStatus})`);
    return { url: outbound.url, trace, httpStatus: outbound.httpStatus };
  }
  trace.push(`fetch-page=sin-salida(http ${outbound.httpStatus ?? "n/a"})`);

  return { url: null, trace, httpStatus: outbound.httpStatus };
}

/*
 * isGarbageImage — ARREGLO 1: descarta imágenes que claramente no son del
 * artículo (logos, placeholders, favicons, dominios de Google).
 */
export function isGarbageImage(imageUrl: string, ogWidth: number | null): boolean {
  if (ogWidth !== null && ogWidth < MIN_IMAGE_WIDTH) return true;

  try {
    const u = new URL(imageUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    if (host === "google.com" || host.endsWith(".google.com")) return true;
    if (host === "gstatic.com" || host.endsWith(".gstatic.com")) return true;
    if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) return true;
    if (/(logo|default|placeholder|fallback|icon|favicon|spinner|loader)/.test(path)) return true;
  } catch {
    return false;
  }

  return false;
}

/*
 * fetchPageOgImage — Descarga la página del artículo (URL real) y extrae
 * la imagen Open Graph. Aplica el filtro de imágenes basura.
 *
 * Devuelve { image, resolvedUrl } o null si no hay imagen / falla / basura.
 * El status HTTP se devuelve en el objeto de éxito para logging.
 */
export async function fetchPageOgImage(
  url: string
): Promise<{ image: string; resolvedUrl: string; httpStatus: number | null } | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
    });

    if (!res.ok) return null;

    const resolvedUrl = res.url;
    const html = await res.text();
    if (html.length < 200) return null;

    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ];

    let image: string | null = null;
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        image = m[1];
        break;
      }
    }

    if (!image) return null;

    const widthMatch = html.match(/<meta[^>]+property=["']og:image:width["'][^>]+content=["'](\d+)["']/i);
    const ogWidth = widthMatch ? parseInt(widthMatch[1], 10) : null;

    let absolute: string;
    try {
      absolute = new URL(image, resolvedUrl).toString();
    } catch {
      return null;
    }

    if (isGarbageImage(absolute, ogWidth)) return null;

    return { image: absolute, resolvedUrl, httpStatus: res.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/*
 * extractImagesForArticles — Procesa las imágenes de los artículos nuevos
 * de una corrida de ingesta.
 *
 * Logging HONESTO por artículo:
 *   - URL original y fuente (sourceName)
 *   - Qué estrategia se intentó y resultado de cada una (trace)
 *   - Código HTTP exacto en fallos de red (429/403/etc.)
 *   - Si se salta sin intentar: por qué (sin resolvedUrl, o ya intentado)
 *
 * Contadores que reflejan la realidad: googleResolved solo cuenta si la
 * URL real es genuinamente no-Google. Nunca cuenta un logo envenenado.
 */
export async function extractImagesForArticles(since: string): Promise<{
  fromFeed: number;
  fromPage: number;
  failed: number;
  googleResolved: number;
  googleUnresolved: number;
}> {
  const now = new Date().toISOString();

  const feedSourced = (
    db
      .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(articles)
      .where(and(sql`${articles.fetchedAt} >= ${since}`, isNotNull(articles.imageUrl)))
      .get()
  )?.count ?? 0;

  /*
   * Artículos que necesitan NIVEL 2, con sourceName para logging.
   */
  const pending = db
    .select({
      id: articles.id,
      url: articles.url,
      resolvedUrl: articles.resolvedUrl,
      sourceName: sources.name,
    })
    .from(articles)
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(
      and(
        sql`${articles.fetchedAt} >= ${since}`,
        isNull(articles.imageUrl),
        isNull(articles.imageFetchedAt)
      )
    )
    .limit(150)
    .all();

  if (pending.length > 0) {
    console.log(`   Procesando ${pending.length} artículos para imágenes (fase 1b)...`);
  }

  let fromPage = 0;
  let failed = 0;
  let googleResolved = 0;
  let googleUnresolved = 0;

  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= pending.length) break;

      const article = pending[idx];
      const isGoogle = isGoogleNewsUrl(article.url);

      /*
       * Resolver la URL real (nunca devuelve Google; puede devolver null).
       */
      const res = await resolveRealUrl(article.url, article.resolvedUrl);
      const realUrl = res.url;

      if (isGoogle) {
        if (realUrl) googleResolved++;
        else googleUnresolved++;
      }

      /*
       * LOG HONESTO por artículo.
       */
      const sourceTag = `[${article.sourceName}]`;
      if (isGoogle) {
        console.log(
          `      ${sourceTag} id=${article.id} Google: ${res.trace.join(" → ")} ${realUrl ? "→ RESUELTO" : "→ SIN RESOLVER"}`
        );
      } else if (!realUrl) {
        console.log(`      ${sourceTag} id=${article.id} directo sin resolvedUrl → sin intento`);
      }

      const result = realUrl ? await fetchPageOgImage(realUrl) : null;

      if (result) {
        db.update(articles)
          .set({
            imageUrl: result.image,
            resolvedUrl: result.resolvedUrl,
            imageFetchedAt: now,
          })
          .where(eq(articles.id, article.id))
          .run();
        fromPage++;
      } else {
        /*
         * Fallo o sin imagen. SOLO guardamos resolvedUrl si la URL real es
         * genuinamente no-Google (nunca una URL envenenada). imageUrl null.
         */
        const safeResolved = realUrl && !isGoogleNewsUrl(realUrl) ? realUrl : null;
        db.update(articles)
          .set({
            ...(safeResolved ? { resolvedUrl: safeResolved } : {}),
            imageFetchedAt: now,
          })
          .where(eq(articles.id, article.id))
          .run();
        failed++;
      }
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  return { fromFeed: feedSourced, fromPage, failed, googleResolved, googleUnresolved };
}
