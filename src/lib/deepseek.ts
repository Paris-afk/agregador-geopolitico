import OpenAI from "openai";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  CLASSIFIER_PROMPT,
  buildClassifierPrompt,
  CONSOLIDATOR_PROMPT,
  buildConsolidatorPrompt,
} from "./prompts";

/*
 * Cliente OpenAI apuntado a la API de DeepSeek.
 *
 * DeepSeek expone una API compatible con OpenAI, por lo que podemos usar
 * el SDK oficial de OpenAI sin adaptadores adicionales.
 *
 * La API key se lee de DEEPSEEK_API_KEY en .env.local.
 * El modelo por defecto es "deepseek-chat" (DeepSeek-V3), configurable
 * vía DEEPSEEK_MODEL en el entorno (ej: "deepseek-reasoner" para R1).
 */
const client = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

/*
 * ESTRATEGIA DE MODELOS:
 *
 *   MODEL_FAST ("deepseek-v4-flash") — tareas de categorización y detección
 *     de duplicados. Son deterministas, de baja latencia, y no requieren
 *     razonamiento profundo. Usar Pro aquí sería desperdiciar tokens y dinero.
 *
 *   MODEL_SMART ("deepseek-v4-pro") — análisis geopolítico en profundidad
 *     con thinking mode (chain-of-thought). El analista necesita razonar
 *     sobre narrativas, triangular perspectivas y detectar desviaciones.
 *     Flash no tiene la capacidad de razonamiento para esta tarea.
 *
 *   MODEL se mantiene como fallback configurable vía DEEPSEEK_MODEL en el
 *     entorno, para pruebas o migration a nuevos modelos sin cambiar código.
 */
const MODEL_FAST = process.env.DEEPSEEK_MODEL_FAST ?? "deepseek-v4-flash";
const MODEL_SMART = process.env.DEEPSEEK_MODEL_SMART ?? "deepseek-v4-pro";

/*
 * Tipos de entrada y salida de analyzeThread.
 *
 * AnalysisInput: lo que recibe la función.
 * AnalysisOutput: la respuesta esperada de DeepSeek (parseada del JSON).
 *   - newState es la síntesis actualizada que reemplazará el threadState
 *     anterior en la BD. Es el mecanismo de "memoria" del sistema.
 */
export type AnalysisInput = {
  threadTitle: string;
  threadState: string | null;
  articles: Array<{
    sourceName: string;
    bias: string;
    title: string;
    content: string;
  }>;
};

export type AnalysisOutput = {
  summary: string;
  cuiBono: string;
  saidVsDone: string;
  deviation: string;
  prediction: string;
  verdict: string;
  newState: string;
};

/*
 * analyzeThread — Envía artículos a DeepSeek y devuelve un análisis
 * estructurado con los 7 campos del método de inteligencia.
 *
 * Flujo:
 *   1. Construye el user prompt con buildUserPrompt() (incluye artículos
 *      serializados y memoria previa si existe).
 *   2. Llama a DeepSeek con THINKING MODE activado (reasoning_effort: "high"
 *      y extra_body: { thinking: { type: "enabled" } }). Thinking mode
 *      permite que DeepSeek haga chain-of-thought interno antes de producir
 *      la respuesta, lo que mejora significativamente la calidad del análisis.
 *   3. En thinking mode, DeepSeek IGNORA el parámetro temperature, por eso
 *      lo hemos eliminado de esta función. El razonamiento interno del modelo
 *      produce suficiente variabilidad controlada.
 *   4. La respuesta incluye reasoning_content (el chain-of-thought) y content
 *      (la respuesta final). Solo usamos content — el reasoning es interno.
 *   5. response_format json_object garantiza que content sea JSON parseable.
 *   6. Validamos las 7 claves requeridas antes de devolver el resultado.
 */
export async function analyzeThread(input: AnalysisInput): Promise<AnalysisOutput> {
  const userPrompt = buildUserPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_SMART,
    reasoning_effort: "high",
    // @ts-expect-error — extra_body no está en los tipos del SDK de OpenAI
    extra_body: { thinking: { type: "enabled" } },
    /*
     * response_format json_object es CLAVE:
     *   - DeepSeek (como OpenAI) garantiza que el output será JSON parseable.
     *   - Sin esto, el modelo puede devolver markdown, texto explicativo,
     *     o incluso rechazar generar JSON en ciertos contextos.
     *   - El system prompt debe contener la palabra "JSON" para que el
     *     modo json_object funcione correctamente (ya lo incluimos).
     */
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;

  if (!raw) {
    throw new Error("DeepSeek devolvió una respuesta vacía. Verifica la API key y el saldo.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /*
     * Si el parseo falla, mostramos los primeros 300 caracteres de la
     * respuesta para diagnosticar (ej: si devolvió markdown o HTML).
     */
    const preview = raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
    throw new Error(`DeepSeek no devolvió JSON válido. Respuesta: ${preview}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`DeepSeek devolvió un valor no-objeto: ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;

  /*
   * Validamos que todas las claves requeridas estén presentes.
   * Si falta alguna, listamos cuáles para que el error sea útil.
   */
  const requiredKeys: (keyof AnalysisOutput)[] = [
    "summary",
    "cuiBono",
    "saidVsDone",
    "deviation",
    "prediction",
    "verdict",
    "newState",
  ];

  const missing = requiredKeys.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new Error(`DeepSeek devolvió JSON incompleto. Faltan las claves: ${missing.join(", ")}`);
  }

  return obj as AnalysisOutput;
}

/*
 * ============================================================================
 * CLASIFICADOR — Asigna artículos a hilos temáticos.
 * ============================================================================
 *
 * A diferencia de analyzeThread (que hace análisis en profundidad de UN hilo),
 * classifyArticles decide A QUÉ hilo pertenece cada artículo. Es una tarea
 * más ligera y determinista (temperatura 0.2 vs 0.3).
 */

/*
 * Tipos para la clasificación.
 *
 * ClassifyInput: artículos a clasificar + hilos existentes para asignar.
 * ClassifyOutput: asignaciones por artículo + hilos nuevos propuestos.
 *
 * newThreadProposal puede ser { title, description } (propuesta completa)
 * o { tempId } (referencia a un hilo propuesto en proposedThreads).
 * Aceptamos ambos formatos porque DeepSeek puede devolver cualquiera.
 */
export type ClassifyInput = {
  articles: Array<{
    id: number;
    sourceName: string;
    bias: string;
    title: string;
    content: string;
  }>;
  existingThreads: Array<{
    id: number;
    title: string;
    description: string | null;
  }>;
};

export type ClassificationAssignment = {
  articleId: number;
  threadId: number | null;
  newThreadProposal: { title: string; description: string } | { tempId: string } | null;
  ignore: boolean;
};

export type ProposedThread = {
  tempId: string;
  title: string;
  description: string;
};

export type ClassifyOutput = {
  assignments: ClassificationAssignment[];
  proposedThreads: ProposedThread[];
};

/*
 * classifyArticles — Clasifica artículos en hilos temáticos usando DeepSeek.
 *
 * Temperatura 0.2 (más baja que analyzeThread): clasificar es más determinista
 * que analizar; queremos consistencia, no creatividad.
 *
 * La validación es más compleja que en analyzeThread porque la estructura
 * de salida tiene arrays anidados. Validamos la presencia de las claves
 * top-level y la estructura de cada asignación y propuesta.
 */
export async function classifyArticles(input: ClassifyInput): Promise<ClassifyOutput> {
  const userPrompt = buildClassifierPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLASSIFIER_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("DeepSeek (classifier) devolvió una respuesta vacía.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const preview = raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
    throw new Error(`DeepSeek (classifier) no devolvió JSON válido. Respuesta: ${preview}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`DeepSeek (classifier) devolvió un valor no-objeto: ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.assignments)) {
    throw new Error('DeepSeek (classifier): falta "assignments" o no es un array');
  }

  if (!Array.isArray(obj.proposedThreads)) {
    throw new Error('DeepSeek (classifier): falta "proposedThreads" o no es un array');
  }

  return {
    assignments: obj.assignments as ClassificationAssignment[],
    proposedThreads: obj.proposedThreads as ProposedThread[],
  };
}

/*
 * ============================================================================
 * CONSOLIDADOR — Fusiona hilos semánticamente duplicados.
 * ============================================================================
 *
 * La consolidación es un PASO SEPARADO de la clasificación por una razón
 * fundamental: clasificar y fusionar son problemas distintos con prompts
 * distintos. El clasificador ve artículos y los asigna a hilos; el
 * consolidator ve hilos (títulos + descripciones) y detecta sinónimos.
 * Juntarlos en un solo prompt produciría peores resultados en ambas tareas
 * porque el modelo tendría que hacer dos juicios diferentes a la vez.
 *
 * Además, la consolidación se ejecuta con mucha menos frecuencia que la
 * clasificación (típicamente después de crear varios hilos nuevos), así
 * que mantenerlos separados ahorra tokens y latencia en el día a día.
 */

export type ConsolidatorInput = {
  threads: Array<{ id: number; title: string; description: string | null }>;
};

export type MergeGroup = {
  canonical: number;
  duplicates: number[];
  suggestedTitle?: string;
};

export type ConsolidatorOutput = {
  mergeGroups: MergeGroup[];
};

/*
 * findDuplicateThreads — Identifica hilos que son el mismo tema con
 * distinto nombre usando DeepSeek (sin thinking, temp 0.2).
 *
 * Devuelve grupos de hilos a fusionar. Cada grupo tiene un hilo "canónico"
 * (el que se conserva) y una lista de "duplicados" (los que se fusionan
 * en el canónico). Los hilos que no aparecen en ningún grupo se consideran
 * únicos y no requieren fusión.
 */
export async function findDuplicateThreads(
  input: ConsolidatorInput
): Promise<ConsolidatorOutput> {
  const userPrompt = buildConsolidatorPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CONSOLIDATOR_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek (consolidator) devolvió una respuesta vacía.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const preview = raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
    throw new Error(`DeepSeek (consolidator) no devolvió JSON válido. Respuesta: ${preview}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`DeepSeek (consolidator) devolvió un valor no-objeto: ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.mergeGroups)) {
    throw new Error('DeepSeek (consolidator): falta "mergeGroups" o no es un array');
  }

  return { mergeGroups: obj.mergeGroups as MergeGroup[] };
}
