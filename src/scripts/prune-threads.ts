#!/usr/bin/env tsx

/*
 * src/scripts/prune-threads.ts — Podar el mapa de teatros sin sustancia.
 *
 * Por defecto corre en DRY-RUN (no modifica nada): imprime una tabla con id,
 * título, nº artículos, nº perspectivas, días desde el último artículo, nº de
 * análisis y el criterio que dispararía la desactivación.
 *
 * Con PRUNE_APPLY=1 aplica los cambios de verdad (active=false, reversible).
 *
 * Uso:
 *   npm run script:prune-threads           # dry-run
 *   PRUNE_APPLY=1 npm run script:prune-threads   # aplicar
 */

import { config } from "dotenv";
import { existsSync } from "fs";

const envPath = ".env.local";
if (!existsSync(envPath)) {
  console.error(`❌ No se encontró ${envPath}.`);
  process.exit(1);
}
config({ path: envPath });

async function main() {
  const { pruneThreads } = await import("../lib/prune");
  const { db } = await import("../lib/db/index");
  const { threads } = await import("../lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const apply = process.env.PRUNE_APPLY === "1";
  const dryRun = !apply;

  const result = pruneThreads({ dryRun });

  console.log("═".repeat(80));
  console.log(`  PODA DE TEATROS — ${dryRun ? "DRY-RUN (no modifica nada)" : "APLICAR"}`);
  console.log("═".repeat(80));

  if (result.candidates.length === 0) {
    console.log("\n✅ No hay teatros que desactivar.");
  } else {
    console.log(`\nSe ${dryRun ? "desactivarían" : "desactivaron"} ${result.candidates.length} teatros:\n`);

    // Tabla alineada
    console.log(
      ["id".padStart(4), "art".padStart(4), "persp".padStart(5), "últ-Art".padStart(7), "análisis".padStart(8), "criterio", "título"].join(" | ")
    );
    console.log("-".repeat(80));

    for (const c of result.candidates) {
      console.log(
        [
          String(c.id).padStart(4),
          String(c.articleCount).padStart(4),
          String(c.perspectives).padStart(5),
          (c.daysSinceLastArticle === null ? "—" : `${c.daysSinceLastArticle}d`).padStart(7),
          String(c.analysisCount).padStart(8),
          c.reason.padEnd(30),
          c.title.slice(0, 30),
        ].join(" | ")
      );
    }
  }

  // Desglose por criterio
  console.log("\n📊 Desglose por criterio:");
  for (const [reason, count] of Object.entries(result.byReason)) {
    if (count > 0) console.log(`   ${reason}: ${count}`);
  }
  console.log(`   (protegidos: manual/tensión≥4/desviación activa): ${result.protectedCount}`);

  // Conteo final de activos
  const activeRows = db
    .select({ count: threads.id })
    .from(threads)
    .where(eq(threads.active, true))
    .all();
  console.log(`\n${dryRun ? "Quedarían" : "Quedan"} ${result.remainingActive} threads activos (ahora: ${activeRows.length}).`);

  console.log("═".repeat(80) + "\n");
  process.exit(0);
}

main();
