import { db } from "./index";
import { sources } from "./schema";
import { eq } from "drizzle-orm";

/*
 * Siembra inicial de fuentes de noticias.
 *
 * Se ejecuta con: npx tsx src/lib/db/seed.ts
 *
 * Cada fuente se inserta solo si no existe ya una fila con el mismo rssUrl.
 * Usamos rssUrl (no name) como clave de unicidad porque la URL del feed es
 * la identidad real de la fuente; el nombre puede cambiar o repetirse.
 */
const SEEDS = [
  {
    name: "Kathimerini",
    rssUrl: "https://news.google.com/rss/search?q=site:ekathimerini.com&hl=en&gl=US&ceid=US:en",
    bias: "greek" as const,
  },
  {
    name: "Daily Sabah",
    rssUrl: "https://news.google.com/rss/search?q=site:dailysabah.com&hl=en&gl=US&ceid=US:en",
    bias: "turkish" as const,
  },
  {
    name: "RT",
    rssUrl: "https://www.rt.com/rss/news/",
    bias: "russian" as const,
  },
  {
    name: "Xinhua",
    rssUrl: "https://news.google.com/rss/search?q=site:news.cn&hl=en&gl=US&ceid=US:en",
    bias: "chinese" as const,
  },
  {
    name: "Politico Europe",
    rssUrl: "https://news.google.com/rss/search?q=%22Institute+for+the+Study+of+War%22&hl=en&gl=US&ceid=US:en",
    bias: "european" as const,
  },
  {
    name: "ISW",
    rssUrl: "https://www.understandingwar.org/rss.xml",
    bias: "western_thinktank" as const,
  },
];

async function seed() {
  console.log("🌱 Sembrando fuentes iniciales...\n");

  for (const seed of SEEDS) {
    const existing = db
      .select()
      .from(sources)
      .where(eq(sources.rssUrl, seed.rssUrl))
      .get();

    if (existing) {
      console.log(`  ⏭  ${seed.name} — ya existe (id=${existing.id})`);
      continue;
    }

    /*
     * createdAt usa ISO 8601 en UTC para consistencia con el resto de
     * timestamps del sistema. new Date().toISOString() produce el formato
     * "2026-07-12T14:30:00.000Z" que SQLite almacena como texto sin problemas.
     */
    db.insert(sources).values({
      name: seed.name,
      rssUrl: seed.rssUrl,
      bias: seed.bias,
      createdAt: new Date().toISOString(),
    }).run();

    console.log(`  ✅ ${seed.name} — insertada`);
  }

  console.log("\n✅ Siembra completada.");
}

seed().catch((err) => {
  console.error("❌ Error en la siembra:", err);
  process.exit(1);
});
