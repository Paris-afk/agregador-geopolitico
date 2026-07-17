"use client";

import { useState, useEffect, useCallback } from "react";
import { IBM_Plex_Mono, Playfair_Display } from "next/font/google";
import { BIAS_LABELS, type BiasValue } from "@/lib/sources-types";

/*
 * ============================================================================
 * MAPEO DE PLANTILLA A DATOS REALES
 * ============================================================================
 *
 * {{ lead }}           → rows[0] (mayor score = más caliente)
 * {{ lead.section }}   → thread.title
 * {{ lead.verdict }}   → latestAnalysis.verdict (titular)
 * {{ lead.deviation }} → hasDeviation(devi.) ? { mag:"Detectada", note:devi. } : null
 * {{ lead.unread }}    → !latestAnalysis.read
 * {{ lead.read }}      → latestAnalysis.read
 * {{ lead.readOpacity }} → read ? 0.55 : 1
 * {{ lead.badges }}    → perspectiveCoverage.perspectives[] mapeados a {name, color, count, ...}
 * {{ lead.newToday }}  → newArticlesToday
 * {{ lead.time }}      → analysisDate formateado (hora + día)
 * {{ lead.expanded }}  → estado expandido del acordeón
 * {{ lead.onExpand }}  → toggleExpand(id)
 * {{ lead.full }}      → [summary, cuiBono, saidVsDone, prediction] como párrafos
 * {{ lead.expandHint }}→ "▸ Leer análisis" / "▾ Colapsar"
 * {{ rest }}           → rows.slice(1), en grid 2 cols
 * {{ legend }}         → filter chips por perspectiva (con conteo global)
 * {{ activeSource }}   → bias activo en el filtro de perspectiva
 * {{ clearSource }}    → función para limpiar filtro de perspectiva
 * {{ toggleUnread }}   → toggle showUnreadOnly
 * {{ hasRest }}        → rest.length > 0
 * {{ empty }}          → rows filtrados vacíos
 * {{ unreadCount }}    → data.unreadCount
 * {{ dateStr }}        → fecha de hoy en español
 */

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-serif",
});

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

type DashboardData = { rows: DashboardRow[]; unreadCount: number };

// --- Colores por bias (adaptados a tema oscuro oklch) ---

const BIAS_INFO: Record<string, { color: string; bg: string; border: string; label: string }> = {
  greek: {
    color: "oklch(0.65 0.14 240)",
    bg: "oklch(0.42 0.08 240 / .22)",
    border: "oklch(0.45 0.07 240 / .4)",
    label: "Griega",
  },
  turkish: {
    color: "oklch(0.68 0.16 20)",
    bg: "oklch(0.38 0.09 20 / .22)",
    border: "oklch(0.42 0.08 20 / .4)",
    label: "Turca",
  },
  russian: {
    color: "oklch(0.7 0.04 140)",
    bg: "oklch(0.38 0.03 140 / .18)",
    border: "oklch(0.4 0.03 140 / .35)",
    label: "Rusa",
  },
  chinese: {
    color: "oklch(0.72 0.12 55)",
    bg: "oklch(0.38 0.06 48 / .22)",
    border: "oklch(0.42 0.06 48 / .4)",
    label: "China",
  },
  european: {
    color: "oklch(0.68 0.1 265)",
    bg: "oklch(0.36 0.06 265 / .2)",
    border: "oklch(0.4 0.05 265 / .38)",
    label: "Europea",
  },
  western_thinktank: {
    color: "oklch(0.66 0.1 160)",
    bg: "oklch(0.35 0.05 160 / .2)",
    border: "oklch(0.38 0.05 160 / .38)",
    label: "Think Tank Occ.",
  },
  other: {
    color: "oklch(0.6 0.01 82)",
    bg: "oklch(0.3 0.005 82 / .15)",
    border: "oklch(0.35 0.005 82 / .3)",
    label: "Otra",
  },
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

function formatDateEs(iso: string) {
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

function todayEs() {
  return new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// --- Componente Principal ---

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [activeSource, setActiveSource] = useState<BiasValue | null>(null);

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

  function toggleExpand(id: number) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "oklch(0.148 0.006 74)" }} className="flex items-center justify-center">
        <p className={`${ibmPlexMono.className} text-xs tracking-[.18em] uppercase`} style={{ color: "oklch(0.55 0.01 82)" }}>
          Cargando briefing...
        </p>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div style={{ minHeight: "100vh", background: "oklch(0.148 0.006 74)" }} className="flex flex-col items-center justify-center gap-3">
        <p style={{ color: "oklch(0.5 0.01 82)" }} className={`${playfair.className} text-lg`}>
          Sin análisis disponibles
        </p>
        <p style={{ color: "oklch(0.4 0.01 82)" }} className={`${ibmPlexMono.className} text-xs tracking-[.14em] uppercase`}>
          Ejecuta /api/analyze para generar el primer briefing
        </p>
      </div>
    );
  }

  // Filtrado
  let rows = showUnreadOnly ? data.rows.filter((r) => !r.latestAnalysis.read) : data.rows;
  if (activeSource) {
    rows = rows.filter((r) =>
      r.perspectiveCoverage.perspectives.some((p) => p.bias === activeSource)
    );
  }

  const lead = rows[0];
  const rest = rows.slice(1);
  const hasRest = rest.length > 0;
  const empty = rows.length === 0;

  // Leyenda de fuentes (filtro por perspectiva)
  const allBiases = Object.keys(BIAS_INFO) as BiasValue[];
  const legendItems = allBiases.map((bias) => {
    const total = data.rows
      .filter((r) => r.perspectiveCoverage.perspectives.some((p) => p.bias === bias))
      .reduce((sum, r) => sum + (r.perspectiveCoverage.perspectives.find((p) => p.bias === bias)?.count ?? 0), 0);
    const info = BIAS_INFO[bias];
    return {
      bias,
      name: info.label,
      color: info.color,
      total,
      isActive: activeSource === bias,
    };
  });

  const clearSource = () => setActiveSource(null);

  return (
    <>
      {/* Keyframes para animación de pulso en no leídos */}
      <style>{`
        @keyframes bgPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes indicatorPulse {
          0%, 100% { opacity: 0.9; }
          50% { opacity: 0.25; }
        }
      `}</style>

      <div style={{
        minHeight: "100vh",
        background: "radial-gradient(120% 80% at 50% -10%, oklch(0.185 0.007 78) 0%, oklch(0.148 0.006 74) 55%)",
        fontFamily: `${playfair.style.fontFamily}, Georgia, serif`,
      }}>
        {/* Masthead */}
        <header style={{ maxWidth: 1180, margin: "0 auto", padding: "38px 40px 0" }}>
          <div className={ibmPlexMono.className} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase",
            color: "oklch(0.55 0.01 82)", paddingBottom: 14,
          }}>
            <span>Briefing diario de inteligencia</span>
            <span style={{ letterSpacing: ".14em" }}>Vol. VII · Ed. 194</span>
            <span style={{ color: "oklch(0.65 0.19 26)", display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 6, height: 6, background: "oklch(0.65 0.19 26)", transform: "rotate(45deg)" }}></span>
              Evaluación reservada
            </span>
          </div>

          <div style={{
            borderTop: "2px solid oklch(0.9 0.018 88 / .82)",
            borderBottom: "1px solid oklch(1 0 0 / .1)",
            padding: "24px 0 18px",
            textAlign: "center",
          }}>
            <h1 style={{
              margin: 0, fontWeight: 800, fontSize: 66, letterSpacing: ".005em",
              lineHeight: .94, color: "oklch(0.94 0.02 88)",
            }}>
              BOLETÍN GEOPOLÍTICO
            </h1>
          </div>

          <div className={ibmPlexMono.className} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase",
            color: "oklch(0.58 0.012 82)", paddingTop: 11, paddingBottom: 13,
            borderBottom: "3px double oklch(0.9 0.018 88 / .46)",
          }}>
            <span>{todayEs()}</span>
            <span style={{ letterSpacing: ".24em", color: "oklch(0.5 0.01 82)" }}>
              Lectura estructural · sin concesiones
            </span>
            <span style={{ color: "oklch(0.82 0.12 80)" }}>
              <b style={{ fontWeight: 600 }}>{data.unreadCount}</b> sin leer
            </span>
          </div>
        </header>

        {/* Barra de filtros */}
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "16px 40px 0" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            paddingBottom: 15, borderBottom: "1px solid oklch(1 0 0 / .09)",
          }}>
            {/* Toggle solo no leídos */}
            <button
              onClick={() => setShowUnreadOnly(!showUnreadOnly)}
              className={ibmPlexMono.className}
              style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase",
                border: "none", cursor: "pointer", borderRadius: 3,
                padding: "5px 12px", fontWeight: 500,
                background: showUnreadOnly
                  ? "oklch(0.82 0.12 80 / .12)"
                  : "oklch(1 0 0 / .04)",
                color: showUnreadOnly
                  ? "oklch(0.82 0.12 80)"
                  : "oklch(0.46 0.01 82)",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: "oklch(0.82 0.12 80)", flex: "none",
              }}></span>
              Solo no leídos
            </button>

            <span style={{ width: 1, height: 18, background: "oklch(1 0 0 / .12)" }}></span>

            <span className={ibmPlexMono.className} style={{
              fontSize: 9.5, letterSpacing: ".18em", textTransform: "uppercase",
              color: "oklch(0.46 0.01 82)",
            }}>
              Fuentes
            </span>

            {legendItems.map((item) => (
              <button
                key={item.bias}
                onClick={() => setActiveSource(activeSource === item.bias ? null : item.bias)}
                className={ibmPlexMono.className}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase",
                  border: `1px solid ${item.isActive ? item.color : "oklch(1 0 0 / .08)"}`,
                  background: item.isActive ? `${item.color} / .12` : "transparent",
                  borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                  color: item.isActive ? item.color : "oklch(0.5 0.01 82)",
                  fontWeight: 500,
                }}
              >
                <span style={{
                  width: 8, height: 8, background: item.color,
                  borderRadius: 1, flex: "none",
                }}></span>
                {item.name}
                <span style={{ opacity: .62, fontWeight: 600 }}>{item.total}</span>
              </button>
            ))}

            {activeSource && (
              <button
                onClick={clearSource}
                className={ibmPlexMono.className}
                style={{
                  marginLeft: 2, background: "none", border: "none",
                  cursor: "pointer", fontSize: 10, letterSpacing: ".1em",
                  textTransform: "uppercase", color: "oklch(0.65 0.19 26)",
                  padding: "4px 6px",
                }}
              >
                ✕ quitar filtro
              </button>
            )}
          </div>
        </div>

        {/* Contenido principal */}
        <main style={{ maxWidth: 1180, margin: "0 auto", padding: "0 40px 90px" }}>
          {!empty && lead ? (
            <LeadArticle
              row={lead}
              expanded={!!expanded[lead.latestAnalysis.id]}
              onToggleExpand={() => toggleExpand(lead.latestAnalysis.id)}
              onToggleRead={() => toggleRead(lead.latestAnalysis.id, lead.latestAnalysis.read)}
            />
          ) : (
            <div className={ibmPlexMono.className} style={{
              padding: "70px 0", textAlign: "center", fontSize: 12,
              letterSpacing: ".14em", textTransform: "uppercase",
              color: "oklch(0.48 0.01 82)",
            }}>
              Sin análisis para el filtro activo
            </div>
          )}

          {hasRest && (
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr",
              gap: 1, background: "oklch(1 0 0 / .09)",
              borderBottom: "1px solid oklch(1 0 0 / .09)",
            }}>
              {rest.map((row) => (
                <RestArticle
                  key={row.latestAnalysis.id}
                  row={row}
                  expanded={!!expanded[row.latestAnalysis.id]}
                  onToggleExpand={() => toggleExpand(row.latestAnalysis.id)}
                  onToggleRead={() => toggleRead(row.latestAnalysis.id, row.latestAnalysis.read)}
                />
              ))}
            </div>
          )}

          <footer className={ibmPlexMono.className} style={{
            marginTop: 34, display: "flex", justifyContent: "space-between",
            alignItems: "center", fontSize: 10, letterSpacing: ".14em",
            textTransform: "uppercase", color: "oklch(0.4 0.01 82)",
          }}>
            <span>Fin del briefing</span>
            <span>Fuente única · no redistribuir</span>
          </footer>
        </main>
      </div>
    </>
  );
}

// --- Subcomponentes ---

function LeadArticle({
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
  const read = a.read;
  const unread = !read;

  const fullParagraphs = [
    { label: "RESUMEN", text: a.summary },
    { label: "CUI BONO", text: a.cuiBono },
    { label: "LO DICHO VS LO HECHO", text: a.saidVsDone },
    ...(a.prediction ? [{ label: "PREDICCIÓN", text: a.prediction }] : []),
  ];

  const badges = row.perspectiveCoverage.perspectives.map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { ...info, count: p.count, bias: p.bias };
  });

  return (
    <article
      onClick={onToggleExpand}
      style={{
        cursor: "pointer", padding: "32px 0 30px",
        borderBottom: "1px solid oklch(1 0 0 / .11)",
        position: "relative",
      }}
    >
      {/* Barra roja lateral */}
      <div style={{
        position: "absolute", top: 32, left: -40,
        width: 3, height: 34, background: "oklch(0.65 0.19 26)",
      }}></div>

      <div style={{ opacity: read ? 0.55 : 1 }}>
        {/* Metadata line */}
        <div className={ibmPlexMono.className} style={{
          display: "flex", alignItems: "center", gap: 12,
          fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase",
          color: "oklch(0.56 0.012 82)", marginBottom: 14,
        }}>
          <span style={{ color: "oklch(0.68 0.19 26)", fontWeight: 600 }}>Portada</span>
          <span style={{ width: 14, height: 1, background: "oklch(1 0 0 / .2)" }}></span>
          <span>{row.thread.title}</span>
          {dev && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              color: "oklch(0.68 0.19 26)", letterSpacing: ".14em",
            }}>
              ▲ Desviación
            </span>
          )}
          {unread && (
            <span style={{
              marginLeft: "auto", width: 8, height: 8,
              borderRadius: "50%", background: "oklch(0.82 0.12 80)",
              animation: "bgPulse 2.4s ease-in-out infinite",
            }}></span>
          )}
          {read && (
            <span style={{
              marginLeft: "auto", letterSpacing: ".16em",
              color: "oklch(0.44 0.01 82)",
            }}>Leído</span>
          )}
        </div>

        {/* Titular (veredicto) */}
        <h2 style={{
          margin: 0, fontWeight: 600, fontSize: 31, lineHeight: 1.3,
          letterSpacing: "-.005em", color: "oklch(0.94 0.02 88)",
          maxWidth: "62ch",
        }}>
          {a.verdict}
        </h2>

        {/* Bloque de desviación */}
        {dev && a.deviation && (
          <div style={{
            display: "flex", gap: 16, alignItems: "flex-start", marginTop: 20,
            padding: "13px 18px", background: "oklch(0.65 0.19 26 / .08)",
            borderLeft: "2px solid oklch(0.65 0.19 26)",
          }}>
            <div className={ibmPlexMono.className} style={{
              textTransform: "uppercase", flex: "none", lineHeight: 1.4,
            }}>
              <div style={{
                fontSize: 9.5, letterSpacing: ".16em",
                color: "oklch(0.68 0.19 26)", fontWeight: 600,
              }}>
                Desviación
              </div>
              <div style={{
                fontSize: 15, color: "oklch(0.86 0.06 30)",
                fontWeight: 600, marginTop: 2,
              }}>
                Detectada
              </div>
            </div>
            <p style={{
              margin: 0, fontStyle: "italic", fontSize: 15,
              lineHeight: 1.5, color: "oklch(0.8 0.03 40)",
            }}>
              {a.deviation}
            </p>
          </div>
        )}

        {/* Contenido expandido */}
        {expanded && (
          <div style={{
            marginTop: 22, maxWidth: "70ch",
            borderTop: "1px solid oklch(1 0 0 / .09)",
            paddingTop: 20,
          }}>
            {fullParagraphs.map((p, i) => (
              <div key={i} style={{ marginBottom: 18 }}>
                <p className={ibmPlexMono.className} style={{
                  margin: "0 0 4px", fontSize: 9.5, letterSpacing: ".14em",
                  textTransform: "uppercase", color: "oklch(0.5 0.01 82)",
                  fontWeight: 500,
                }}>
                  {p.label}
                </p>
                <p style={{
                  margin: 0, fontSize: "18.5px", lineHeight: 1.62,
                  color: "oklch(0.78 0.014 84)",
                }}>
                  {p.text}
                </p>
              </div>
            ))}

            {/* Botón marcar leído */}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(); }}
              className={ibmPlexMono.className}
              style={{
                marginTop: 12, fontSize: 10, letterSpacing: ".12em",
                textTransform: "uppercase", cursor: "pointer",
                border: `1px solid ${read ? "oklch(1 0 0 / .12)" : "oklch(0.82 0.12 80 / .35)"}`,
                background: read ? "transparent" : "oklch(0.82 0.12 80 / .08)",
                color: read ? "oklch(0.5 0.01 82)" : "oklch(0.82 0.12 80)",
                borderRadius: 3, padding: "5px 14px",
              }}
            >
              {read ? "Marcar no leído" : "Marcar leído"}
            </button>
          </div>
        )}

        {/* Footer de metadata */}
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "flex-end", gap: 18, marginTop: 20,
        }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {badges.map((b) => (
              <span
                key={b.bias}
                className={ibmPlexMono.className}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "3px 8px", border: `1px solid ${b.border}`,
                  background: b.bg, borderRadius: 2,
                  fontSize: 10, fontWeight: 500, letterSpacing: ".09em",
                  textTransform: "uppercase", color: "oklch(0.86 0.015 88)",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{
                  width: 6, height: 6, background: b.color,
                  borderRadius: 1, flex: "none",
                }}></span>
                {b.label}
                <span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
              </span>
            ))}
            {row.newArticlesToday > 0 && (
              <span
                className={ibmPlexMono.className}
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "3px 8px", borderRadius: 2,
                  fontSize: 10, letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "oklch(0.78 0.1 80)",
                  background: "oklch(0.78 0.1 80 / .1)",
                }}
              >
                +{row.newArticlesToday} hoy
              </span>
            )}
          </div>
          <span className={ibmPlexMono.className} style={{
            fontSize: 11, letterSpacing: ".06em",
            color: "oklch(0.5 0.01 82)", whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 10,
          }}>
            {expanded ? "▾ Colapsar" : "▸ Leer análisis"}
            <span>{formatTimeShort(a.analysisDate)}</span>
          </span>
        </div>
      </div>
    </article>
  );
}

function RestArticle({
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
  const read = a.read;
  const unread = !read;

  const fullParagraphs = [
    { label: "RESUMEN", text: a.summary },
    { label: "CUI BONO", text: a.cuiBono },
    { label: "LO DICHO VS LO HECHO", text: a.saidVsDone },
    ...(a.prediction ? [{ label: "PREDICCIÓN", text: a.prediction }] : []),
  ];

  const badges = row.perspectiveCoverage.perspectives.slice(0, 3).map((p) => {
    const info = BIAS_INFO[p.bias] ?? BIAS_INFO.other;
    return { ...info, count: p.count, bias: p.bias };
  });

  const remainingCount = row.perspectiveCoverage.perspectives.length - 3;

  return (
    <article
      onClick={onToggleExpand}
      style={{
        background: "oklch(0.148 0.006 74)",
        padding: "22px 28px",
        cursor: "pointer",
        transition: "background .2s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "oklch(0.2 0.007 76)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "oklch(0.148 0.006 74)")}
    >
      <div style={{ opacity: read ? 0.55 : 1 }}>
        {/* Metadata line */}
        <div className={ibmPlexMono.className} style={{
          display: "flex", alignItems: "center", gap: 10,
          fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
          color: "oklch(0.55 0.012 82)", marginBottom: 11,
        }}>
          <span style={{
            overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {row.thread.title}
          </span>
          {dev && (
            <span style={{ color: "oklch(0.68 0.19 26)", flex: "none" }}>▲</span>
          )}
          {unread && (
            <span style={{
              marginLeft: "auto", width: 7, height: 7,
              borderRadius: "50%", background: "oklch(0.82 0.12 80)",
              flex: "none", animation: "bgPulse 2.4s ease-in-out infinite",
            }}></span>
          )}
          {read && (
            <span style={{
              marginLeft: "auto", letterSpacing: ".16em",
              color: "oklch(0.42 0.01 82)", flex: "none",
            }}>Leído</span>
          )}
        </div>

        {/* Titular */}
        <h3 style={{
          margin: 0, fontWeight: 600, fontSize: 19, lineHeight: 1.34,
          letterSpacing: "-.003em", color: "oklch(0.92 0.018 88)",
        }}>
          {a.verdict}
        </h3>

        {/* Contenido expandido */}
        {expanded && (
          <div style={{
            marginTop: 15, borderTop: "1px solid oklch(1 0 0 / .09)",
            paddingTop: 14,
          }}>
            {dev && a.deviation && (
              <div style={{
                display: "flex", gap: 12, alignItems: "flex-start",
                marginBottom: 14, padding: "10px 14px",
                background: "oklch(0.65 0.19 26 / .08)",
                borderLeft: "2px solid oklch(0.65 0.19 26)",
              }}>
                <span className={ibmPlexMono.className} style={{
                  fontSize: 9, letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: "oklch(0.68 0.19 26)", fontWeight: 600,
                  flex: "none", whiteSpace: "nowrap",
                }}>
                  Desv. Detectada
                </span>
                <span style={{
                  fontStyle: "italic", fontSize: 13, lineHeight: 1.45,
                  color: "oklch(0.78 0.03 40)",
                }}>
                  {a.deviation}
                </span>
              </div>
            )}
            {fullParagraphs.map((p, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <p className={ibmPlexMono.className} style={{
                  margin: "0 0 2px", fontSize: 9, letterSpacing: ".12em",
                  textTransform: "uppercase", color: "oklch(0.48 0.01 82)",
                  fontWeight: 500,
                }}>
                  {p.label}
                </p>
                <p style={{
                  margin: 0, fontSize: "16.5px", lineHeight: 1.6,
                  color: "oklch(0.76 0.014 84)",
                }}>
                  {p.text}
                </p>
              </div>
            ))}

            {/* Botón marcar leído */}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(); }}
              className={ibmPlexMono.className}
              style={{
                marginTop: 8, fontSize: 9.5, letterSpacing: ".1em",
                textTransform: "uppercase", cursor: "pointer",
                border: `1px solid ${read ? "oklch(1 0 0 / .12)" : "oklch(0.82 0.12 80 / .3)"}`,
                background: read ? "transparent" : "oklch(0.82 0.12 80 / .08)",
                color: read ? "oklch(0.5 0.01 82)" : "oklch(0.82 0.12 80)",
                borderRadius: 3, padding: "4px 12px",
              }}
            >
              {read ? "Marcar no leído" : "Marcar leído"}
            </button>
          </div>
        )}

        {/* Footer de metadata */}
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "flex-end", gap: 12, marginTop: 14,
        }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {badges.map((b) => (
              <span
                key={b.bias}
                className={ibmPlexMono.className}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "2px 7px", border: `1px solid ${b.border}`,
                  background: b.bg, borderRadius: 2,
                  fontSize: 9.5, fontWeight: 500, letterSpacing: ".08em",
                  textTransform: "uppercase", color: "oklch(0.84 0.015 88)",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{
                  width: 5, height: 5, background: b.color,
                  borderRadius: 1, flex: "none",
                }}></span>
                {b.label}
                <span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
              </span>
            ))}
            {remainingCount > 0 && (
              <span className={ibmPlexMono.className} style={{
                display: "inline-flex", alignItems: "center",
                padding: "2px 7px", fontSize: 9.5,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "oklch(0.46 0.01 82)",
                border: "1px solid oklch(1 0 0 / .08)",
                borderRadius: 2,
              }}>
                +{remainingCount}
              </span>
            )}
            {row.newArticlesToday > 0 && (
              <span
                className={ibmPlexMono.className}
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "2px 7px", borderRadius: 2,
                  fontSize: 9.5, letterSpacing: ".07em",
                  textTransform: "uppercase",
                  color: "oklch(0.78 0.1 80)",
                  background: "oklch(0.78 0.1 80 / .1)",
                }}
              >
                +{row.newArticlesToday} hoy
              </span>
            )}
          </div>
          <span className={ibmPlexMono.className} style={{
            fontSize: 10, letterSpacing: ".05em",
            color: "oklch(0.48 0.01 82)", whiteSpace: "nowrap",
          }}>
            {formatTimeShort(a.analysisDate)}
          </span>
        </div>
      </div>
    </article>
  );
}
