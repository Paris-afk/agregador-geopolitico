import { defineConfig } from "drizzle-kit";

/*
 * drizzle-kit genera migraciones SQL a partir del schema de Drizzle.
 *
 * - schema: ruta al archivo que exporta las definiciones de tablas.
 * - out: carpeta donde se escriben las migraciones SQL generadas.
 * - dialect: "sqlite" para SQLite (drizzle-kit adapta la sintaxis DDL).
 * - dbCredentials.url: ruta al archivo físico de la BD.
 */
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/geopolitica.db",
  },
});
