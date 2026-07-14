import OpenAI from "openai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

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
 *   2. Llama a DeepSeek con response_format: json_object para garantizar
 *      que la respuesta sea JSON válido (no markdown, no texto libre).
 *      Sin esto, el modelo a veces envuelve el JSON en ```json```.
 *   3. La temperatura se fija en 0.3: lo suficientemente baja para
 *      consistencia analítica, lo suficientemente alta para matices.
 *   4. Extrae el contenido, lo parsea como JSON, y valida que las 7
 *      claves requeridas estén presentes.
 *   5. Si el JSON no parsea o faltan claves, lanza un error descriptivo
 *      con fragmentos de la respuesta para debugging.
 */
export async function analyzeThread(input: AnalysisInput): Promise<AnalysisOutput> {
  const userPrompt = buildUserPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
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
