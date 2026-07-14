import type { sources } from "./db/schema";

/*
 * Valores permitidos para el campo bias.
 *
 * Se exportan como constante para que tanto el backend (validación en API)
 * como el frontend (dropdown en la UI) usen la misma fuente de verdad.
 * Si en el futuro se añaden perspectivas, solo hay que tocar aquí y en schema.ts.
 */
export const VALID_BIAS_VALUES = [
  "greek",
  "turkish",
  "russian",
  "chinese",
  "european",
  "western_thinktank",
  "other",
] as const;

export type BiasValue = (typeof VALID_BIAS_VALUES)[number];

/*
 * Etiquetas legibles para cada perspectiva. Se usan en la UI
 * para mostrar badges con nombres bonitos en lugar del snake_case crudo.
 */
export const BIAS_LABELS: Record<BiasValue, string> = {
  greek: "Griega",
  turkish: "Turca",
  russian: "Rusa",
  chinese: "China",
  european: "Europea",
  western_thinktank: "Think Tank Occidental",
  other: "Otra",
};

/*
 * Colores Tailwind por perspectiva para los badges.
 * Cada entrada es un par [fondo, texto] de clases Tailwind.
 */
export const BIAS_COLORS: Record<BiasValue, string> = {
  greek: "bg-blue-100 text-blue-800",
  turkish: "bg-red-100 text-red-800",
  russian: "bg-slate-100 text-slate-800",
  chinese: "bg-orange-100 text-orange-800",
  european: "bg-indigo-100 text-indigo-800",
  western_thinktank: "bg-emerald-100 text-emerald-800",
  other: "bg-gray-100 text-gray-800",
};

/*
 * Tipo que representa una fila completa de la tabla sources,
 * inferido automáticamente por Drizzle a partir del schema.
 */
export type Source = typeof sources.$inferSelect;

/*
 * Datos necesarios para crear una fuente nueva.
 * createdAt y active se asignan con valores por defecto en createSource().
 */
export type CreateSourceInput = {
  name: string;
  rssUrl: string;
  bias: BiasValue;
};

/*
 * Datos permitidos para actualizar una fuente existente.
 * Todos los campos son opcionales: solo se actualizan los que vengan en el body.
 */
export type UpdateSourceInput = Partial<{
  name: string;
  rssUrl: string;
  bias: BiasValue;
  active: boolean;
}>;
