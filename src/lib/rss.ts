import Parser from "rss-parser";
import { db } from "./db/index";
import { sources, articles } from "./db/schema";
import { eq } from "drizzle-orm";

/*
 * Tipos internos para el módulo de ingesta RSS.
 *
 * FeedItemRaw es lo que devuelve rss-parser por cada <item> del feed.
 * IngestResult resume lo ocurrido con una fuente durante la ingesta.
 */
type FeedItemRaw = {
  title?: string;
  content?: string;
  contentSnippet?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
};

export type IngestResult = {
  sourceId: number;
  sourceName: string;
  status: "ok" | "error" | "blocked" | "empty";
  newArticles: number;
  error?: string;
};

const parser = new Parser();

/*
 * fetchFeed — Descarga y parsea un feed RSS de una sola fuente.
 *
 * En lugar de usar parser.parseURL() (que oculta los detalles HTTP), hacemos
 * fetch() manual para tener control sobre:
 *   1. Timeout (10s vía AbortController)
 *   2. Códigos de estado HTTP (clave para distinguir "blocked" de "error")
 *   3. Cuerpo de respuesta (para detectar feed vacío)
 *
 * Devuelve los items parseados o lanza un error tipado con status.
 */
async function fetchFeed(source: {
  id: number;
  name: string;
  rssUrl: string;
}): Promise<{ items: FeedItemRaw[] }> {
  const TIMEOUT_MS = 10_000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(source.rssUrl, {
      signal: controller.signal,
      /*
       * Sin un User-Agent muchos servidores devuelven 403. Usamos uno
       * genérico de navegador para no ser bloqueados por User-Agent vacío.
       */
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GeopoliticoBot/1.0)" },
    });
  } catch (err) {
    clearTimeout(timeoutId);

    const message = err instanceof Error ? err.message : String(err);

    /*
     * Clasificación de errores de red en tres niveles:
     *
     * 1. AbortError → "blocked"
     *    El AbortController canceló el fetch tras 10s sin respuesta.
     *    El servidor aceptó TCP pero nunca devolvió HTTP — patrón típico
     *    de firewall/DPI que silencia RT o fuentes bloqueadas por geografía.
     *    Lo detectamos por err.name (estándar de la spec DOM/WHATWG).
     *
     * 2. ENOTFOUND / ECONNREFUSED → "error"
     *    ENOTFOUND: el DNS no pudo resolver el dominio (URL mal escrita,
     *    dominio expirado, o el DNS está caído). No es un bloqueo deliberado,
     *    es un problema técnico.
     *    ECONNREFUSED: el puerto no acepta conexiones (servidor caído o mal
     *    configurado). Tampoco es un bloqueo geográfico.
     *    En Node.js (undici), estos códigos vienen en err.cause.code.
     *    Usamos también includes() sobre err.message como fallback.
     *
     * 3. Cualquier otro error de red → "error"
     *    Error desconocido que no podemos clasificar como bloqueo sin más
     *    evidencia (ej. ECONNRESET, ETIMEDOUT del lado del SO, etc.).
     */
    if (err instanceof DOMException && err.name === "AbortError") {
      throw { status: "blocked" as const, message };
    }

    const networkCode = (err as NodeJS.ErrnoException)?.cause as { code?: string } | undefined;
    const code = networkCode?.code ?? "";
    if (code === "ENOTFOUND" || code === "ECONNREFUSED") {
      throw { status: "error" as const, message: `[${code}] ${message}` };
    }
    if (message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) {
      throw { status: "error" as const, message };
    }

    throw { status: "error" as const, message };
  }

  clearTimeout(timeoutId);

  /*
   * 403 Forbidden — el servidor rechazó explícitamente la petición.
   * 451 Unavailable For Legal Reasons — bloqueo legal/gubernamental (RFC 7725).
   *
   * Ambos son evidencia clara de bloqueo, no de error técnico.
   */
  if (response.status === 403 || response.status === 451) {
    throw {
      status: "blocked" as const,
      message: `HTTP ${response.status} — ${response.statusText}`,
    };
  }

  /*
   * Cualquier otro código 4xx/5xx es un error del servidor o del recurso:
   * 404 (feed movido), 500 (error interno), 503 (mantenimiento), etc.
   * No son bloqueos, son problemas que el operador de la fuente debe resolver.
   */
  if (!response.ok) {
    throw {
      status: "error" as const,
      message: `HTTP ${response.status} — ${response.statusText}`,
    };
  }

  const xml = await response.text();

  /*
   * Si el cuerpo está vacío o es trivial, no hay artículos que procesar.
   * Esto puede pasar si el feed está mal configurado o temporalmente sin contenido.
   */
  if (!xml || xml.trim().length < 50) {
    throw { status: "empty" as const, message: "Feed XML vacío o casi vacío" };
  }

  let feed: { items?: FeedItemRaw[] };
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    /*
     * rss-parser no pudo interpretar el XML. Puede ser que no sea RSS/Atom
     * válido o que el servidor devolvió HTML (ej. página de login/block).
     */
    const message = err instanceof Error ? err.message : String(err);
    throw { status: "error" as const, message: `Parse error: ${message}` };
  }

  if (!feed.items || feed.items.length === 0) {
    throw { status: "empty" as const, message: "Feed sin artículos (items vacío)" };
  }

  return { items: feed.items };
}

/*
 * ingestAllSources — Itera todas las fuentes activas y procesa sus feeds.
 *
 * Por cada fuente:
 *   1. Llama a fetchFeed() para obtener los artículos.
 *   2. Inserta cada artículo en la BD con onConflictDoNothing()
 *      (la url es unique, así que los duplicados se ignoran silenciosamente).
 *   3. Actualiza lastFetchStatus y lastFetchAt de la fuente.
 *   4. Si algo falla, registra el error en lastFetchStatus y CONTINÚA con la
 *      siguiente fuente. Un fallo en una fuente nunca aborta la ingesta global.
 *
 * Devuelve un array de IngestResult con el resumen por fuente.
 */
export async function ingestAllSources(): Promise<IngestResult[]> {
  const allSources = db.select().from(sources).where(eq(sources.active, true)).all();

  const results: IngestResult[] = [];

  for (const source of allSources) {
    const now = new Date().toISOString();
    const result: IngestResult = {
      sourceId: source.id,
      sourceName: source.name,
      status: "ok",
      newArticles: 0,
    };

    try {
      const { items } = await fetchFeed(source);

      let savedCount = 0;
      for (const item of items) {
        if (!item.link) continue;

        const row = db
          .insert(articles)
          .values({
            sourceId: source.id,
            title: item.title ?? "(sin título)",
            content: item.content ?? item.contentSnippet ?? "",
            url: item.link,
            publishedAt: item.isoDate ?? item.pubDate ?? now,
            fetchedAt: now,
          })
          /*
           * onConflictDoNothing: como articles.url tiene constraint UNIQUE,
           * si el artículo ya existe en la BD, la inserción se ignora sin error.
           * Así podemos re-ejecutar la ingesta sin duplicar contenido.
           */
          .onConflictDoNothing()
          .run();

        if (row.changes > 0) savedCount++;
      }

      result.newArticles = savedCount;

      if (savedCount === 0 && items.length > 0) {
        /*
         * Caso borde: el feed tenía items pero todos ya estaban en la BD
         * (urls duplicadas). Sigue siendo "ok" — el feed funcionó bien.
         */
        result.status = "ok";
      } else if (items.length === 0) {
        /*
         * Este caso no debería llegar aquí porque fetchFeed ya lanza "empty"
         * si no hay items, pero lo cubrimos por seguridad.
         */
        result.status = "empty";
      }

      db.update(sources)
        .set({ lastFetchStatus: "ok", lastFetchAt: now })
        .where(eq(sources.id, source.id))
        .run();
    } catch (err) {
      /*
       * fetchFeed lanza objetos con { status, message } para errores
       * clasificados. Si el error no tiene esa forma (ej. excepción
       * inesperada), lo tratamos como "error" genérico.
       */
      const typed = err as { status?: string; message?: string };
      const status =
        typed.status === "blocked" || typed.status === "error" || typed.status === "empty"
          ? typed.status
          : "error";

      result.status = status;
      result.error = typed.message ?? String(err);

      db.update(sources)
        .set({
          lastFetchStatus: status,
          lastFetchAt: now,
        })
        .where(eq(sources.id, source.id))
        .run();
    }

    results.push(result);
  }

  return results;
}
