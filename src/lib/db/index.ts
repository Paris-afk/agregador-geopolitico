import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/*
 * Conexión a SQLite con better-sqlite3.
 *
 * better-sqlite3 es síncrono y no necesita pool de conexiones, lo que encaja
 * bien con SQLite (un solo escritor, lecturas concurrentes ligeras).
 *
 * La BD vive en ./data/geopolitica.db (relativo a la raíz del proyecto).
 * Si la carpeta data/ no existe, better-sqlite3 la crea automáticamente (el
 * archivo .db sí lo crea, pero no los directorios intermedios si no existen).
 *
 * Pasamos el schema a drizzle() para que los tipos de las queries inferidos
 * incluyan relaciones y columnas tipadas.
 */
const sqlite = new Database("./data/geopolitica.db");

export const db = drizzle(sqlite, { schema });
