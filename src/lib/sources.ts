import { db } from "./db/index";
import { sources } from "./db/schema";
import { eq } from "drizzle-orm";
import {
  VALID_BIAS_VALUES,
  type BiasValue,
  type Source,
  type CreateSourceInput,
  type UpdateSourceInput,
} from "./sources-types";

/*
 * Re-exportamos tipos y constantes para que los consumidores server-side
 * (API routes) puedan importar todo desde un solo módulo.
 * Los client components deben importar desde @/lib/sources-types para
 * evitar que better-sqlite3 termine en el bundle del navegador.
 */
export {
  VALID_BIAS_VALUES,
  BIAS_LABELS,
  BIAS_COLORS,
  type BiasValue,
  type Source,
  type CreateSourceInput,
  type UpdateSourceInput,
} from "./sources-types";

/*
 * Valida que un valor de bias esté en la lista permitida.
 * Lanza un error descriptivo si no es válido.
 */
export function validateBias(value: unknown): asserts value is BiasValue {
  if (typeof value !== "string" || !VALID_BIAS_VALUES.includes(value as BiasValue)) {
    throw new Error(`bias inválido: "${value}". Permitidos: ${VALID_BIAS_VALUES.join(", ")}`);
  }
}

/*
 * getAllSources — Devuelve todas las fuentes ordenadas por fecha de creación
 * (más recientes primero) para que la UI las muestre de forma predecible.
 */
export function getAllSources(): Source[] {
  return db.select().from(sources).all();
}

/*
 * createSource — Inserta una fuente nueva con active=true y createdAt=ahora.
 * Valida que bias sea uno de los valores permitidos antes de insertar.
 */
export function createSource(input: CreateSourceInput): Source {
  const { name, rssUrl, bias } = input;

  if (!name || typeof name !== "string") throw new Error("name es requerido");
  if (!rssUrl || typeof rssUrl !== "string") throw new Error("rssUrl es requerido");
  validateBias(bias);

  const row = db
    .insert(sources)
    .values({
      name: name.trim(),
      rssUrl: rssUrl.trim(),
      bias,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();

  return row;
}

/*
 * updateSource — Actualiza solo los campos enviados en el body.
 * Si se envía bias, lo valida contra la lista permitida.
 * Si el id no existe, retorna null para que el endpoint devuelva 404.
 */
export function updateSource(id: number, input: UpdateSourceInput): Source | null {
  const existing = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!existing) return null;

  if (input.bias !== undefined) validateBias(input.bias);

  /*
   * Drizzle update + set + returning devuelve la fila actualizada.
   * Solo seteamos los campos que vienen definidos en el input.
   */
  const updated = db
    .update(sources)
    .set(input)
    .where(eq(sources.id, id))
    .returning()
    .get();

  return updated;
}

/*
 * deleteSource — Elimina una fuente por id.
 * Retorna true si se eliminó, false si el id no existía.
 */
export function deleteSource(id: number): boolean {
  const result = db.delete(sources).where(eq(sources.id, id)).run();
  return result.changes > 0;
}
