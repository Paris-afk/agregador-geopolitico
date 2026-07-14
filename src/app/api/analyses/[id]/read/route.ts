import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { analyses } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/*
 * PATCH /api/analyses/[id]/read
 *
 * Marca un análisis como leído o no leído.
 * Body: { read: boolean }
 *
 * Responde 404 si el id no existe.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const idNum = Number(id);
    if (isNaN(idNum)) {
      return NextResponse.json({ error: "id debe ser un número" }, { status: 400 });
    }

    const body = await request.json();
    if (typeof body.read !== "boolean") {
      return NextResponse.json({ error: 'read debe ser boolean' }, { status: 400 });
    }

    const result = db
      .update(analyses)
      .set({ read: body.read })
      .where(eq(analyses.id, idNum))
      .run();

    if (result.changes === 0) {
      return NextResponse.json({ error: "Análisis no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
