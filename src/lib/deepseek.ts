import OpenAI from "openai";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildUserPromptRetry,
  CLASSIFIER_PROMPT,
  buildClassifierPrompt,
  CONSOLIDATOR_PROMPT,
  buildConsolidatorPrompt,
  CHAT_PROMPT,
  buildChatContext,
  DOMAINS_VOCABULARY,
  domainsVocabularyText,
  LINK_CLASSIFIER_PROMPT,
  buildLinkClassifierPrompt,
  buildMetaSystemPrompt,
  buildMetaPrompt,
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
 * ============================================================================
 * NORMALIZACIÓN DE ENTIDADES (compartida)
 * ============================================================================
 * Estas funciones se reutilizan tanto en el análisis normal como en el
 * backfill, para que los valores de countries/actors/domains/tensionLevel
 * sean siempre consistentes.
 */

export function toCleanStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? Array.from(new Set(v.map((x) => String(x).trim()).filter((x) => x.length > 0)))
    : [];
}

export function normalizeTensionLevel(v: unknown): number {
  const raw = Number(v);
  return Number.isFinite(raw) ? Math.min(5, Math.max(1, Math.round(raw))) : 1;
}

/*
 * normalizeDomains — Filtra los dominios contra el VOCABULARIO CERRADO.
 * Descarta cualquier valor que el modelo invente (sinónimos, acentos, etc.)
 * y limita a un máximo de 4. Garantiza que teatros materialmente relacionados
 * usen la MISMA etiqueta y crucen como cadena común.
 */
export function normalizeDomains(v: unknown): string[] {
  const clean = toCleanStringArray(v);
  const allowed = new Set<string>(DOMAINS_VOCABULARY);
  return clean.filter((d) => allowed.has(d)).slice(0, 4);
}

export type EntityExtraction = {
  countries: string[];
  actors: string[];
  domains: string[];
  tensionLevel: number;
};

/*
 * extractEntities — Backfill BARATO de entidades.
 *
 * Usa MODEL_FAST (flash) con un prompt corto de extracción, recibiendo solo
 * título + state + verdict. Devuelve los cuatro campos de entidades.
 * No ejecuta análisis completo — es una extracción ligera.
 */
export async function extractEntities(input: {
  threadTitle: string;
  threadState: string | null;
  verdict: string | null;
}): Promise<EntityExtraction> {
  const system = `Eres un extractor de entidades geopolíticas. Recibes información sobre UN teatro estratégico y debes extraer sus entidades.

Extrae SOLO de la información dada:
- countries: array de códigos ISO 3166-1 alpha-2 (ej: "GR", "TR", "CY") de países que son ACTORES o ESCENARIO del teatro. No incluyas mencionados de pasada.
- actors: array de actores NO ESTATALES o supranacionales (OTAN, UE, Hezbolá, Gazprom, milicias, empresas, instituciones).
- domains: array de 1 a 4 dominios del VOCABULARIO CERRADO de abajo. Elige los que están MATERIALMENTE en juego. SOLO puedes usar estos valores EXACTOS (snake_case), nunca inventes ni uses sinónimos:
${domainsVocabularyText()}
  Si nada de la lista aplica, devuelve array vacío. NO inventes valores nuevos.
- tensionLevel: integer 1-5 (1=latente, 2=tensión diplomática, 3=escalada, 4=crisis aguda, 5=conflicto abierto).

Responde ÚNICAMENTE con JSON válido, sin markdown ni texto adicional:
{
  "countries": [],
  "actors": [],
  "domains": [],
  "tensionLevel": 3
}`;

  const user = `TEATRO: ${input.threadTitle}

ESTADO ACUMULADO:
${input.threadState ?? "(sin estado previo)"}

VEREDICTO DEL ÚLTIMO ANÁLISIS:
${input.verdict ?? "(sin análisis previo)"}

Extrae las entidades de este teatro. Responde solo con el JSON.`;

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek (entidades) devolvió respuesta vacía");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DeepSeek (entidades) no devolvió JSON válido");
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;

  return {
    countries: toCleanStringArray(obj.countries),
    actors: toCleanStringArray(obj.actors),
    domains: normalizeDomains(obj.domains),
    tensionLevel: normalizeTensionLevel(obj.tensionLevel),
  };
}


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
    hasFullText?: boolean;
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
  countries: string[];
  actors: string[];
  domains: string[];
  tensionLevel: number;
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
export async function analyzeThread(
  input: AnalysisInput,
  opts?: { retry?: boolean }
): Promise<AnalysisOutput> {
  /*
   * En el reintento usamos buildUserPromptRetry() (instrucción de idioma
   * reforzada) porque la respuesta anterior se contaminó con el idioma
   * de las fuentes.
   */
  const userPrompt = opts?.retry ? buildUserPromptRetry(input) : buildUserPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_SMART,
    reasoning_effort: "high",
    // @ts-expect-error — extra_body no está en los tipos del SDK de OpenAI
    extra_body: { thinking: { type: "enabled" } },
    /*
     * max_tokens: evita que la respuesta se TRUNQUE. Sin límite explícito,
     * DeepSeek puede cortar el JSON a mitad en análisis largos (pasó con
     * dos análisis truncados). 12000 tokens dan margen amplio para los
     * 7 campos + newState.
     */
    max_tokens: 12000,
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
      { role: "system", content: buildSystemPrompt(new Date().toLocaleDateString("es-ES", { weekday: "long", year: "numeric", month: "long", day: "numeric" })) },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  const finishReason = completion.choices[0]?.finish_reason ?? "unknown";

  /*
   * Log del finish_reason: "stop" = terminó naturalmente, "length" = se
   * truncó por el límite de max_tokens. Es la primera señal diagnóstica
   * cuando una respuesta sale rota.
   */
  console.log(`   [deepseek] finish_reason="${finishReason}" | tokens=${completion.usage?.total_tokens ?? "?"}`);

  if (!raw) {
    throw new Error("DeepSeek devolvió una respuesta vacía. Verifica la API key y el saldo.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /*
     * Guardamos la respuesta CRUDA COMPLETA en logs/ para inspeccionarla.
     * El error de JSON.parse lleva la posición exacta del fallo (ej:
     * "Unexpected token } in JSON at position 2341"). Lo logueamos y
     * también escribimos el archivo con metadatos de contexto.
     */
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`   [deepseek] JSON.parse ERROR: ${errMsg}`);
    console.error(`   [deepseek] finish_reason="${finishReason}" | longitud=${raw.length}`);

    try {
      const fs = await import("fs");
      const path = await import("path");
      const logsDir = path.join(process.cwd(), "logs");
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(logsDir, `failed-response-${input.threadTitle.replace(/[^\w-]+/g, "_").slice(0, 40)}-${ts}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            threadTitle: input.threadTitle,
            finishReason,
            tokensUsed: completion.usage?.total_tokens ?? null,
            parseError: errMsg,
            raw,
          },
          null,
          2
        ),
        "utf8"
      );
      console.error(`   [deepseek] Respuesta cruda guardada en ${file}`);
    } catch (fileErr) {
      console.error(`   [deepseek] No se pudo guardar la respuesta cruda: ${fileErr}`);
    }

    const preview = raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
    throw new Error(`DeepSeek no devolvió JSON válido (${errMsg}). Respuesta: ${preview}`);
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
    "countries",
    "actors",
    "domains",
    "tensionLevel",
  ];

  const missing = requiredKeys.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new Error(`DeepSeek devolvió JSON incompleto. Faltan las claves: ${missing.join(", ")}`);
  }

  /*
   * Normalizar los campos de entidades: el modelo puede devolver arrays
   * con valores no limpios. Usamos las funciones compartidas para que sean
   * consistentes con el backfill.
   */
  return {
    summary: obj.summary as string,
    cuiBono: obj.cuiBono as string,
    saidVsDone: obj.saidVsDone as string,
    deviation: obj.deviation as string,
    prediction: obj.prediction as string,
    verdict: obj.verdict as string,
    newState: obj.newState as string,
    countries: toCleanStringArray(obj.countries),
    actors: toCleanStringArray(obj.actors),
    domains: normalizeDomains(obj.domains),
    tensionLevel: normalizeTensionLevel(obj.tensionLevel),
  };
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

export type ConsolidatorThread = {
  id: number;
  title: string;
  description: string | null;
  state: string | null;
  countries: string[];
  actors: string[];
  domains: string[];
  tensionLevel: number | null;
};

export type ConsolidatorInput = {
  threads: ConsolidatorThread[];
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

/*
 * mergeThreadStates — Fusiona las memorias (states) de varios threads que
 * van a unificarse en UN state de máximo ~350 palabras.
 *
 * Crítico: sin esto, al absorber threads se pierde historia acumulada
 * silenciosamente. El state unificado debe preservar lo esencial de cada
 * uno y servir como memoria del teatro ampliado.
 */
export async function mergeThreadStates(input: {
  threads: Array<{ id: number; title: string; state: string | null }>;
}): Promise<{ mergedState: string }> {
  const system = `Eres un analista geopolítico veterano. Se te dan las MEMORIAS ACUMULADAS (states) de varios teatros que van a FUSIONARSE en uno solo porque son facetas del mismo juego estratégico.

Tu tarea: producir UNA memoria unificada (state) para el teatro fusionado.
- Máximo ~350 palabras.
- Preserva lo esencial de CADA teatro: actores clave, posiciones, tendencias, puntos de inflexión.
- Comprime lo redundante (lo que los teatros comparten se dice una vez).
- Integra lo nuevo con lo viejo de forma coherente.
- Debe servir como memoria para el próximo análisis del teatro fusionado.
- Escribe SIEMPRE en español.

Responde ÚNICAMENTE con el texto del state unificado, sin JSON, sin markdown, sin prefacios.`;

  const user = input.threads
    .map((t) => `TEATRO ${t.id} — ${t.title}:\n${t.state ?? "(sin memoria)"}`)
    .join("\n\n---\n\n");

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (!raw.trim()) throw new Error("DeepSeek (merge states) devolvió respuesta vacía");
  return { mergedState: raw.trim().slice(0, 2000) };
}

/*
 * proposeMergedTitle — Propone un título NUEVO para el teatro fusionado.
 * Debe reflejar el teatro ampliado, no heredar el título de uno de los trozos.
 */
export async function proposeMergedTitle(input: {
  titles: string[];
  mergedState: string;
}): Promise<string> {
  const system = `Eres un analista geopolítico veterano. Varios teatros se han fusionado en uno. Propón un TÍTULO NUEVO para el teatro fusionado que refleje el teatro ampliado (el juego estratégico completo), NO el título de uno de los trozos.

- Máximo 10 palabras, en español.
- Formato sugerido: "[Actor] — [acción/conflicto] — [región]" (ej: "Turquía — proyección regional y autonomía estratégica").
- Conciso, descriptivo, sin puntuación rara.
- Responde ÚNICAMENTE con el título, sin comillas ni texto adicional.`;

  const user = `TÍTULOS DE LOS TEATROS QUE SE FUSIONAN:\n${input.titles.map((t) => `- ${t}`).join("\n")}

MEMORIA UNIFICADA:\n${input.mergedState.slice(0, 1500)}

Propón el título del teatro fusionado.`;

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const title = (completion.choices[0]?.message?.content ?? "").trim();
  return title.replace(/^["']|["']$/g, "").slice(0, 100);
}

/*
 * ============================================================================
 * CHAT CONTEXTUAL — "Preguntar al analista" sobre un teatro concreto.
 * ============================================================================
 *
 * Modo conversacional: el analista responde preguntas puntuales sobre UN
 * teatro, con todo su contexto cargado (state + último análisis + artículos).
 *
 * Modelo: usamos MODEL_FAST (flash) porque es una tarea conversacional de
 * respuesta directa, no un análisis profundo de múltiples narrativas.
 * El padre puede cambiarlo a MODEL_SMART si quiere razonamiento más profundo.
 */

export type AskThreadInput = {
  threadTitle: string;
  threadState: string | null;
  analysis: {
    summary: string;
    cuiBono: string;
    saidVsDone: string;
    deviation: string | null;
    prediction: string | null;
    verdict: string;
  } | null;
  articles: Array<{ title: string; sourceName: string; bias: string }>;
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

export type AskThreadOutput = {
  answer: string;
  tokensUsed: number;
};

/*
 * askThread — Envía la pregunta al analista con el contexto del teatro
 * y el historial de la conversación. Devuelve la respuesta y el coste
 * aproximado (tokens) para loguear.
 */
export async function askThread(input: AskThreadInput): Promise<AskThreadOutput> {
  const context = buildChatContext({
    threadTitle: input.threadTitle,
    threadState: input.threadState,
    analysis: input.analysis,
    articles: input.articles,
  });

  /*
   * Historial: los mensajes previos se intercalan entre el contexto y la
   * pregunta actual para permitir preguntas de seguimiento coherentes.
   */
  const historyMessages = input.history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.3,
    messages: [
      { role: "system", content: CHAT_PROMPT },
      { role: "user", content: context },
      ...historyMessages,
      { role: "user", content: `PREGUNTA: ${input.question}` },
    ],
  });

  const answer = completion.choices[0]?.message?.content ?? "";
  const tokensUsed = completion.usage?.total_tokens ?? 0;

  if (!answer) {
    throw new Error("DeepSeek (chat) devolvió una respuesta vacía.");
  }

  return { answer, tokensUsed };
}

/*
 * ============================================================================
 * DETECCIÓN DE CONEXIONES (links) + META-ANÁLISIS
 * ============================================================================
 */

export type LinkClassification = {
  connected: boolean;
  linkType?: "cadena_material" | "mismo_bloque" | "presion_coordinada" | "competencia_recurso" | "distraccion" | "motor_interno";
  rationale?: string;
  strength?: number;
};

export type ClassifyLinkInput = {
  threadA: { id: number; title: string; state: string | null };
  threadB: { id: number; title: string; state: string | null };
  sharedDomains: string[];
  rareCountries: string[];
  rareActors: string[];
};

/*
 * classifyLink — Pregunta al modelo (MODEL_FAST) si dos teatros tienen una
 * relación material real y de qué tipo. Puede responder "sin conexión".
 */
export async function classifyLink(input: ClassifyLinkInput): Promise<LinkClassification> {
  const userPrompt = buildLinkClassifierPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_FAST,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: LINK_CLASSIFIER_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek (link) devolvió respuesta vacía");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DeepSeek (link) no devolvió JSON válido");
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;

  if (obj.connected === false) {
    return { connected: false };
  }

  const strength = Number(obj.strength);
  return {
    connected: true,
    linkType: obj.linkType as LinkClassification["linkType"],
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    strength: Number.isFinite(strength) ? Math.min(3, Math.max(1, Math.round(strength))) : 1,
  };
}

export type MetaAnalysisResult = {
  systemReading: string;
  blocFormation: string;
  crossPatterns: string;
  contradictions: string;
  predictionStatement: string;
  predictionCondition: string;
  predictionFalsification: string;
  predictionReviewDate: string | null;
  verdict: string;
};

export type RunMetaInput = {
  threads: Array<{
    id: number;
    title: string;
    state: string | null;
    verdict: string | null;
    countries: string[];
    actors: string[];
    domains: string[];
    tensionLevel: number | null;
  }>;
  links: Array<{
    threadA: number;
    threadB: number;
    linkType: string;
    rationale: string;
    strength: number;
  }>;
};

const META_REQUIRED_KEYS: (keyof MetaAnalysisResult)[] = [
  "systemReading",
  "blocFormation",
  "crossPatterns",
  "contradictions",
  "predictionStatement",
  "predictionCondition",
  "predictionFalsification",
  "verdict",
];

/*
 * isValidReviewDate — Valida que la fecha de revisión sea FUTURA respecto a
 * hoy, entre 30 y 180 días.
 */
function isValidReviewDate(reviewDate: string | undefined, today: Date): boolean {
  if (!reviewDate) return false;
  const d = new Date(reviewDate);
  if (isNaN(d.getTime())) return false;
  const days = Math.floor((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  return days >= 30 && days <= 180;
}

/*
 * callMeta — Llama a MODEL_SMART con el META_PROMPT y parsea el resultado.
 * forceFutureDate: en el reintento, añade un aviso reforzado sobre la fecha.
 */
async function callMeta(input: RunMetaInput, forceFutureDate: boolean): Promise<Record<string, unknown>> {
  const today = new Date();
  const todayStr = today.toLocaleDateString("es-ES", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const systemPrompt = buildMetaSystemPrompt(todayStr);

  let userPrompt = buildMetaPrompt(input);
  if (forceFutureDate) {
    userPrompt += `\n\n⚠️ TU INTENTO ANTERIOR FUE RECHAZADO: la fecha de revisión (predictionReviewDate) NO era futura válida (debía ser posterior a HOY y entre 30 y 180 días). HOY ES ${todayStr}. Recalcula predictionReviewDate como YYYY-MM-DD en el futuro correcto.`;
  }

  const completion = await client.chat.completions.create({
    model: MODEL_SMART,
    reasoning_effort: "high",
    // @ts-expect-error — extra_body no está en los tipos del SDK de OpenAI
    extra_body: { thinking: { type: "enabled" } },
    max_tokens: 12000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek (meta) devolvió respuesta vacía");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const preview = raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
    throw new Error(`DeepSeek (meta) no devolvió JSON válido. Respuesta: ${preview}`);
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const missing = META_REQUIRED_KEYS.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new Error(`DeepSeek (meta) devolvió JSON incompleto. Faltan: ${missing.join(", ")}`);
  }

  return obj;
}

/*
 * runMetaAnalysisLLM — Llama a MODEL_SMART con el META_PROMPT para producir
 * la lectura del tablero global.
 *
 * VALIDACIÓN DE LA PREDICCIÓN: predictionReviewDate debe ser futura (30-180
 * días). Si es inválida, se reintenta UNA vez con aviso reforzado. Si el
 * reintento también falla, se devuelve el resultado con reviewDate null
 * (el llamador lo guarda y lo marca en el log).
 */
export async function runMetaAnalysisLLM(input: RunMetaInput): Promise<MetaAnalysisResult> {
  const today = new Date();

  let obj = await callMeta(input, false);

  let reviewDate: string | null = typeof obj.predictionReviewDate === "string" ? obj.predictionReviewDate : null;
  if (!isValidReviewDate(reviewDate ?? undefined, today)) {
    console.log("   [meta] ⚠️ predictionReviewDate inválida (" + (reviewDate ?? "ausente") + ") — reintentando...");
    obj = await callMeta(input, true);
    reviewDate = typeof obj.predictionReviewDate === "string" ? obj.predictionReviewDate : null;

    if (!isValidReviewDate(reviewDate ?? undefined, today)) {
      console.log("   [meta] ⚠️ El reintento SIGUE con fecha inválida (" + (reviewDate ?? "ausente") + "). Guardando con reviewDate null.");
      reviewDate = null;
    }
  }

  return {
    systemReading: obj.systemReading as string,
    blocFormation: obj.blocFormation as string,
    crossPatterns: obj.crossPatterns as string,
    contradictions: obj.contradictions as string,
    predictionStatement: obj.predictionStatement as string,
    predictionCondition: obj.predictionCondition as string,
    predictionFalsification: obj.predictionFalsification as string,
    predictionReviewDate: reviewDate ?? null,
    verdict: obj.verdict as string,
  };
}
