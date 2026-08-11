import { db } from "./db/index";
import { articles } from "./db/schema";
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
 *   <media:thumbnail>. rss.ts los captura con customFields de rss-parser y
 *   los guarda directamente en imageUrl. Sin peticiones adicionales.
 *
 * NIVEL 2 (fetch de la página) — este módulo:
 *   Si el feed no trajo imagen, descargamos la página del artículo y
 *   extraemos el meta tag og:image (con twitter:image como alternativa).
 *   Guardamos la URL real resuelta en resolvedUrl.
 *
 * PROBLEMA RESUELTO (ARREGLO 2): Google News (4 de 6 fuentes) NO redirige
 * por HTTP sino por JavaScript. fetch + redirect:"follow" se quedaba en la
 * página intermedia de Google y extraía su og:image (el logo). Ahora:
 *   a) rss.ts ya captura la URL real de description/guid/source (gratis).
 *   b) Si no la hay, intentamos decodificar la URL base64 de
 *      news.google.com/rss/articles/CBMi... para extraer la URL original.
 *   c) Como último recurso, descargamos la página de Google News y buscamos
 *      el enlace de salida al artículo real.
 *   Guardamos la URL real en resolvedUrl y usamos ESA para og:image.
 *
 * FILTRO DE IMÁGENES BASURA (ARREGLO 1): descartamos imágenes que no son
 * del artículo: dominio google, logos, placeholders, icons, o <400px.
 * Es mejor NO tener imagen que un logo de Google repetido en cada tarjeta.
 *
 * ROBUSTEZ (corre cada noche sobre ~175 artículos):
 *   - Timeout de 8s por petición.
 *   - Concurrencia limitada a 5 peticiones paralelas (worker pool).
 *   - Best-effort: si un artículo falla, se deja imageUrl=null y se marca
 *     imageFetchedAt para no reintentarlo infinitamente.
 *   - Un fallo de imagen NUNCA rompe la ingesta.
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
 * decodeGoogleNewsUrl — Estrategia (b): decodifica el identificador base64
 * de una URL news.google.com/rss/articles/CBMi... para extraer la URL real.
 *
 * El segmento tras /articles/ es base64 de un protobuf que contiene la URL
 * original del artículo. Lo decodificamos a bytes y buscamos una cadena
 * "http(s)://" válida dentro del payload.
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

  // Buscar "http" en los bytes y leer hasta un carácter no-URL.
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
 * La página suele incluir un <a href="https://real..." ...> de salida o un
 * data-attribute con el destino. Buscamos el primer <a href="http..."> que
 * NO sea de Google.
 */
async function fetchGoogleNewsOutbound(googleUrl: string): Promise<string | null> {
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
    if (!res.ok) return null;

    const html = await res.text();

    // <a href="https://real...">
    const anchor = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
    if (anchor?.[1] && !isGoogleNewsUrl(anchor[1])) return anchor[1];

    // data-attributes de salida (data-n-au, data-ct-url, etc.)
    const dataAttr =
      html.match(/data-(?:n-au|ct-url|url)=["'](https?:\/\/[^"']+)["']/i)?.[1] ??
      html.match(/data-(?:n-au|ct-url|url)=["'](\/[^"']+)["']/i)?.[1];
    if (dataAttr) {
      try {
        return new URL(dataAttr, googleUrl).toString();
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/*
 * resolveRealUrl — Devuelve la URL real del artículo a partir de la URL
 * de Google News. Orden:
 *   a) resolvedUrl ya conocida (del feed, capturada por rss.ts).
 *   b) decodificar el base64 de la URL de Google News.
 *   c) descargar la página intermedia y buscar el enlace de salida.
 * Devuelve null si no se pudo resolver.
 */
export async function resolveRealUrl(articleUrl: string, knownResolved: string | null): Promise<string | null> {
  // a) Ya resuelta (gratis, capturada en ingesta)
  if (knownResolved && !isGoogleNewsUrl(knownResolved)) return knownResolved;

  // Si la URL no es de Google News, es la URL real directamente
  if (!isGoogleNewsUrl(articleUrl)) return articleUrl;

  // b) Decodificar el identificador base64
  const decoded = decodeGoogleNewsUrl(articleUrl);
  if (decoded) return decoded;

  // c) Descargar la página intermedia y buscar el enlace de salida
  return fetchGoogleNewsOutbound(articleUrl);
}

/*
 * isGarbageImage — ARREGLO 1: descarta imágenes que claramente no son del
 * artículo (logos, placeholders, favicons, dominios de Google).
 */
export function isGarbageImage(imageUrl: string, ogWidth: number | null): boolean {
  // Imágenes demasiado pequeñas (menos de 400px) suelen ser logos/icons
  if (ogWidth !== null && ogWidth < MIN_IMAGE_WIDTH) return true;

  try {
    const u = new URL(imageUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Dominios de Google (logos, assets estáticos)
    if (host === "google.com" || host.endsWith(".google.com")) return true;
    if (host === "gstatic.com" || host.endsWith(".gstatic.com")) return true;
    if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) return true;

    // Patrones de logo/placeholder en la ruta
    if (/(logo|default|placeholder|fallback|icon|favicon|spinner|loader)/.test(path)) return true;
  } catch {
    return false;
  }

  return false;
}

/*
 * fetchPageOgImage — Descarga la página de un artículo y extrae la imagen
 * Open Graph. Aplica el filtro de imágenes basura.
 *
 * Returns: { image, resolvedUrl } o null si no hay imagen / falla / es basura.
 */
export async function fetchPageOgImage(url: string): Promise<{ image: string; resolvedUrl: string } | null> {
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

    // Extraer og:image / twitter:image
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

    // Ancho declarado (og:image:width) para descartar logos/icons
    const widthMatch = html.match(/<meta[^>]+property=["']og:image:width["'][^>]+content=["'](\d+)["']/i);
    const ogWidth = widthMatch ? parseInt(widthMatch[1], 10) : null;

    // Normalizar a absoluta
    let absolute: string;
    try {
      absolute = new URL(image, resolvedUrl).toString();
    } catch {
      return null;
    }

    // FILTRO DE BASURA: si es un logo/placeholder/google, descartar
    if (isGarbageImage(absolute, ogWidth)) return null;

    return { image: absolute, resolvedUrl };
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
 * since: timestamp ISO del inicio de la corrida. Solo se consideran
 *   artículos con fetchedAt >= since (los nuevos de esta ejecución).
 *
 * Flujo:
 *   1. Cuenta cuántos artículos nuevos ya tienen imagen del feed (NIVEL 1).
 *   2. De los que NO tienen imagen (ni intento previo), resuelve la URL real
 *      (Google News) y ejecuta NIVEL 2.
 *   3. Marca imageFetchedAt en todos los intentados para no reintentar.
 *
 * Returns: { fromFeed, fromPage, failed, googleResolved, googleUnresolved }
 *   para el log del pipeline.
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
   * Artículos nuevos que necesitan NIVEL 2 (incluye resolvedUrl para
   * saber si ya tenemos la URL real del feed).
   */
  const pending = db
    .select({ id: articles.id, url: articles.url, resolvedUrl: articles.resolvedUrl })
    .from(articles)
    .where(
      and(
        sql`${articles.fetchedAt} >= ${since}`,
        isNull(articles.imageUrl),
        isNull(articles.imageFetchedAt)
      )
    )
    .limit(150)
    .all();

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
       * Resolver la URL real si es Google News (o ya la tenemos del feed).
       */
      const realUrl = await resolveRealUrl(article.url, article.resolvedUrl);

      if (isGoogle) {
        if (realUrl && !isGoogleNewsUrl(realUrl)) googleResolved++;
        else googleUnresolved++;
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
         * Fallo o sin imagen. Si resolvimos la URL real, la guardamos igual
         * (beneficia al futuro scraping de texto completo). imageUrl queda null.
         */
        db.update(articles)
          .set({
            ...(realUrl ? { resolvedUrl: realUrl } : {}),
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
