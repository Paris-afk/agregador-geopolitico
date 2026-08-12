import { db } from "./db/index";
import { predictions, articles, analyses, articleThreads, sources, metaAnalyses, threads } from "./db/schema";
import { eq, and, lte, desc, sql } from "drizzle-orm";
import OpenAI from "openai";
import { PREDICTION_EVALUATOR_PROMPT, buildPredictionEvaluatorPrompt } from "./prompts";
import { isValidReviewDateForStatement } from "./deepseek";

/*
 * ============================================================================
 * SISTEMA DE PREDICCIONES — Cierre del ciclo de falsabilidad.
 * ============================================================================
 *
 * 1. REGISTRO: cuando se guarda un análisis (thread) o meta-análisis con una
 *    predicción válida, se crea una fila en `predictions` con status pending.
 *    Si reviewDate quedó null (falló validación), se registra "unverifiable".
 *
 * 2. EVALUACIÓN: evaluateDuePredictions() toma las pending con reviewDate <=
 *    hoy, reúne la evidencia posterior y llama a MODEL_SMART con
 *    PREDICTION_EVALUATOR_PROMPT.
 *
 * 3. TRACK RECORD: estadísticas por status y por sourceType/thread.
 */

const EVALUATE_LIMIT = 20;

/*
 * registerPrediction — Inserta una predicción en la tabla predictions.
 * Si reviewDate es null o inválida, se registra como "unverifiable".
 */
export function registerPrediction(input: {
  sourceType: "thread" | "meta";
  sourceId: number;
  threadId: number | null;
  statement: string;
  condition: string | null;
  falsification: string | null;
  reviewDate: string | null;
  createdAt: string;
  confidence?: "alta" | "media" | "baja" | null;
  rebuttal?: string | null;
}): void {
  const today = new Date();
  const reviewDate = input.reviewDate ?? null;
  // La fecha debe ser futura, 30-180 días, y nunca anterior a una fecha
  // límite mencionada en el statement.
  const valid = isValidReviewDateForStatement(reviewDate ?? undefined, today, input.statement);

  db.insert(predictions)
    .values({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      threadId: input.threadId,
      statement: input.statement,
      condition: input.condition,
      falsificationCondition: input.falsification,
      reviewDate,
      status: valid ? "pending" : "unverifiable",
      confidence: input.confidence ?? null,
      rebuttal: input.rebuttal ?? null,
      createdAt: input.createdAt,
    })
    .run();
}

/*
 * registerPredictionFromAnalysis — Registra la predicción de un análisis de
 * teatro. Solo si tiene statement + reviewDate.
 */
export function registerPredictionFromAnalysis(input: {
  analysisId: number;
  threadId: number | null;
  statement: string;
  condition: string | null;
  falsification: string | null;
  reviewDate: string | null;
  createdAt: string;
  confidence?: "alta" | "media" | "baja" | null;
  rebuttal?: string | null;
}): void {
  if (!input.statement) return;
  registerPrediction({
    sourceType: "thread",
    sourceId: input.analysisId,
    threadId: input.threadId,
    statement: input.statement,
    condition: input.condition,
    falsification: input.falsification,
    reviewDate: input.reviewDate,
    createdAt: input.createdAt,
    confidence: input.confidence ?? null,
    rebuttal: input.rebuttal ?? null,
  });
}

/*
 * registerPredictionFromMeta — Registra la predicción de un meta-análisis.
 */
export function registerPredictionFromMeta(input: {
  metaId: number;
  threadIds: number[];
  statement: string;
  condition: string | null;
  falsification: string | null;
  reviewDate: string | null;
  createdAt: string;
  confidence?: "alta" | "media" | "baja" | null;
  rebuttal?: string | null;
}): void {
  if (!input.statement) return;
  registerPrediction({
    sourceType: "meta",
    sourceId: input.metaId,
    threadId: null,
    statement: input.statement,
    condition: input.condition,
    falsification: input.falsification,
    reviewDate: input.reviewDate,
    createdAt: input.createdAt,
    confidence: input.confidence ?? null,
    rebuttal: input.rebuttal ?? null,
  });
}

/*
 * getEvidenceForThread — Artículos y análisis posteriores a una fecha para
 * un thread dado (evidencia para evaluar una predicción de teatro).
 * Devuelve el texto y los ids de los artículos usados.
 */
function getEvidenceForThread(threadId: number, after: string, limit = 30): { text: string; articleIds: number[] } {
  const arts = db
    .select({
      id: articles.id,
      title: articles.title,
      fetchedAt: articles.fetchedAt,
      fullText: articles.fullText,
      sourceName: sources.name,
    })
    .from(articleThreads)
    .innerJoin(articles, eq(articleThreads.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(and(eq(articleThreads.threadId, threadId), sql`${articles.fetchedAt} > ${after}`))
    .orderBy(desc(articles.fetchedAt))
    .limit(limit)
    .all();

  const anal = db
    .select({ verdict: analyses.verdict, analysisDate: analyses.analysisDate })
    .from(analyses)
    .where(and(eq(analyses.threadId, threadId), sql`${analyses.createdAt} > ${after}`))
    .orderBy(desc(analyses.analysisDate))
    .limit(10)
    .all();

  const articleLines = arts.map((a) => `- [${a.sourceName}] ${a.title} (${a.fetchedAt})${a.fullText ? " [TEXTO COMPLETO]" : ""}`);
  const analysisLines = anal.map((a) => `- Veredicto de análisis (${a.analysisDate}): ${a.verdict}`);

  const text = `ARTÍCULOS POSTERIORES:
${articleLines.length ? articleLines.join("\n") : "Ninguno."}

ANÁLISIS POSTERIORES:
${analysisLines.length ? analysisLines.join("\n") : "Ninguno."}`;

  return { text, articleIds: arts.map((a) => a.id) };
}

/*
 * getEvidenceForMeta — Evidencia de los threads de un meta-análisis, limitado
 * a los más relevantes.
 */
function getEvidenceForMeta(threadIds: number[], after: string, limit = 20): { text: string; articleIds: number[] } {
  const blocks: string[] = [];
  const allIds: number[] = [];
  for (const tid of threadIds.slice(0, 10)) {
    const block = getEvidenceForThread(tid, after, 5);
    blocks.push(`=== Thread ${tid} ===\n${block.text}`);
    allIds.push(...block.articleIds);
  }
  return { text: blocks.join("\n\n"), articleIds: allIds };
}

/*
 * evaluateDuePredictions — Evalúa las predicciones vencidas (pending con
 * reviewDate <= hoy). Best-effort, con límite por corrida.
 */
export async function evaluateDuePredictions(opts?: { limit?: number }): Promise<{
  evaluated: number;
  confirmed: number;
  falsified: number;
  unverifiable: number;
  failed: number;
}> {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const todayStr = today.toLocaleDateString("es-ES", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const due = db
    .select()
    .from(predictions)
    .where(
      and(
        eq(predictions.status, "pending"),
        lte(predictions.reviewDate, todayISO)
      )
    )
    .limit(opts?.limit ?? EVALUATE_LIMIT)
    .all();

  if (due.length === 0) {
    console.log("   [predicciones] No hay predicciones vencidas por evaluar.");
    return { evaluated: 0, confirmed: 0, falsified: 0, unverifiable: 0, failed: 0 };
  }

  console.log(`\n🎯 EVALUACIÓN DE PREDICCIONES — ${due.length} vencidas\n`);

  const client = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  const MODEL_SMART = process.env.DEEPSEEK_MODEL_SMART ?? "deepseek-v4-pro";

  let confirmed = 0;
  let falsified = 0;
  let unverifiable = 0;
  let failed = 0;

  for (const p of due) {
    console.log(`   [${p.id}] ${p.statement.slice(0, 80)} (revisión ${p.reviewDate})`);

    try {
      const evidenceResult = p.sourceType === "meta"
        ? getEvidenceForMeta((() => {
            const meta = db.select({ threadIds: metaAnalyses.threadIds }).from(metaAnalyses).where(eq(metaAnalyses.id, p.sourceId)).get();
            if (!meta?.threadIds) return [];
            try {
              const arr = JSON.parse(meta.threadIds);
              return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "number") : [];
            } catch {
              return [];
            }
          })(), p.createdAt)
        : getEvidenceForThread(p.threadId ?? 0, p.createdAt);
      const evidence = evidenceResult.text;

      if (!evidence.trim()) {
        console.log(`      ⚠️ Sin evidencia posterior — marcando unverifiable`);
        db.update(predictions)
          .set({ status: "unverifiable", resolvedAt: today.toISOString(), resolution: "Sin evidencia posterior disponible" })
          .where(eq(predictions.id, p.id))
          .run();
        unverifiable++;
        continue;
      }

      const userPrompt = buildPredictionEvaluatorPrompt({
        statement: p.statement,
        condition: p.condition,
        falsificationCondition: p.falsificationCondition,
        reviewDate: p.reviewDate,
        createdAt: p.createdAt,
        today: todayStr,
        evidence,
      });

      const completion = await client.chat.completions.create({
        model: MODEL_SMART,
        reasoning_effort: "high",
        // @ts-expect-error — extra_body no está en los tipos del SDK de OpenAI
        extra_body: { thinking: { type: "enabled" } },
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PREDICTION_EVALUATOR_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) throw new Error("Respuesta vacía");
      const obj = JSON.parse(raw) as { status?: string; resolution?: string };
      const status = obj.status === "confirmed" ? "confirmed" : obj.status === "falsified" ? "falsified" : "unverifiable";

      db.update(predictions)
        .set({
          status,
          resolution: obj.resolution ?? "",
          resolvedAt: today.toISOString(),
          evidenceArticleIds: JSON.stringify(evidenceResult.articleIds),
        })
        .where(eq(predictions.id, p.id))
        .run();

      if (status === "confirmed") confirmed++;
      else if (status === "falsified") falsified++;
      else unverifiable++;

      console.log(`      ${status} — ${obj.resolution?.slice(0, 100)}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      ❌ falló la evaluación: ${msg}`);
    }
  }

  console.log(`\n✅ EVALUACIÓN COMPLETADA — ${confirmed} confirmadas, ${falsified} falsadas, ${unverifiable} inverificables, ${failed} fallidas\n`);
  return { evaluated: due.length, confirmed, falsified, unverifiable, failed };
}

/*
 * getTrackRecord — Estadísticas del track record del analista.
 */
export function getTrackRecord(): {
  total: number;
  pending: number;
  confirmed: number;
  falsified: number;
  unverifiable: number;
  bySourceType: Record<string, { total: number; confirmed: number; falsified: number; unverifiable: number }>;
  byThread: Array<{ threadId: number | null; title: string; total: number; confirmed: number; falsified: number }>;
} {
  const all = db.select().from(predictions).all();

  const confirmed = all.filter((p) => p.status === "confirmed").length;
  const falsified = all.filter((p) => p.status === "falsified").length;
  const unverifiable = all.filter((p) => p.status === "unverifiable").length;
  const pending = all.filter((p) => p.status === "pending").length;

  const bySourceType: Record<string, { total: number; confirmed: number; falsified: number; unverifiable: number }> = {};
  for (const p of all) {
    bySourceType[p.sourceType] = bySourceType[p.sourceType] ?? { total: 0, confirmed: 0, falsified: 0, unverifiable: 0 };
    bySourceType[p.sourceType].total++;
    bySourceType[p.sourceType][p.status as "confirmed" | "falsified" | "unverifiable"]++;
  }

  const threadMap = new Map<number | null, { threadId: number | null; title: string; total: number; confirmed: number; falsified: number }>();
  for (const p of all) {
    if (!p.threadId) continue;
    const entry = threadMap.get(p.threadId) ?? { threadId: p.threadId, title: "", total: 0, confirmed: 0, falsified: 0 };
    entry.total++;
    if (p.status === "confirmed") entry.confirmed++;
    if (p.status === "falsified") entry.falsified++;
    threadMap.set(p.threadId, entry);
  }
  const byThread = [...threadMap.values()].sort((a, b) => b.total - a.total);
  const threadTitles = db.select({ id: threads.id, title: threads.title }).from(threads).all();
  const titleMap = new Map(threadTitles.map((t) => [t.id, t.title]));
  for (const t of byThread) {
    t.title = t.threadId ? (titleMap.get(t.threadId) ?? "") : "";
  }

  return { total: all.length, pending, confirmed, falsified, unverifiable, bySourceType, byThread };
}
