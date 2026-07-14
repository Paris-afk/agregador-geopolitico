"use client";

import { useState, useEffect, useCallback } from "react";
import type { Source, BiasValue } from "@/lib/sources-types";
import { VALID_BIAS_VALUES, BIAS_LABELS, BIAS_COLORS } from "@/lib/sources-types";

/*
 * /sources — Gestión completa de fuentes de noticias (CRUD + ingesta).
 *
 * Conexión UI → API (verbos HTTP):
 *   - Cargar lista:     GET    /api/sources         (useEffect al montar)
 *   - Añadir fuente:    POST   /api/sources         (formulario superior)
 *   - Editar fuente:    PATCH  /api/sources/[id]    (botón Save por fila)
 *   - Toggle active:    PATCH  /api/sources/[id]    (checkbox por fila)
 *   - Eliminar fuente:  DELETE /api/sources/[id]    (botón Delete + confirm)
 *   - Ingesta:          POST   /api/ingest           (botón "Actualizar ahora")
 */

type EditingRow = {
  rssUrl: string;
  bias: BiasValue;
};

type IngestResultRow = {
  sourceId: number;
  sourceName: string;
  status: string;
  newArticles: number;
  error?: string;
};

async function fetchSources(): Promise<Source[]> {
  const res = await fetch("/api/sources");
  if (!res.ok) throw new Error("Error al cargar fuentes");
  return res.json();
}

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);

  // Formulario para añadir fuente nueva
  const [newName, setNewName] = useState("");
  const [newRssUrl, setNewRssUrl] = useState("");
  const [newBias, setNewBias] = useState<BiasValue>("other");

  // Edición inline: key = source.id, value = campos en edición
  const [editing, setEditing] = useState<Record<number, EditingRow>>({});

  // Resultados de la ingesta
  const [ingestResults, setIngestResults] = useState<IngestResultRow[] | null>(null);
  const [ingesting, setIngesting] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      setLoading(true);
      setSources(await fetchSources());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  /*
   * POST /api/sources — Crea una fuente nueva y refresca la lista.
   */
  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, rssUrl: newRssUrl, bias: newBias }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error);
      return;
    }
    setNewName("");
    setNewRssUrl("");
    setNewBias("other");
    await loadSources();
  }

  /*
   * PATCH /api/sources/[id] — Guarda los cambios inline (rssUrl, bias)
   * y sale del modo edición para esa fila.
   */
  async function handleSaveEdit(id: number) {
    const row = editing[id];
    if (!row) return;
    const res = await fetch(`/api/sources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rssUrl: row.rssUrl, bias: row.bias }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error);
      return;
    }
    setEditing((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await loadSources();
  }

  /*
   * PATCH /api/sources/[id] — Activa/desactiva una fuente.
   * Se llama desde el onChange del checkbox. Envía solo { active }.
   */
  async function handleToggleActive(id: number, active: boolean) {
    await fetch(`/api/sources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    await loadSources();
  }

  /*
   * DELETE /api/sources/[id] — Elimina una fuente con confirmación.
   */
  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`¿Eliminar "${name}"? Esta acción no se puede deshacer.`)) return;
    await fetch(`/api/sources/${id}`, { method: "DELETE" });
    await loadSources();
  }

  /*
   * POST /api/ingest — Dispara la ingesta de todas las fuentes activas
   * y muestra los resultados (cuántos artículos por fuente, y su status).
   */
  async function handleIngest() {
    setIngesting(true);
    setIngestResults(null);
    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const data = await res.json();
      setIngestResults(data.results ?? []);
      await loadSources();
    } catch (err) {
      alert("Error al ejecutar la ingesta");
    } finally {
      setIngesting(false);
    }
  }

  /*
   * Entra en modo edición para una fila, copiando los valores actuales.
   */
  function startEdit(source: Source) {
    setEditing((prev) => ({
      ...prev,
      [source.id]: { rssUrl: source.rssUrl, bias: source.bias },
    }));
  }

  function cancelEdit(id: number) {
    setEditing((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Fuentes de Noticias</h1>
          <p className="text-sm text-zinc-500">Gestiona las fuentes RSS de tu agregador geopolítico</p>
        </div>
        <button
          onClick={handleIngest}
          disabled={ingesting}
          className="px-4 py-2 bg-zinc-900 text-white text-sm rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          {ingesting ? "Actualizando..." : "Actualizar noticias ahora"}
        </button>
      </header>

      {/* Resultados de la ingesta */}
      {ingestResults && (
        <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4 space-y-2">
          <h2 className="font-semibold text-sm text-zinc-700">Resultado de la ingesta</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ingestResults.map((r) => (
              <div key={r.sourceId} className="flex items-center gap-2 text-sm">
                <StatusBadge status={r.status} />
                <span className="font-medium text-zinc-800">{r.sourceName}</span>
                <span className="text-zinc-500">
                  {r.newArticles > 0
                    ? `+${r.newArticles} artículos`
                    : r.status === "ok"
                      ? "sin novedades"
                      : r.error?.slice(0, 60)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Formulario para añadir fuente */}
      <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end bg-white border border-zinc-200 rounded-lg p-4">
        <label className="flex flex-col gap-1 flex-1 min-w-[160px]">
          <span className="text-xs font-medium text-zinc-500">Nombre</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Ej: Kathimerini"
            required
            className="border border-zinc-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 flex-[2] min-w-[220px]">
          <span className="text-xs font-medium text-zinc-500">URL del RSS</span>
          <input
            type="url"
            value={newRssUrl}
            onChange={(e) => setNewRssUrl(e.target.value)}
            placeholder="https://feeds.feedburner.com/..."
            required
            className="border border-zinc-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 min-w-[140px]">
          <span className="text-xs font-medium text-zinc-500">Perspectiva</span>
          <select
            value={newBias}
            onChange={(e) => setNewBias(e.target.value as BiasValue)}
            className="border border-zinc-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          >
            {VALID_BIAS_VALUES.map((v) => (
              <option key={v} value={v}>{BIAS_LABELS[v]}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="px-5 py-2 bg-zinc-900 text-white text-sm rounded-lg hover:bg-zinc-800 transition-colors"
        >
          + Añadir
        </button>
      </form>

      {/* Tabla de fuentes */}
      {loading ? (
        <p className="text-zinc-500 text-sm">Cargando fuentes...</p>
      ) : sources.length === 0 ? (
        <p className="text-zinc-400 text-sm">No hay fuentes registradas. Añade la primera arriba.</p>
      ) : (
        <div className="overflow-x-auto border border-zinc-200 rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="bg-zinc-50 text-zinc-600 uppercase text-xs">
              <tr>
                <th className="px-4 py-3">Fuente</th>
                <th className="px-4 py-3">Perspectiva</th>
                <th className="px-4 py-3">RSS URL</th>
                <th className="px-4 py-3">Activa</th>
                <th className="px-4 py-3">Último Fetch</th>
                <th className="px-4 py-3 w-[120px]">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sources.map((s) => (
                <tr key={s.id} className="bg-white hover:bg-zinc-50/50 transition-colors">
                  {/* Nombre */}
                  <td className="px-4 py-3 font-medium text-zinc-900">{s.name}</td>

                  {/* Perspectiva con badge de color */}
                  <td className="px-4 py-3">
                    {editing[s.id] ? (
                      <select
                        value={editing[s.id].bias}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], bias: e.target.value as BiasValue },
                          }))
                        }
                        className="border border-zinc-300 rounded px-2 py-1 text-xs bg-white"
                      >
                        {VALID_BIAS_VALUES.map((v) => (
                          <option key={v} value={v}>{BIAS_LABELS[v]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${BIAS_COLORS[s.bias]}`}>
                        {BIAS_LABELS[s.bias]}
                      </span>
                    )}
                  </td>

                  {/* RSS URL (editable) */}
                  <td className="px-4 py-3 max-w-[260px] truncate">
                    {editing[s.id] ? (
                      <input
                        type="url"
                        value={editing[s.id].rssUrl}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], rssUrl: e.target.value },
                          }))
                        }
                        className="border border-zinc-300 rounded px-2 py-1 text-xs w-full"
                      />
                    ) : (
                      <code className="text-xs text-zinc-500">{s.rssUrl}</code>
                    )}
                  </td>

                  {/* Toggle active — PATCH /api/sources/[id] con { active } */}
                  <td className="px-4 py-3">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={s.active}
                        onChange={(e) => handleToggleActive(s.id, e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-zinc-200 peer-focus:ring-2 peer-focus:ring-zinc-900 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-zinc-900" />
                    </label>
                  </td>

                  {/* Último fetch status */}
                  <td className="px-4 py-3">
                    {s.lastFetchStatus ? <StatusBadge status={s.lastFetchStatus} /> : <span className="text-zinc-400 text-xs">—</span>}
                  </td>

                  {/* Acciones: Editar/Guardar + Eliminar */}
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {editing[s.id] ? (
                        <>
                          <button
                            onClick={() => handleSaveEdit(s.id)}
                            className="px-2 py-1 text-xs bg-zinc-900 text-white rounded hover:bg-zinc-800"
                          >
                            Guardar
                          </button>
                          <button
                            onClick={() => cancelEdit(s.id)}
                            className="px-2 py-1 text-xs border border-zinc-300 text-zinc-600 rounded hover:bg-zinc-100"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(s)}
                            className="px-2 py-1 text-xs border border-zinc-300 text-zinc-600 rounded hover:bg-zinc-100"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => handleDelete(s.id, s.name)}
                            className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
                          >
                            Eliminar
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/*
 * Badge visual para el estado de fetch.
 * Los colores comunican semántica: verde=ok, rojo=error, naranja=blocked, gris=empty.
 */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ok: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
    blocked: "bg-amber-100 text-amber-800",
    empty: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? "bg-gray-100 text-gray-500"}`}>
      {status}
    </span>
  );
}
