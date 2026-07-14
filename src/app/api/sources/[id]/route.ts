import { NextRequest, NextResponse } from "next/server";
import { updateSource, deleteSource } from "@/lib/sources";

/*
 * PATCH /api/sources/[id]
 * Actualiza parcialmente una fuente. Solo los campos enviados en el body
 * se modifican; el resto permanece sin cambios.
 *
 * Body aceptado: { name?, rssUrl?, bias?, active? }
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
    const updated = updateSource(idNum, body);

    if (!updated) {
      return NextResponse.json({ error: "Fuente no encontrada" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const status = message.includes("inválido") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/*
 * DELETE /api/sources/[id]
 * Elimina una fuente por id.
 * Responde 404 si el id no existe.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const idNum = Number(id);
    if (isNaN(idNum)) {
      return NextResponse.json({ error: "id debe ser un número" }, { status: 400 });
    }

    const deleted = deleteSource(idNum);

    if (!deleted) {
      return NextResponse.json({ error: "Fuente no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
