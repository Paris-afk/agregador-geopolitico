"use client";

import { useState, useEffect, useCallback } from "react";
import { BIAS_LABELS, type BiasValue } from "@/lib/sources-types";

/*
 * /dashboard — Portada del Boletín Geopolítico.
 *
 * Este componente solo LEE de la BD vía GET /api/dashboard y marca análisis
 * como leídos vía PATCH /api/analyses/[id]/read. NO llama a DeepSeek.
 *
 * SCORE DE RELEVANCIA (calculado en el backend):
 *   score = (newArticlesToday × 3)  — actividad reciente
 *         + (perspectivas × 2)      — calidad de triangulación
 *         + (hasDeviation ? 10 : 0) — señal de inteligencia premium
 *         + (!read ? 5 : 0)         — pendiente de revisión
 *
 * Las tarjetas se ordenan por score descendente. La #1 (más caliente)
 * ocupa un layout destacado grande; las siguientes medianas; las frías
 * compactas abajo. Como un periódico: la noticia principal domina la
 * portada, las secundarias la complementan.
 *
 * Por qué el dashboard NO llama a DeepSeek:
 *   El dashboard es un LECTOR de análisis ya cocinados. Los análisis los
 *   produce analyzeAllThreads() (POST /api/analyze), que SÍ llama a
 *   DeepSeek (Pro + thinking). El dashboard solo consulta la BD y formatea
 *   resultados. Separar producción de consumo es buena arquitectura: el
 *   análisis puede tardar minutos, la lectura es instantánea.
 */

// --- Tipos ---

type Thread = { id: number; title: string; description: string | null; state: string | null };

type Analysis = {
  id: number;
  threadId: number | null;
  summary: string;
  cuiBono: string;
  saidVsDone: string;
  deviation: string | null;
  prediction: string | null;
  verdict: string;
  analysisDate: string;
  createdAt: string;
  read: boolean;
};

type Perspective = { bias: string; count: number };

type DashboardRow = {
  thread: Thread;
  latestAnalysis: Analysis;
  perspectiveCoverage: {
    totalArticles: number;
    perspectives: Perspective[];
    isTriangulable: boolean;
  };
  newArticlesToday: number;
};

type DashboardData = {
  rows: DashboardRow[];
  unreadCount: number;
};

// --- Colores de perspectiva (adaptados a tema oscuro) ---

const BIAS_DARK_COLORS: Record<string, string> = {
  greek: "bg-blue-900/40 text-blue-300 border-blue-700",
  turkish: "bg-red-900/40 text-red-300 border-red-700",
  russian: "bg-slate-800 text-slate-300 border-slate-600",
  chinese: "bg-orange-900/40 text-orange-300 border-orange-700",
  european: "bg-indigo-900/40 text-indigo-300 border-indigo-700",
  western_thinktank: "bg-emerald-900/40 text-emerald-300 border-emerald-700",
  other: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

// --- Helpers ---

function hasDeviation(d: string | null): boolean {
  if (!d) return false;
  const lower = d.toLowerCase();
  return !(
    lower.includes("no aplica") ||
    lower.includes("primer análisis") ||
    lower.includes("sin desviaciones") ||
    lower.includes("no hay desviación")
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTimeShort(iso: string) {
  return new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Componente ---

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/dashboard");
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  async function toggleRead(analysisId: number, current: boolean) {
    await fetch(`/api/analyses/${analysisId}/read`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: !current }),
    });
    await loadDashboard();
  }

  function toggleExpand(analysisId: number) {
    setExpanded((prev) => ({ ...prev, [analysisId]: !prev[analysisId] }));
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-400 flex items-center justify-center">
        <p className="text-sm tracking-widest uppercase animate-pulse">Cargando boletín...</p>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-400 flex flex-col items-center justify-center gap-3">
        <p className="text-lg font-serif text-zinc-500">Sin análisis disponibles</p>
        <p className="text-xs text-zinc-600">Ejecuta /api/analyze para generar el primer análisis</p>
      </div>
    );
  }

  const rows = showUnreadOnly ? data.rows.filter((r) => !r.latestAnalysis.read) : data.rows;
  const [featured, ...rest] = rows;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 font-sans">
      {/* Masthead */}
      <header className="border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-8 text-center">
          <h1 className="text-4xl md:text-5xl font-serif font-bold tracking-tight text-white">
            BOLETÍN GEOPOLÍTICO
          </h1>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs text-zinc-500">
            <span>{formatDate(new Date().toISOString())}</span>
            <span className="text-zinc-700">|</span>
            <span>
              {data.unreadCount > 0 ? (
                <span className="text-amber-400">
                  {data.unreadCount} análisis sin leer
                </span>
              ) : (
                "Todo leído"
              )}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-8">
        {/* Filtro de pendientes */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowUnreadOnly(!showUnreadOnly)}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${
              showUnreadOnly
                ? "bg-amber-900/30 border-amber-700 text-amber-300"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {showUnreadOnly ? "Mostrando: NO LEÍDOS" : "Solo no leídos"}
          </button>
          {showUnreadOnly && (
            <span className="text-xs text-zinc-600">{rows.length} pendientes</span>
          )}
        </div>

        {rows.length === 0 ? (
          <p className="text-zinc-500 text-sm">No hay análisis pendientes.</p>
        ) : (
          <>
            {/* Tarjeta destacada (#1 más caliente) */}
            {featured && (
              <FeaturedCard
                row={featured}
                expanded={!!expanded[featured.latestAnalysis.id]}
                onToggleExpand={() => toggleExpand(featured.latestAnalysis.id)}
                onToggleRead={() => toggleRead(featured.latestAnalysis.id, featured.latestAnalysis.read)}
              />
            )}

            {/* Grid de tarjetas secundarias */}
            {rest.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {rest.map((row) => (
                  <CompactCard
                    key={row.latestAnalysis.id}
                    row={row}
                    expanded={!!expanded[row.latestAnalysis.id]}
                    onToggleExpand={() => toggleExpand(row.latestAnalysis.id)}
                    onToggleRead={() => toggleRead(row.latestAnalysis.id, row.latestAnalysis.read)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/*
 * Tarjeta destacada — el teatro más caliente, ocupa ancho completo.
 */
function FeaturedCard({
  row,
  expanded,
  onToggleExpand,
  onToggleRead,
}: {
  row: DashboardRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleRead: () => void;
}) {
  const a = row.latestAnalysis;
  const dev = hasDeviation(a.deviation);

  return (
    <article
      className={`border rounded-lg transition-colors cursor-pointer ${
        a.read ? "border-zinc-800 bg-zinc-900/50" : "border-amber-800/40 bg-amber-950/20"
      }`}
      onClick={onToggleExpand}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
                {row.thread.title}
              </span>
              {!a.read && (
                <span className="w-2 h-2 rounded-full bg-amber-400" title="No leído" />
              )}
            </div>
            <h2 className="text-xl font-serif font-bold text-white leading-tight">
              {a.verdict}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dev && (
              <span className="text-xs px-2 py-1 bg-red-900/40 border border-red-700 text-red-300 rounded font-bold uppercase tracking-wider animate-pulse">
                ⚠ DESVIACIÓN
              </span>
            )}
          </div>
        </div>

        {/* Badges de perspectivas + metadata */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {row.perspectiveCoverage.perspectives.map((p) => (
            <span
              key={p.bias}
              className={`px-2 py-0.5 rounded border text-xs ${BIAS_DARK_COLORS[p.bias] ?? "bg-zinc-800 text-zinc-400 border-zinc-600"}`}
            >
              {BIAS_LABELS[p.bias as BiasValue] ?? p.bias} ({p.count})
            </span>
          ))}
          {row.newArticlesToday > 0 && (
            <span className="text-zinc-400 ml-2">
              +{row.newArticlesToday} hoy
            </span>
          )}
          <span className="text-zinc-600 ml-auto">
            {formatTimeShort(a.analysisDate)}
          </span>
        </div>
      </div>

      {/* Contenido expandido */}
      {expanded && (
        <div
          className="px-6 pb-6 space-y-4 border-t border-zinc-800 pt-4"
          onClick={(e) => e.stopPropagation()}
        >
          <AnalysisBody analysis={a} />

          <div className="flex items-center gap-3 pt-2 border-t border-zinc-800">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleRead();
              }}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                a.read
                  ? "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  : "bg-amber-900/30 border-amber-700 text-amber-300 hover:bg-amber-900/50"
              }`}
            >
              {a.read ? "Marcar no leído" : "Marcar leído"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/*
 * Tarjeta compacta — teatros secundarios, en grid de 2 columnas.
 */
function CompactCard({
  row,
  expanded,
  onToggleExpand,
  onToggleRead,
}: {
  row: DashboardRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleRead: () => void;
}) {
  const a = row.latestAnalysis;
  const dev = hasDeviation(a.deviation);

  return (
    <article
      className={`border rounded-lg transition-colors cursor-pointer ${
        a.read ? "border-zinc-800 bg-zinc-900/30" : "border-amber-800/30 bg-amber-950/10"
      }`}
      onClick={onToggleExpand}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider truncate">
                {row.thread.title}
              </span>
              {!a.read && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
            </div>
            <h3 className="text-sm font-serif font-bold text-white line-clamp-2">
              {a.verdict}
            </h3>
          </div>
          {dev && (
            <span className="text-[10px] px-1.5 py-0.5 bg-red-900/30 border border-red-800 text-red-400 rounded font-bold uppercase shrink-0">
              ⚠
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {row.perspectiveCoverage.perspectives.slice(0, 3).map((p) => (
            <span
              key={p.bias}
              className={`px-1.5 py-0.5 rounded border text-[11px] ${BIAS_DARK_COLORS[p.bias] ?? "bg-zinc-800 text-zinc-400 border-zinc-600"}`}
            >
              {BIAS_LABELS[p.bias as BiasValue] ?? p.bias}
            </span>
          ))}
          {(row.perspectiveCoverage.perspectives.length > 3 || row.newArticlesToday > 0) && (
            <span className="text-zinc-600 ml-1">
              {row.perspectiveCoverage.perspectives.length > 3
                ? `+${row.perspectiveCoverage.perspectives.length - 3}`
                : ""}
              {row.newArticlesToday > 0 ? ` · ${row.newArticlesToday} hoy` : ""}
            </span>
          )}
          <span className="text-zinc-600 ml-auto">{formatTimeShort(a.analysisDate)}</span>
        </div>
      </div>

      {expanded && (
        <div
          className="px-4 pb-4 space-y-3 border-t border-zinc-800 pt-3"
          onClick={(e) => e.stopPropagation()}
        >
          <AnalysisBody analysis={a} />

          <div className="pt-2 border-t border-zinc-800">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleRead();
              }}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                a.read
                  ? "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  : "bg-amber-900/30 border-amber-700 text-amber-300 hover:bg-amber-900/50"
              }`}
            >
              {a.read ? "Marcar no leído" : "Marcar leído"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/*
 * Cuerpo del análisis — secciones formateadas.
 */
function AnalysisBody({ analysis: a }: { analysis: Analysis }) {
  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <Section label="RESUMEN" content={a.summary} />
      <Section label="CUI BONO" content={a.cuiBono} />
      <Section label="LO DICHO vs LO HECHO" content={a.saidVsDone} />
      {a.deviation && (
        <div className="p-3 bg-red-950/30 border border-red-900/50 rounded">
          <p className="text-xs text-red-400 font-bold uppercase tracking-wider mb-1">DESVIACIÓN</p>
          <p className="text-red-200 text-sm">{a.deviation}</p>
        </div>
      )}
      {a.prediction && (
        <div className="p-3 bg-zinc-800/50 border border-zinc-700 rounded">
          <p className="text-xs text-zinc-400 font-bold uppercase tracking-wider mb-1">PREDICCIÓN</p>
          <p className="text-zinc-300 text-sm">{a.prediction}</p>
        </div>
      )}
    </div>
  );
}

function Section({ label, content }: { label: string; content: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider mb-1">{label}</p>
      <p className="text-zinc-300">{content}</p>
    </div>
  );
}
