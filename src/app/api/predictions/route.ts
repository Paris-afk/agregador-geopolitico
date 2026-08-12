import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { predictions, threads } from "@/lib/db/schema";
import { desc, asc, eq, sql } from "drizzle-orm";
import { getTrackRecord } from "@/lib/predictions";

/*
 * GET /api/predictions
 *
 * Devuelve el track record completo del analista:
 *   - dueSoon: pendientes con reviewDate a menos de 7 días
 *   - pending: resto de pendientes, ordenadas por reviewDate asc
 *   - resolved: resueltas (confirmadas/falsadas/inverificables)
 *   - stats: estadísticas globales y por sourceType/thread
 */
export async function GET() {
  const all = db.select().from(predictions).all();
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const in7d = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Título del teatro para cada predicción de teatro
  const titleMap = new Map<number, string>();
  const threadRows = db.select({ id: threads.id, title: threads.title }).from(threads).all();
  for (const t of threadRows) titleMap.set(t.id, t.title);

  const decorate = (p: (typeof all)[number]) => ({
    ...p,
    threadTitle: p.threadId ? (titleMap.get(p.threadId) ?? null) : null,
  });

  const pending = all.filter((p) => p.status === "pending");
  const resolved = all.filter((p) => p.status !== "pending");

  const dueSoon = pending.filter((p) => p.reviewDate && p.reviewDate <= in7d);
  const rest = pending.filter((p) => !p.reviewDate || p.reviewDate > in7d).sort((a, b) => (a.reviewDate ?? "").localeCompare(b.reviewDate ?? ""));

  const stats = getTrackRecord();

  return NextResponse.json({
    dueSoon: dueSoon.map(decorate),
    pending: rest.map(decorate),
    resolved: resolved.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")).map(decorate),
    stats,
    todayISO,
  });
}
