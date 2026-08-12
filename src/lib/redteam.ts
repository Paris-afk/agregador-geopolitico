import OpenAI from "openai";
import { REDTEAM_PROMPT, buildRedTeamPrompt } from "./prompts";

/*
 * ============================================================================
 * ABOGADO DEL DIABLO — PASO 3 del ciclo de refutación.
 * ============================================================================
 *
 * Una segunda llamada al modelo (MODEL_SMART) con rol OPUESTO: destruir la
 * predicción. Recibe la predicción, el razonamiento del analista, la
 * verificación factual (cuántas perspectivas corroboran cada hecho) y el
 * contexto. Devuelve el veredicto: 'sostiene' | 'debilita' | 'refuta'.
 */

export type RedTeamVerdict = "sostiene" | "debilita" | "refuta";

export type RedTeamResult = {
  rebuttal: string;
  alternativeHypothesis: string;
  verdict: RedTeamVerdict;
  suggestedRevision: string;
};

export type RedTeamInput = {
  statement: string;
  reasoning: string;
  verification: string;
  context: string;
};

export async function runRedTeam(input: RedTeamInput): Promise<RedTeamResult> {
  const client = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  const MODEL_SMART = process.env.DEEPSEEK_MODEL_SMART ?? "deepseek-v4-pro";

  const userPrompt = buildRedTeamPrompt(input);

  const completion = await client.chat.completions.create({
    model: MODEL_SMART,
    reasoning_effort: "high",
    // @ts-expect-error — extra_body no está en los tipos del SDK de OpenAI
    extra_body: { thinking: { type: "enabled" } },
    max_tokens: 5000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: REDTEAM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek (redteam) devolvió respuesta vacía");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DeepSeek (redteam) no devolvió JSON válido");
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;

  const verdict: RedTeamVerdict =
    obj.verdict === "sostiene" || obj.verdict === "debilita" || obj.verdict === "refuta"
      ? obj.verdict
      : "debilita";

  return {
    rebuttal: typeof obj.rebuttal === "string" ? obj.rebuttal : "",
    alternativeHypothesis: typeof obj.alternativeHypothesis === "string" ? obj.alternativeHypothesis : "",
    verdict,
    suggestedRevision: typeof obj.suggestedRevision === "string" ? obj.suggestedRevision : "",
  };
}
